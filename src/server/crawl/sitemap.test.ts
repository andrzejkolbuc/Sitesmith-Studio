import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
	decodeSitemapBody,
	parseSitemap,
	reconcile,
	type SitemapEntry,
} from "./sitemap";

/**
 * The sitemap reader, and the comparison pipeline that keeps it honest.
 *
 * Parsing is the easy half. The half that matters is `reconcile`, because every
 * exclusion it makes exists to stop a finding that would describe *us* — our
 * normalisation, our scope, our origin — rather than the client's site. Four
 * false-positive classes are already on record from exactly that mistake, and
 * two of the cases below are those classes in a new setting.
 *
 * Expectations come from the sitemap protocol and from `url.ts`'s stated
 * behaviour, written before the parser was run against them.
 */

const BASE = "https://shop.test";
const SITEMAP_URL = `${BASE}/sitemap.xml`;

const urlset = (...locs: string[]) =>
	`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `  <url><loc>${loc}</loc></url>`).join("\n")}
</urlset>`;

describe("decoding a sitemap body", () => {
	it("returns a plain body unchanged", () => {
		const body = urlset(`${BASE}/`);

		expect(decodeSitemapBody(Buffer.from(body))).toBe(body);
	});

	it("inflates a gzipped body", () => {
		/**
		 * A gzip *file*, not `Content-Encoding: gzip` — `fetch` handles the latter
		 * itself, so anything still compressed by the time it reaches here is a
		 * file the site chose to publish that way.
		 */
		const body = urlset(`${BASE}/compressed`);

		expect(decodeSitemapBody(gzipSync(Buffer.from(body)))).toBe(body);
	});

	it("refuses a body that inflates past the cap", () => {
		/**
		 * A gzip bomb: sixty megabytes of one repeated byte, which compresses to a
		 * few tens of kilobytes on the wire and exceeds the fifty the sitemap
		 * protocol itself allows.
		 *
		 * The cap has to apply *after* decompression, which is the whole reason
		 * this function is separate from the fetch — the compressed size tells you
		 * nothing, and this is the first code in the product to read a file whose
		 * decompressed size the server chooses.
		 */
		const bomb = gzipSync(Buffer.alloc(60 * 1024 * 1024, 0x20));

		expect(bomb.byteLength).toBeLessThan(1024 * 1024);
		expect(decodeSitemapBody(bomb)).toBeNull();
	});

	it("refuses a corrupt body without throwing", () => {
		/**
		 * Gzip magic bytes over something that is not gzip. A sitemap the site
		 * published badly is the site's problem to fix, not a reason for the run to
		 * fail.
		 */
		const corrupt = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x99, 0x99, 0x99]);

		expect(decodeSitemapBody(corrupt)).toBeNull();
	});
});

describe("reading a sitemap document", () => {
	it("reads the URLs a urlset lists", () => {
		const parsed = parseSitemap(
			urlset(`${BASE}/`, `${BASE}/about`),
			SITEMAP_URL,
		);

		expect(parsed.kind).toBe("urlset");
		if (parsed.kind !== "urlset") return;
		expect(parsed.entries.map((e) => e.url)).toEqual([
			`${BASE}/`,
			`${BASE}/about`,
		]);
		expect(parsed.entries[0]?.source).toBe(SITEMAP_URL);
	});

	it("reads a sitemap index as sitemaps, not as pages", () => {
		/**
		 * The root element decides what a `<loc>` means. Read as a urlset, every
		 * child sitemap would be reported as a page the crawl failed to reach.
		 */
		const parsed = parseSitemap(
			`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${BASE}/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>${BASE}/sitemap-posts.xml</loc></sitemap>
</sitemapindex>`,
			SITEMAP_URL,
		);

		expect(parsed.kind).toBe("index");
		if (parsed.kind !== "index") return;
		expect(parsed.children).toEqual([
			`${BASE}/sitemap-pages.xml`,
			`${BASE}/sitemap-posts.xml`,
		]);
	});

	it("decodes the escaping the protocol requires", () => {
		/**
		 * The protocol requires `&` to be published as `&amp;`. Comparing the
		 * escaped form against a URL the crawl recorded would fail on a difference
		 * the site never published.
		 */
		const parsed = parseSitemap(
			urlset(`${BASE}/search?a=1&amp;b=2`),
			SITEMAP_URL,
		);

		if (parsed.kind !== "urlset") return;
		expect(parsed.entries[0]?.raw).toBe(`${BASE}/search?a=1&b=2`);
	});

	it("unwraps a CDATA section", () => {
		const parsed = parseSitemap(
			urlset(`<![CDATA[${BASE}/cdata]]>`),
			SITEMAP_URL,
		);

		if (parsed.kind !== "urlset") return;
		expect(parsed.entries[0]?.url).toBe(`${BASE}/cdata`);
	});

	it("resolves a relative loc against the sitemap, not the site root", () => {
		/**
		 * The protocol requires absolute values, but a site that publishes a
		 * relative one meant it relative to the document it appears in.
		 */
		const parsed = parseSitemap(
			urlset("../about"),
			`${BASE}/sitemaps/pages.xml`,
		);

		if (parsed.kind !== "urlset") return;
		expect(parsed.entries[0]?.url).toBe(`${BASE}/about`);
	});

	it("keeps a loc it cannot turn into a URL, marked as unusable", () => {
		const parsed = parseSitemap(urlset("javascript:void(0)"), SITEMAP_URL);

		if (parsed.kind !== "urlset") return;
		expect(parsed.entries[0]?.raw).toBe("javascript:void(0)");
		expect(parsed.entries[0]?.url).toBeNull();
	});

	it("reads nothing from a document with no locs", () => {
		const parsed = parseSitemap("<urlset></urlset>", SITEMAP_URL);

		if (parsed.kind !== "urlset") return;
		expect(parsed.entries).toEqual([]);
	});
});

