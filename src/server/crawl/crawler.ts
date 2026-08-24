/**
 * The crawler.
 *
 * This is the only code in the product that touches infrastructure someone else
 * owns, so the constraints that protect them live *inside* the fetch loop rather
 * than in whatever calls it. A caller cannot opt out of the concurrency ceiling,
 * the inter-request delay, or the abort-on-failure behaviour by forgetting to
 * wrap something.
 *
 * The requirement it answers is blunt: causing a client incident is a worse
 * outcome than the regression being hunted.
 */

export type CrawlOptions = {
	startUrl: string;
	/** Empty means "anything on the start URL's origin". */
	includePaths: string[];
	/** Always wins over includePaths. */
	excludePaths: string[];
	maxConcurrency: number;
	requestDelayMs: number;
	/** Hard ceiling on pages fetched, so a crawl cannot run away. */
	maxPages: number;
	/** Per-request timeout, so one hanging response cannot stall the run. */
	requestTimeoutMs?: number;
	/** Consecutive failures that abort the crawl. */
	failureBurstThreshold?: number;
	/** Called as each page completes, so callers can persist incrementally. */
	onPage?: (page: CrawledPage) => Promise<void> | void;
};

export type CrawledPage = {
	url: string;
	httpStatus: number | null;
	/** locale → absolute URL, as declared by this page. */
	hreflangTargets: Record<string, string>;
	/** Absolute, in-scope URLs linked from this page. */
	links: string[];
	fetchError: string | null;
};

export type CrawlResult = {
	pages: CrawledPage[];
	/** Set when the crawl stopped early; null when it finished normally. */
	abortedReason: string | null;
	reachedPageLimit: boolean;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FAILURE_BURST = 5;

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

function inScope(
	url: string,
	origin: string,
	includePaths: string[],
	excludePaths: string[],
): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}

	if (parsed.origin !== origin) return false;

	const path = parsed.pathname;
	if (excludePaths.some((prefix) => path.startsWith(prefix))) return false;
	if (includePaths.length === 0) return true;
	return includePaths.some((prefix) => path.startsWith(prefix));
}

/** Extracts hreflang declarations, resolved against the page's own URL. */
function extractHreflang(
	html: string,
	pageUrl: string,
): Record<string, string> {
	const targets: Record<string, string> = {};
	const linkTag = /<link\b[^>]*>/gi;

	for (const [tag] of html.matchAll(linkTag)) {
		if (!/rel\s*=\s*["']?alternate["']?/i.test(tag)) continue;

		const locale = /hreflang\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
		const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
		if (!locale || !href) continue;

		const resolved = normaliseUrl(href, pageUrl);
		if (resolved) targets[locale.toLowerCase()] = resolved;
	}

	return targets;
}

function extractLinks(html: string, pageUrl: string): string[] {
	const found = new Set<string>();
	const anchor = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;

	for (const match of html.matchAll(anchor)) {
		const href = match[1];
		if (!href || href.startsWith("mailto:") || href.startsWith("tel:"))
			continue;
		const resolved = normaliseUrl(href, pageUrl);
		if (resolved) found.add(resolved);
	}

	return [...found];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Breadth-first crawl from `startUrl`, staying in scope.
 *
 * Concurrency is bounded by running a fixed pool of workers over a shared
 * frontier rather than by batching: batching would idle the whole pool waiting
 * for its slowest member, and on a site with one pathological page that turns a
 * short crawl into a long one.
 */
export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
	const {
		includePaths,
		excludePaths,
		maxConcurrency,
		requestDelayMs,
		maxPages,
		requestTimeoutMs = DEFAULT_TIMEOUT_MS,
		failureBurstThreshold = DEFAULT_FAILURE_BURST,
		onPage,
	} = options;

	const start = normaliseUrl(options.startUrl);
	if (!start) {
		return {
			pages: [],
			abortedReason: `Start URL is not a valid http(s) URL: ${options.startUrl}`,
			reachedPageLimit: false,
		};
	}

	const origin = new URL(start).origin;
	const frontier: string[] = [start];
	const seen = new Set<string>([start]);
	const pages: CrawledPage[] = [];

	let abortedReason: string | null = null;
	let reachedPageLimit = false;
	let consecutiveFailures = 0;
	/** Serialises request *starts* so the delay applies across all workers. */
	let nextSlotAt = 0;

	async function claimSlot(): Promise<void> {
		const now = Date.now();
		const slot = Math.max(now, nextSlotAt);
		nextSlotAt = slot + requestDelayMs;
		if (slot > now) await sleep(slot - now);
	}

	async function fetchOne(url: string): Promise<CrawledPage> {
		await claimSlot();

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

		try {
			const response = await fetch(url, {
				signal: controller.signal,
				redirect: "follow",
			});

			const contentType = response.headers.get("content-type") ?? "";
			const html = contentType.includes("html") ? await response.text() : "";

			return {
				url,
				httpStatus: response.status,
				hreflangTargets: extractHreflang(html, url),
				links: extractLinks(html, url),
				fetchError: null,
			};
		} catch (caught) {
			return {
				url,
				httpStatus: null,
				hreflangTargets: {},
				links: [],
				fetchError: caught instanceof Error ? caught.message : String(caught),
			};
		} finally {
			clearTimeout(timer);
		}
	}

	async function worker(): Promise<void> {
		while (abortedReason === null) {
			if (pages.length >= maxPages) {
				reachedPageLimit = true;
				return;
			}

			const next = frontier.shift();
			if (next === undefined) return;

			const page = await fetchOne(next);
			if (abortedReason !== null) return;

			pages.push(page);
			await onPage?.(page);

			/**
			 * A run of failures means the site is struggling. Continuing would turn
			 * observing a problem into causing one, so the crawl stops and says why.
			 */
			const failed = page.fetchError !== null || (page.httpStatus ?? 0) >= 500;
			consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
			if (consecutiveFailures >= failureBurstThreshold) {
				abortedReason = `Aborted after ${consecutiveFailures} consecutive failures — the site appears to be struggling.`;
				return;
			}

			for (const link of page.links) {
				if (seen.has(link)) continue;
				if (!inScope(link, origin, includePaths, excludePaths)) continue;
				seen.add(link);
				frontier.push(link);
			}
		}
	}

	/**
	 * Workers exit when the frontier empties, but a page fetched by one worker can
	 * refill it for the others. Re-run the pool until a full pass adds nothing.
	 */
	while (abortedReason === null && frontier.length > 0 && !reachedPageLimit) {
		const size = Math.max(1, Math.min(maxConcurrency, frontier.length));
		await Promise.all(Array.from({ length: size }, () => worker()));
	}

	return { pages, abortedReason, reachedPageLimit };
}
