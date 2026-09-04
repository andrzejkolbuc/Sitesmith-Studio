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

import { type ContentSummary, emptyContent, extractContent } from "./content";
import { checkExternalLinks, type ExternalSweep } from "./external";
import {
	emptyMetadata,
	extractMetadata,
	MAX_METADATA_CHARS,
	type PageMetadata,
} from "./metadata";
import { parseRobots, type RobotsFile } from "./robots";
import { inScopePath } from "./scope";
import {
	decodeSitemapBody,
	MAX_SITEMAP_DOCUMENTS,
	MAX_SITEMAP_URLS,
	parseSitemap,
	type SitemapDiscovery,
	type SitemapDocument,
	type SitemapEntry,
} from "./sitemap";
import { type CertificateObservation, probeCertificate } from "./tls";
import { normaliseUrl } from "./url";

export { normaliseUrl } from "./url";

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
	/**
	 * Every absolute http(s) URL this page links to, in scope or not.
	 *
	 * Deliberately unfiltered, and the comment here used to say otherwise. Scope
	 * is applied at enqueue time instead, so a link off the origin is captured and
	 * simply never followed — which is what makes it possible to check external
	 * links at all without a second pass over the markup.
	 */
	links: string[];
	/**
	 * What the page's content is, in fixed-size form.
	 *
	 * Fixed-size is the whole constraint: this type is held for every page of a
	 * crawl that can reach two thousand of them, so the summary carries a digest
	 * of the text rather than the text.
	 */
	content: ContentSummary;
	/**
	 * What the page declares about itself to a search engine.
	 *
	 * Fixed-size for the same reason `content` is: title and description are
	 * capped at capture, and the canonical list is deduplicated.
	 */
	metadata: PageMetadata;
	/**
	 * The `X-Robots-Tag` response header, verbatim apart from a length cap.
	 *
	 * The one header kept out of the whole response. `noindex` travels on two
	 * channels and a markup-only check is blind to the one served at the CDN or
	 * framework layer — which is the channel that deindexes a site without
	 * leaving a trace in anybody's page source. Retaining the `Headers` object
	 * instead would multiply an unbounded structure by the two-thousand-page
	 * ceiling, so this is a named string and nothing more.
	 *
	 * Read regardless of content type: a header is the only way to mark a PDF
	 * `noindex`, so skipping non-HTML responses would miss exactly the cases
	 * that have no other channel available.
	 */
	xRobotsTag: string | null;
	/**
	 * The security-relevant response headers, by lowercase name.
	 *
	 * A named, closed set rather than the `Headers` object, for the reason
	 * `xRobotsTag` is a string: retaining an unbounded structure would multiply it
	 * by the two-thousand-page ceiling. Each value is capped the same way.
	 *
	 * An absent header is an absent key, never an empty string. The two are
	 * different claims — one is the site saying nothing, the other is the site
	 * publishing a header with nothing in it — and only the second is a defect.
	 */
	securityHeaders: Record<string, string>;
	/**
	 * The redirects walked to reach this page, in order. Empty for a direct hit.
	 *
	 * Each entry is a request that was actually made, so a chain is visible as
	 * what it is rather than as a status nobody can see.
	 */
	redirectChain: Hop[];
	fetchError: string | null;
};

/** A route that led somewhere other than where it was asked for. */
export type Alias = {
	requested: string;
	served: string;
	/**
	 * The hops walked to get there.
	 *
	 * Carried on the alias rather than left on the page, because the page is
	 * often thrown away: a route ending at a URL the crawl already recorded is
	 * discarded whole. That is the *commonest* shape of a real redirect chain —
	 * an old URL pointing at a new one that the navigation also links — so a rule
	 * reading only surviving pages would miss most of them.
	 */
	chain: Hop[];
};

/** One redirect: where we asked, what it answered, and where it pointed. */
export type Hop = {
	url: string;
	status: number;
	/** Normalised, or null when the `Location` could not be made a URL. */
	location: string | null;
};

/** One observation of a URL's outcome. */
export type Observation = {
	httpStatus: number | null;
	fetchError: string | null;
};

/**
 * A failure that was asked a second time, and what it said.
 *
 * Recorded rather than merely acted on, because "this URL failed twice, minutes
 * apart" is a materially stronger claim than "this URL failed" and a rule that
 * makes the stronger claim should be able to show its working.
 */
export type Reverification = {
	url: string;
	first: Observation;
	second: Observation;
	/** Whether the failure survived the second request. */
	confirmed: boolean;
};