describe("lining a sitemap up against the crawl", () => {
	const entry = (raw: string, url: string | null = raw): SitemapEntry => ({
		raw,
		url,
		source: SITEMAP_URL,
	});

	const allInScope = () => true;

	it("collapses locs that differ only by a query string", () => {
		/**
		 * `normaliseUrl` drops the query entirely, so a sitemap listing twenty
		 * paginated URLs names one page as far as the crawl is concerned. Reporting
		 * nineteen of them as missing would be an artifact of our own normalisation
		 * — the failure `lessons.md` exists to prevent, in a new setting.
		 */
		const reconciled = reconcile(
			[
				entry(`${BASE}/list?page=1`, `${BASE}/list`),
				entry(`${BASE}/list?page=2`, `${BASE}/list`),
				entry(`${BASE}/list?page=3`, `${BASE}/list`),
			],
			BASE,
			allInScope,
		);

		expect(reconciled.comparable.size).toBe(1);
		// The raw values survive, so a finding can quote what the site published.
		expect(reconciled.comparable.get(`${BASE}/list`)).toHaveLength(3);
	});

	it("separates entries on another origin instead of comparing them", () => {
		/**
		 * The biggest trap of the lot. A sitemap published on `www.` against a
		 * crawl started at the apex matches nothing at all — so comparing them
		 * would report *every* live page as absent from the sitemap and *every*
		 * sitemap URL as never crawled, on a site where nothing is wrong.
		 */
		const reconciled = reconcile(
			[
				entry(`https://www.shop.test/`),
				entry(`https://www.shop.test/about`),
				entry(`${BASE}/contact`),
			],
			BASE,
			allInScope,
		);

		expect(reconciled.crossOrigin).toHaveLength(2);
		expect(reconciled.comparable.size).toBe(1);
	});

	it("separates entries the crawl was configured not to visit", () => {
		/**
		 * Their absence is the configuration working, not the site failing. The
		 * same guard rules 3 and 13 already carry.
		 */
		const reconciled = reconcile(
			[entry(`${BASE}/public`), entry(`${BASE}/private/secret`)],
			BASE,
			(url) => !url.startsWith(`${BASE}/private`),
		);

		expect(reconciled.outOfScope.map((e) => e.raw)).toEqual([
			`${BASE}/private/secret`,
		]);
		expect(reconciled.comparable.size).toBe(1);
	});

	it("separates a loc that is not a URL at all", () => {
		const reconciled = reconcile(
			[entry("javascript:void(0)", null), entry(`${BASE}/real`)],
			BASE,
			allInScope,
		);

		expect(reconciled.unusable).toHaveLength(1);
		expect(reconciled.comparable.size).toBe(1);
	});

	it("does not case-fold a path", () => {
		/**
		 * `/De/` and `/de/` are different pages by the crawler's own definition of
		 * identity. Folding them here would make this module disagree with
		 * `url.ts`, and the disagreement would surface as a finding.
		 */
		const reconciled = reconcile(
			[entry(`${BASE}/De/about`), entry(`${BASE}/de/about`)],
			BASE,
			allInScope,
		);

		expect(reconciled.comparable.size).toBe(2);
	});

	it("puts nothing in the comparable set for an empty sitemap", () => {
		const reconciled = reconcile([], BASE, allInScope);

		expect(reconciled.comparable.size).toBe(0);
		expect(reconciled.crossOrigin).toEqual([]);
	});
});
