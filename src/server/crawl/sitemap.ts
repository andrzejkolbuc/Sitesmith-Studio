import { gunzipSync } from "node:zlib";

import { normaliseUrl } from "./url";

/**
 * Sitemaps, parsed and lined up against what the crawl actually saw.
 *
 * The parsing half is regex over the document rather than a real XML parser,
 * for the reason `metadata.ts` and `content.ts` both give: a DOM would be a
 * dependency, a startup cost, and a second definition of what a document says
 * living beside the extractors already here. A `<loc>` is a coarse enough
 * question that a markup-shaped answer is sufficient.
 *
 * The comparison half is the part that needs care, and it is here rather than
 * in the rules because every trap in it is a URL-identity trap — the class that
 * has already produced four false positives on real client sites. Doing it once,
 * where it can be tested on its own, is the whole point of the module.
 */

export type SitemapEntry = {
	/** The `<loc>` exactly as published, for quoting back as evidence. */
	raw: string;
	/** The same URL in the crawl's identity space, or null if it has none. */
	url: string | null;
	/** Which sitemap document declared it. */
	source: string;
};

export type ParsedSitemap =
	| { kind: "urlset"; entries: SitemapEntry[] }
	| { kind: "index"; children: string[] };

/**
 * How the sitemap was found, which is a provenance question rather than a
 * technical one.
 *
 * `robots` means the site declared it — an assertion. `conventional` means we
 * guessed at `/sitemap.xml` and something answered. Both are usable; only the
 * first is the site telling us where its sitemap is, and a finding says which.
 */
export type SitemapDiscovery = "robots" | "conventional";

export type SitemapDocument = {
	discovery: SitemapDiscovery;
	/** Every sitemap URL actually read, index children included. */
	sources: string[];
	entries: SitemapEntry[];
	/** True when a cap stopped the read before the site ran out of URLs. */
	truncated: boolean;
};

/**
 * Ceilings, taken from the sitemap protocol rather than from taste.
 *
 * The protocol caps a single sitemap at 50,000 URLs and 50MB uncompressed, so
 * those two are the site's own limits reflected back. The document count is
 * ours and needs its own defence: at the protocol's 50,000 URLs per file, fifty
 * documents describe two and a half million URLs — three orders of magnitude
 * beyond the two thousand pages a run will record. A site needing more than
 * this has a different problem than the one we are here to report, and fetching
 * an unbounded index at the crawl's pacing would take hours.
 */
export const MAX_SITEMAP_URLS = 50_000;
export const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;
export const MAX_SITEMAP_DOCUMENTS = 50;

/**
 * A sitemap body as text, decompressing it if it arrived compressed.
 *
 * Gzip is detected by the body's own magic bytes rather than by a `.gz`
 * extension, because the extension is a convention and the bytes are a fact.
 * Note this is a gzip *file* served as an opaque body — `fetch` handles
 * `Content-Encoding: gzip` itself, so anything still compressed at this point is
 * a file the site chose to publish that way.
 *
 * Pure, and separate from the fetch, so the size cap can be tested against a
 * gzip bomb without a server. The cap applies *after* decompression, which is
 * the only place it means anything: a few tens of kilobytes on the wire can
 * inflate without bound, and this is the first code in the product to read a
 * file whose decompressed size the server chooses.
 *
 * Returns null rather than throwing on anything malformed. A sitemap the site
 * published badly is the site's problem to fix, not a reason for the run to
 * fail.
 */
export function decodeSitemapBody(bytes: Buffer): string | null {
	const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;

	if (!gzipped) {
		if (bytes.byteLength > MAX_SITEMAP_BYTES) return null;
		return bytes.toString("utf8");
	}

	try {
		const inflated = gunzipSync(bytes, { maxOutputLength: MAX_SITEMAP_BYTES });
		return inflated.toString("utf8");
	} catch {
		// Corrupt, or larger than the cap allows — both are a refusal, not a crash.
		return null;
	}
}

const NAMED_ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
};

/**
 * Decodes the escaping the sitemap protocol requires of a `<loc>`.
 *
 * Done before normalisation, not after. `&amp;` in a published loc is one
 * character in the URL it stands for, and comparing the escaped form against a
 * URL the crawl recorded would fail on a difference the site never published.
 * A third decoder beside the two in `metadata.ts` and `content.ts` is the price
 * of each one answering for its own document format, which those two already
 * argue for at length.
 */