export type CrawlResult = {
	pages: CrawledPage[];
	/** Set when the crawl stopped early; null when it finished normally. */
	abortedReason: string | null;
	reachedPageLimit: boolean;
	/**
	 * Transient-looking failures, re-requested once after the crawl drained.
	 *
	 * Empty when the crawl aborted: a site that made us stop is the last one to
	 * ask again.
	 */
	reverified: Reverification[];
	/**
	 * The certificate the origin presented, or null when there was none to read —
	 * a plain-http origin, or a probe that could not connect.
	 */
	certificate: CertificateObservation | null;
	/**
	 * The site's robots.txt, parsed, or null when there was none to read.
	 *
	 * Read for findings and not obeyed — see the fetch site for why.
	 */
	robots: RobotsFile | null;
	/**
	 * The site's sitemap, followed through any index, or null when none was
	 * found. Null is silence: a guessed path returning 404 says nothing.
	 */
	sitemap: SitemapDocument | null;
	/**
	 * The served URL of the first page recorded — where the crawl entered.
	 *
	 * Recorded explicitly rather than left as `pages[0]`, because a rule reading
	 * it needs the fact and not an assumption about array order. The orphan rule
	 * uses it: an entry page has no inbound link by construction, and reporting
	 * it as unreachable would be a finding about how we started.
	 */
	entryUrl: string | null;
	/**
	 * Every in-scope URL the crawl ever put on its frontier.
	 *
	 * Not the same set as the pages recorded: a URL that redirected is here under
	 * the name it was requested by, and its target is in `pages` under another.
	 * The orphan rule needs precisely this distinction — a URL absent from
	 * here was never linked to by anything, while one present but unrecorded was
	 * reached and led somewhere already known.
	 */
	requested: string[];
	/**
	 * The links leaving the site, checked once each after the crawl drained.
	 *
	 * Empty and incomplete on an aborted crawl. A rule must stay silent about an
	 * incomplete sweep: an unchecked link is not a broken one.
	 */
	external: ExternalSweep;
	/**
	 * Routes that led somewhere other than where they were asked for.
	 *
	 * The evidence a discarded alias would otherwise take with it: the crawl
	 * records the served URL and drops a second route to a page it already has.
	 */
	aliases: Alias[];
};

/**
 * The response headers worth keeping, lowercased.
 *
 * A closed list, following the same discipline the robots vocabulary follows:
 * the set of headers we are willing to say anything about is fixed here, so a
 * rule cannot quietly start judging a header nobody decided to collect.
 */
const SECURITY_HEADERS = [
	"strict-transport-security",
	"content-security-policy",
	"x-frame-options",
	"x-content-type-options",
	"referrer-policy",
	"permissions-policy",
] as const;

/**
 * How many hops a chain may have before it is called runaway.
 *
 * Below the runtime's own twenty, deliberately: more than ten redirects is not
 * a chain anybody intended, and each hop is now a paced request the crawl pays
 * for. The lower cap also halves the worst case of re-verifying a loop.
 */
const MAX_REDIRECT_HOPS = 10;

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

	return inScopePath(parsed.pathname, includePaths, excludePaths);
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

/**
 * A failure that might not be one.
 *
 * The same line the abort counters draw, and drawn once so the two cannot drift:
 * 5xx and network errors are a site having a bad moment, while a 404 is a
 * finding and the thing this product exists to report. Only the first kind is
 * worth asking about twice.
 */
