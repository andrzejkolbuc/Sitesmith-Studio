/**
 * Canonical form of a URL for deduplication.
 *
 * Without this the same page is crawled repeatedly under different spellings —
 * with and without a trailing slash, with a tracking parameter, with a fragment
 * — which wastes requests against a site we promised to be gentle with.
 *
 * Query strings are dropped entirely. That is a real tradeoff: a site using
 * `?page=2` for pagination will be under-crawled. It is the right default for
 * marketing sites, where query strings are overwhelmingly tracking noise, and
 * it is the kind of thing to revisit against real crawl data rather than in
 * advance.
 *
 * Lives in its own module rather than in `crawler.ts` because it is the
 * definition of page identity for the whole slice, and the extractors that need
 * it are imported *by* the crawler. Any comparison between a URL the site
 * published and a URL the crawl recorded has to pass both sides through here,
 * or it reports our own normalisation as the client's defect.
 */
export function normaliseUrl(raw: string, base?: string): string | null {
	let url: URL;
	try {
		url = base ? new URL(raw, base) : new URL(raw);
	} catch {
		return null;
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") return null;

	url.hash = "";
	url.search = "";

	// Treat /path and /path/ as the same page, but leave the root alone.
	if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
		url.pathname = url.pathname.slice(0, -1);
	}

	return url.toString();
}