function decodeEntities(value: string): string {
	return value
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
			String.fromCodePoint(Number.parseInt(hex, 16)),
		)
		.replace(/&#(\d+);/g, (_, digits: string) =>
			String.fromCodePoint(Number.parseInt(digits, 10)),
		)
		.replace(
			/&[a-z]+;/gi,
			(entity) => NAMED_ENTITIES[entity.toLowerCase()] ?? entity,
		);
}

const LOC = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi;

/**
 * Reads one sitemap document.
 *
 * The root element decides what the `<loc>` values mean: inside a
 * `<sitemapindex>` they name further sitemaps, and inside a `<urlset>` they name
 * pages. Reading an index as a urlset would report every child sitemap as a
 * page the crawl failed to reach.
 *
 * `sitemapUrl` is the base a relative `<loc>` resolves against. The protocol
 * requires absolute values, but a site that publishes a relative one meant it
 * relative to the sitemap, not to the site root.
 */
export function parseSitemap(body: string, sitemapUrl: string): ParsedSitemap {
	const isIndex = /<sitemapindex\b/i.test(body);

	const locs: string[] = [];
	for (const match of body.matchAll(LOC)) {
		const value = decodeEntities((match[1] ?? "").trim());
		if (value !== "") locs.push(value);
	}

	if (isIndex) {
		const children: string[] = [];
		for (const loc of locs) {
			const resolved = normaliseUrl(loc, sitemapUrl);
			if (resolved) children.push(resolved);
		}
		return { kind: "index", children: [...new Set(children)] };
	}

	return {
		kind: "urlset",
		entries: locs.map((raw) => ({
			raw,
			url: normaliseUrl(raw, sitemapUrl),
			source: sitemapUrl,
		})),
	};
}

export type Reconciliation = {
	/**
	 * Sitemap URLs comparable against the crawl, keyed by their normalised form.
	 *
	 * Deduplicated *after* normalising, and the raw values kept: a sitemap
	 * listing `?page=1` through `?page=20` collapses to a single URL here,
	 * because the crawl drops query strings. Reporting nineteen of those as
	 * missing would be an artifact of our own normalisation rather than anything
	 * the site got wrong.
	 */
	comparable: Map<string, SitemapEntry[]>;
	/**
	 * Entries on another origin.
	 *
	 * A factual observation, never a per-page defect. A sitemap published on
	 * `www.` against a crawl started at the apex matches nothing at all — so
	 * treating these as failures would report *every* live page as absent from
	 * the sitemap and *every* sitemap URL as never crawled, on a site where
	 * nothing is wrong.
	 */
	crossOrigin: SitemapEntry[];
	/**
	 * Entries the crawl was configured not to visit. Their absence is the
	 * configuration working, which is the guard rules 3 and 13 already carry.
	 */
	outOfScope: SitemapEntry[];
	/** Entries that could not be made into a URL at all. */
	unusable: SitemapEntry[];
};

/**
 * Sorts sitemap entries into the ones a rule may compare and the ones it may not.
 *
 * Every exclusion here exists because including it would produce a finding about
 * us — our normalisation, our scope, our origin — rather than about the site.
 */
export function reconcile(
	entries: SitemapEntry[],
	origin: string,
	inScope: (url: string) => boolean,
): Reconciliation {
	const comparable = new Map<string, SitemapEntry[]>();
	const crossOrigin: SitemapEntry[] = [];
	const outOfScope: SitemapEntry[] = [];
	const unusable: SitemapEntry[] = [];

	for (const entry of entries) {
		if (entry.url === null) {
			unusable.push(entry);
			continue;
		}

		let parsed: URL;
		try {
			parsed = new URL(entry.url);
		} catch {
			unusable.push(entry);
			continue;
		}

		// Origin first: everything below assumes both sides share one.
		if (parsed.origin !== origin) {
			crossOrigin.push(entry);
			continue;
		}

		if (!inScope(entry.url)) {
			outOfScope.push(entry);
			continue;
		}

		comparable.set(entry.url, [...(comparable.get(entry.url) ?? []), entry]);
	}

	return { comparable, crossOrigin, outOfScope, unusable };
}