const isTransientFailure = (page: {
	httpStatus: number | null;
	fetchError: string | null;
}): boolean => page.fetchError !== null || (page.httpStatus ?? 0) >= 500;

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
			reverified: [],
			certificate: null,
			robots: null,
			sitemap: null,
			entryUrl: null,
			requested: [],
			external: { checked: [], complete: false },
			aliases: [],
		};
	}

	const origin = new URL(start).origin;

	/**
	 * One handshake, before any page is fetched.
	 *
	 * Per origin rather than per page, so it costs a single connection against a
	 * run that already makes hundreds of requests — which is why it does not go
	 * through the pacer: there is nothing to pace. It runs first so that a run
	 * aborting early still carries the observation.
	 */
	const certificate = await probeCertificate(origin, requestTimeoutMs);

	const frontier: string[] = [start];
	const seen = new Set<string>([start]);

	/**
	 * Named paths are requested, not merely permitted.
	 *
	 * Scope is otherwise a filter on what a crawl *follows*, which means a set of
	 * paths that do not link to one another yields the start URL and nothing else.
	 * That is not hypothetical: a project scoped to `/, /company` fetched a single
	 * page of a client's site, because the site renders its navigation in the
	 * browser and the server-side markup linked neither of them.
	 *
	 * Asking for a path is asking for it to be checked. A seeded URL that turns
	 * out not to exist is recorded as a page that failed, and cannot become a
	 * broken-link finding — nothing linked to it, so it never enters the link
	 * graph those findings are built from.
	 */
	for (const entry of includePaths) {
		const seeded = normaliseUrl(entry, origin);
		if (!seeded) continue;
		if (!inScope(seeded, origin, includePaths, excludePaths)) continue;
		if (seen.has(seeded)) continue;

		seen.add(seeded);
		frontier.push(seeded);
	}
	/**
	 * URLs the crawl has actually recorded a page for, which is not the same set
	 * as the URLs it has requested: a redirect means the two differ.
	 */
	const recorded = new Set<string>();
	const pages: CrawledPage[] = [];

	let abortedReason: string | null = null;
	let reachedPageLimit = false;
	const aliases: Alias[] = [];
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

	/**
	 * Fetches a site-control file, through the same pacer as everything else.
	 *
	 * Separate from `fetchOne` because the result is not a page: it is never
	 * recorded, never counted towards the ceiling, and never counted as a failure.
	 * A site without a robots.txt is not a struggling site.
	 */
	async function fetchText(url: string): Promise<string | null> {
		await claimSlot();

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

		try {
			const response = await fetch(url, {
				signal: controller.signal,
				redirect: "follow",
			});

			if (!response.ok) return null;

			/**
			 * A soft 404 — an HTML "not found" page served with a 200 — is the
			 * commonest way a site answers a request for a file it does not have.
			 * Parsing it would invent groups out of prose, so a response that
			 * announces itself as HTML is treated as absent.
			 */
			const contentType = response.headers.get("content-type") ?? "";
			if (contentType.includes("html")) return null;

			return await response.text();
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * One request, before the crawl proper.
	 *
	 * Read for findings, not obeyed. Honouring robots.txt as a crawl constraint
	 * was declined deliberately in S-01 and stays declined — the operator pointed
	 * this crawl at a site they are authorised to check, and robots.txt addresses
	 * search crawlers rather than an invited audit. FR-018's formulation depends
	 * on that: it compares what the site tells search engines against what the
	 * site's own sitemap submits to them, and it can only see a blocked page
	 * because we went and looked.
	 *
	 * A missing or unreadable robots.txt is null, and null is silence. Absence of
	 * the file is not a defect.
	 */
	const robotsBody = await fetchText(`${origin}/robots.txt`);
	const robots = robotsBody === null ? null : parseRobots(robotsBody);

	/**
	 * A sitemap document, decompressed if it arrived compressed.
	 *
	 * Gzip is detected by the body's own magic bytes rather than by a `.gz`
	 * extension, because the extension is a convention and the bytes are a fact —
	 * and `fetch` transparently handles `Content-Encoding: gzip`, so what arrives
	 * here compressed is a gzip *file* served as an opaque body, whatever it is
	 * called.
	 *
	 * The size cap applies after decompression, where it needs to: a small
	 * compressed body can expand without bound, and this is the first code in the
	 * product to read a file whose decompressed size the server chooses.
	 */
	async function fetchSitemapBody(url: string): Promise<string | null> {
		await claimSlot();

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

		try {
			const response = await fetch(url, {
				signal: controller.signal,
				redirect: "follow",
			});
			if (!response.ok) return null;

			return decodeSitemapBody(Buffer.from(await response.arrayBuffer()));
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * The site's sitemap, followed through any index it declares.
	 *
	 * Discovery order is a provenance decision, not a convenience one. The site's
	 * own `Sitemap:` directive is an assertion about where its sitemap lives;
	 * `/sitemap.xml` is a convention we guess at. So the declaration is preferred,
	 * the guess is the fallback, and which one answered travels with every
	 * finding — because **a 404 at the guessed path is not evidence the site has
	 * no sitemap**, and must never become one.
	 */
	async function readSitemap(): Promise<SitemapDocument | null> {
		const declared = robots?.sitemaps ?? [];
		const discovery: SitemapDiscovery =
			declared.length > 0 ? "robots" : "conventional";

		const queue = (declared.length > 0 ? declared : [`${origin}/sitemap.xml`])
			.map((href) => normaliseUrl(href))
			.filter((href): href is string => href !== null);

		const seenSitemaps = new Set<string>(queue);
		const sources: string[] = [];
		const entries: SitemapEntry[] = [];
		let truncated = false;

		while (queue.length > 0) {
			if (sources.length >= MAX_SITEMAP_DOCUMENTS) {
				truncated = true;
				break;
			}

			const next = queue.shift();
			if (next === undefined) break;

			const body = await fetchSitemapBody(next);
			if (body === null) continue;

			sources.push(next);
			const parsed = parseSitemap(body, next);

			if (parsed.kind === "index") {
				for (const child of parsed.children) {
					if (seenSitemaps.has(child)) continue;
					seenSitemaps.add(child);
					queue.push(child);
				}
				continue;
			}

			for (const entry of parsed.entries) {
				if (entries.length >= MAX_SITEMAP_URLS) {
					truncated = true;
					break;
				}
				entries.push(entry);
			}
		}

		// Nothing answered. The site publishes no sitemap we could find, and that
		// is silence rather than a finding.
		if (sources.length === 0) return null;

		return { discovery, sources, entries, truncated };
	}

	const sitemap = await readSitemap();

	async function fetchOne(url: string): Promise<CrawledPage> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

		/**
		 * Redirects are followed by hand rather than by the runtime.
		 *
		 * `redirect: "follow"` was correct for everything before this slice and
		 * hides the one thing FR-016 asks about: the runtime returns the final
		 * response, so `status` is always the last hop's and no page in any run
		 * could carry a 3xx. A redirect was simply not expressible.
		 *
		 * Walking the hops changes nothing about identity. The page is still the
		 * URL the server finally served, relative hrefs still resolve against it,
		 * and the two dedups still collapse aliases — the hop list is purely
		 * additive. The tests that pin that behaviour were written against a live
		 * client site and must keep passing untouched.
		 *
		 * Each hop is a real request and claims its own slot, which the runtime's
		 * following never did: a chain of five was five unpaced requests before.
		 */
		const redirectChain: Hop[] = [];
		let current = url;

		try {
			let response: Response | null = null;

			for (let hop = 0; ; hop += 1) {
				if (hop > MAX_REDIRECT_HOPS) {
					throw new Error(
						`Too many redirects (more than ${MAX_REDIRECT_HOPS} hops).`,
					);
				}

				await claimSlot();
				const hopResponse = await fetch(current, {
					signal: controller.signal,
					redirect: "manual",
				});

				const location =
					hopResponse.status >= 300 && hopResponse.status < 400
						? hopResponse.headers.get("location")
						: null;

				if (location === null) {
					response = hopResponse;
					break;
				}

				const next = normaliseUrl(location, current);
				redirectChain.push({
					url: current,
					status: hopResponse.status,
					location: next,
				});

				/**
				 * A `Location` we cannot make a URL of ends the walk. The status and
				 * the hop are still recorded, so the chain says where it stopped.
				 */
				if (next === null) {
					response = hopResponse;
					break;
				}

				/**
				 * A loop, detected as a structured outcome rather than left to the
				 * runtime's own hop limit — which surfaced only as an opaque fetch
				 * error and, being a fetch error, counted towards the abort that ends
				 * the whole run.
				 */
				if (next === url || redirectChain.some((entry) => entry.url === next)) {
					throw new Error("Redirect loop.");
				}

				current = next;
			}

			const contentType = response.headers.get("content-type") ?? "";
			const isHtml = contentType.includes("html");
			const html = isHtml ? await response.text() : "";

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
			 *
			 * With the hops walked here rather than by the runtime, this is simply
			 * where the walk stopped — the same URL `redirect: "follow"` used to
			 * report through `response.url`.
			 */
			const served = normaliseUrl(current) ?? url;

			const xRobotsTag = response.headers.get("x-robots-tag");

			/**
			 * Only the names on the closed list, and only the ones actually sent. A
			 * header the site did not publish leaves no key, so a rule can tell
			 * "absent" from "present and empty" — which is the only distinction that
			 * makes a defect out of either.
			 */
			const securityHeaders: Record<string, string> = {};
			for (const name of SECURITY_HEADERS) {
				const value = response.headers.get(name);
				if (value !== null) {
					securityHeaders[name] = value.slice(0, MAX_METADATA_CHARS);
				}
			}

			return {
				url: served,
				httpStatus: response.status,
				hreflangTargets: extractHreflang(html, served),
				links: extractLinks(html, served),
				content: extractContent(html, isHtml),
				metadata: extractMetadata(html, served),
				xRobotsTag: xRobotsTag?.slice(0, MAX_METADATA_CHARS) ?? null,
				redirectChain,
				securityHeaders,
				fetchError: null,
			};
		} catch (caught) {
			return {
				url,
				httpStatus: null,
				hreflangTargets: {},
				links: [],
				content: emptyContent(false),
				metadata: emptyMetadata(),
				xRobotsTag: null,
				redirectChain,
				securityHeaders: {},
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
			 * A route that led somewhere other than where it was asked for.
			 *
			 * Recorded here, before the discard below, because that discard throws
			 * the whole page away — hop list included — and this is the only place
			 * both names are still in hand.
			 *
			 * `page-identity-under-redirects` dropped this deliberately, on the
			 * grounds that recording it "means a column nothing consumes until
			 * S-04". This is S-04: restoring it honours that decision rather than
			 * reversing it. In memory, like the link graph, since no requirement yet
			 * reads it back after a run.
			 */
			if (page.url !== next) {
				aliases.push({
					requested: next,
					served: page.url,
					chain: page.redirectChain,
				});
			}

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
			const failed = isTransientFailure(page);
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

	/**
	 * Failures, asked once more.
	 *
	 * A page on a real client site answered 200 on five consecutive re-fetches
	 * while the crawl had recorded it 502 — a true observation at the moment we
	 * looked, and a false statement about the site. Every rule that reads a status
	 * inherited that, and the rules this slice adds rest on it almost entirely.
	 *
	 * One extra request per transient failure, through the same pacer as
	 * everything else, and only for 5xx and network errors: a 404 does not flap,
	 * and re-asking every dead link would double the requests made against exactly
	 * the sites with the most dead links.
	 *
	 * The second observation replaces the first, because it is the later and
	 * better-evidenced one — and a page that recovered brings its content and
	 * metadata with it, so the rules see the page rather than the bad moment. The
	 * first observation is kept in `reverified` so nothing is lost.
	 *
	 * Skipped entirely on an aborted crawl. The abort exists because the site is
	 * struggling, and a site that made us stop is the last one to ask again.
	 */
	/**
	 * The links that leave the site, checked once each.
	 *
	 * After the crawl drains, because the full external set is only known once
	 * every page has been read — and skipped entirely on an aborted crawl, for the
	 * same reason re-verification is: a run that stopped because a site was
	 * struggling has no business making more requests, least of all to strangers.
	 *
	 * The sweep borrows the pacer rather than keeping one, so the total request
	 * rate against the whole world stays what the operator configured. It is lent
	 * as a closure, not exported: `crawler.ts`'s guarantee is that a caller cannot
	 * opt out of the ceiling, and handing the limiter out of the module would end
	 * that.
	 */
	const external =
		abortedReason === null
			? await checkExternalLinks({
					/**
					 * Off-origin, not merely out of scope — and the difference is load
					 * bearing.
					 *
					 * `inScope` is false for two quite different things: a link to
					 * another site, and a same-origin path the operator excluded.
					 * Sweeping on `!inScope` sent requests into the excluded prefix,
					 * which is the one instruction the operator gave us about their own
					 * site. Caught by the test that exists to protect exactly that.
					 */
					urls: [
						...new Set(
							pages.flatMap((page) =>
								page.links.filter((link) => {
									try {
										return new URL(link).origin !== origin;
									} catch {
										return false;
									}
								}),
							),
						),
					].sort(),
					pacer: { claim: claimSlot },
					requestTimeoutMs,
					perHostDelayMs: requestDelayMs,
					maxRequests: pages.length,
				})
			: { checked: [], complete: false };

	const reverified: Reverification[] = [];

	if (abortedReason === null) {
		for (const [index, page] of pages.entries()) {
			if (!isTransientFailure(page)) continue;

			const second = await fetchOne(page.url);
			const confirmed = isTransientFailure(second);

			reverified.push({
				url: page.url,
				first: { httpStatus: page.httpStatus, fetchError: page.fetchError },
				second: {
					httpStatus: second.httpStatus,
					fetchError: second.fetchError,
				},
				confirmed,
			});

			/**
			 * Keyed on the URL already recorded, not on wherever the retry landed.
			 * The page has a row under this URL and a unique index behind it; a
			 * second request that redirects elsewhere is a different observation than
			 * this pass is equipped to make.
			 */
			pages[index] = { ...second, url: page.url };
		}
	}

	return {
		pages,
		abortedReason,
		reachedPageLimit,
		reverified,
		certificate,
		robots,
		sitemap,
		entryUrl: pages[0]?.url ?? null,
		requested: [...seen],
		external,
		aliases,
	};
}
