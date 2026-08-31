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
	/**
	 * Proportion of failed requests that aborts the crawl, for a site that fails
	 * steadily rather than in bursts. Applied only once `failureRateSampleSize`
	 * pages have been fetched.
	 */
	failureRateThreshold?: number;
	/** Pages that must be fetched before the failure rate is judged at all. */
	failureRateSampleSize?: number;
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
 * Where "this site is struggling" starts.
 *
 * Set well below half deliberately. Half was the first choice and it was wrong:
 * a site alternating success and failure lands near 48% once the pages that
 * worked are counted, so a threshold at 50% never fires against exactly the
 * site it was written for. Chasing that with 0.49 would be fitting the number to
 * one fixture.
 *
 * A healthy origin serves approximately zero 5xx. By the time a third of what we
 * ask for is erroring, the operator's problem is not hreflang, and our requests
 * have no business being part of it. Only 5xx and network errors count — 404s
 * are findings, and a site full of dead links is what this product is for.
 */
const DEFAULT_FAILURE_RATE = 0.3;
const DEFAULT_FAILURE_RATE_SAMPLE = 20;

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
		failureRateThreshold = DEFAULT_FAILURE_RATE,
		failureRateSampleSize = DEFAULT_FAILURE_RATE_SAMPLE,
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
	/**
	 * URLs the crawl has actually recorded a page for, which is not the same set
	 * as the URLs it has requested: a redirect means the two differ.
	 */
	const recorded = new Set<string>();
	const pages: CrawledPage[] = [];

	let abortedReason: string | null = null;
	let reachedPageLimit = false;
	let consecutiveFailures = 0;
	let totalFailures = 0;
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

			/**
			 * The page is the URL the server served, not the one we asked for.
			 *
			 * Two things follow from getting this wrong, and a real client site
			 * showed both: an alias is recorded as a page of its own, and every
			 * relative href on it resolves against a URL the page does not live at —
			 * inventing links the site never published.
			 *
			 * Falls back to the requested URL when the response carries nothing
			 * usable, which keeps behaviour identical for the overwhelming majority
			 * of pages that never redirect.
			 */
			const served = normaliseUrl(response.url) ?? url;

			return {
				url: served,
				httpStatus: response.status,
				hreflangTargets: extractHreflang(html, served),
				links: extractLinks(html, served),
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

			/**
			 * A second route to a page we already have.
			 *
			 * The `seen` check above stops us *requesting* a URL twice, but it runs
			 * before the fetch, when where a URL leads is not yet knowable. Only the
			 * server can say, so this check has to come after the response.
			 *
			 * Discarded outright: no page, no `onPage`, no links enqueued — they
			 * would be the links of a page already recorded. It counts as neither a
			 * page nor a failure, because it was neither: the request succeeded and
			 * led somewhere already known.
			 */
			if (recorded.has(page.url)) continue;
			recorded.add(page.url);

			pages.push(page);
			await onPage?.(page);

			/**
			 * A run of failures means the site is struggling. Continuing would turn
			 * observing a problem into causing one, so the crawl stops and says why.
			 */
			const failed = page.fetchError !== null || (page.httpStatus ?? 0) >= 500;
			consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
			if (failed) totalFailures += 1;

			if (consecutiveFailures >= failureBurstThreshold) {
				abortedReason = `Aborted after ${consecutiveFailures} consecutive failures — the site appears to be struggling.`;
				return;
			}

			/**
			 * The failure a burst counter cannot see.
			 *
			 * A site that fails every other request never puts two failures in a row,
			 * so the counter above resets forever and the crawl keeps going against a
			 * site returning errors to half of everything it is asked for. That is
			 * precisely the site least able to absorb the load, and continuing turns
			 * observing a problem into contributing to one.
			 *
			 * Judged as a rate, and only once there are enough requests for a rate to
			 * mean anything — over three requests it means nothing, and aborting there
			 * would be its own false positive. Note that 404s are deliberately not
			 * failures: a site full of dead links is what this product exists to
			 * report, and treating that as "struggling" would abandon the runs with
			 * the most to say.
			 */
			if (
				pages.length >= failureRateSampleSize &&
				totalFailures / pages.length >= failureRateThreshold
			) {
				const percent = Math.round((totalFailures / pages.length) * 100);
				abortedReason = `Aborted after ${totalFailures} of ${pages.length} requests failed (${percent}%) — the site appears to be struggling.`;
				return;
			}

			/**
			 * Declared variants are enqueued alongside ordinary links.
			 *
			 * Without this, an hreflang target that nothing links to is never
			 * fetched, and the product cannot distinguish a variant that is broken
			 * from one that merely isn't in the navigation — which is most of what
			 * it exists to tell you. A site declaring `/de/kontakt` is asserting
			 * that page exists; checking the assertion is the job.
			 */
			const candidates = [
				...page.links,
				...Object.values(page.hreflangTargets),
			];

			for (const link of candidates) {
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
