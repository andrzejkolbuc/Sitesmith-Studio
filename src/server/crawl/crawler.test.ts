import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type Fixture, startFixtureSite } from "../../../test/fixtures/site";
import { crawl, normaliseUrl } from "./crawler";
import { inScopePath } from "./scope";

let site: Fixture;

beforeAll(async () => {
	site = await startFixtureSite();
});

afterAll(async () => {
	await site.close();
});

beforeEach(() => {
	site.reset();
});

/** The politeness defaults are slow by design; tests use faster ones. */
const base = () => ({
	startUrl: site.baseUrl,
	includePaths: [] as string[],
	excludePaths: ["/private"],
	maxConcurrency: 2,
	requestDelayMs: 0,
	maxPages: 50,
});

describe("normaliseUrl", () => {
	it("collapses spellings of the same page to one form", () => {
		const canonical = normaliseUrl("https://example.test/pricing");

		expect(normaliseUrl("https://example.test/pricing/")).toBe(canonical);
		expect(normaliseUrl("https://example.test/pricing#top")).toBe(canonical);
		expect(normaliseUrl("https://example.test/pricing?utm_source=x")).toBe(
			canonical,
		);
	});

	it("resolves relative hrefs against the page they appeared on", () => {
		expect(normaliseUrl("/de/preise", "https://example.test/pricing")).toBe(
			"https://example.test/de/preise",
		);
	});

	it("rejects non-http schemes and malformed input", () => {
		expect(normaliseUrl("mailto:a@b.test")).toBeNull();
		expect(normaliseUrl("javascript:alert(1)")).toBeNull();
		expect(normaliseUrl("not a url")).toBeNull();
	});

	it("leaves the root path alone", () => {
		expect(normaliseUrl("https://example.test/")).toBe("https://example.test/");
	});
});

describe("crawl scope", () => {
	it("reaches every in-scope page and no out-of-scope page", async () => {
		const result = await crawl(base());
		const paths = result.pages.map((p) => new URL(p.url).pathname);

		expect(paths).toContain("/pricing");
		expect(paths).toContain("/de/preise");
		expect(paths).toContain("/blog/monolingual");
		expect(paths).toContain("/de/blog-post");
		expect(result.abortedReason).toBeNull();
	});

	it("does not fetch excluded paths", async () => {
		await crawl(base());

		expect(site.requests.some((r) => r.startsWith("/private"))).toBe(false);
	});

	it("honours includePaths when set", async () => {
		const result = await crawl({ ...base(), includePaths: ["/de"] });
		const paths = result.pages.map((p) => new URL(p.url).pathname);

		// The start URL is always fetched; everything discovered from it is filtered.
		expect(paths).toContain("/de");
		expect(paths).not.toContain("/pricing");
		expect(paths).not.toContain("/blog/monolingual");
	});

	it("follows an included path into its subtree", async () => {
		/**
		 * The case the segment-aware rule must not break. Naming a section means
		 * the section, so a crawl scoped to `/de` still reaches the German pages
		 * below it — otherwise "only these paths" would be unusable for the thing
		 * people most want it for.
		 */
		const result = await crawl({ ...base(), includePaths: ["/de"] });
		const paths = result.pages.map((p) => new URL(p.url).pathname);

		expect(paths).toContain("/de/preise");
		expect(paths.length).toBeGreaterThan(1);
	});

	it("crawls only the homepage when the root is the include list", async () => {
		/**
		 * The bug this rule was written for, end to end. A project configured with
		 * `/` — meaning the homepage — crawled ninety-two pages of a live client
		 * site in six languages, because every pathname starts with a slash and the
		 * match was a bare `startsWith`.
		 *
		 * Asserted through the real crawl loop rather than against the predicate
		 * alone: the predicate was never the thing anyone doubted, and the property
		 * that matters is how many requests a stranger's server receives.
		 */
		const result = await crawl({ ...base(), includePaths: ["/"] });
		const paths = result.pages.map((p) => new URL(p.url).pathname);

		expect(paths).toEqual(["/"]);

		/**
		 * robots.txt and the sitemaps are exempt and stay exempt: they are what the
		 * site says about itself, not pages of it, and the rules that read them
		 * would go silent if scope could hide them. Everything else the crawler
		 * asked for is a page request, and there should be exactly one.
		 */
		const siteControl = /^\/(robots\.txt|sitemap[\w.-]*\.xml(\.gz)?)$/;
		const pageRequests = site.requests.filter((r) => !siteControl.test(r));

		expect(
			pageRequests.filter((r) => r !== "/" && !r.startsWith("/?")),
		).toEqual([]);
	});

	it("requests an included path nothing in scope links to", async () => {
		/**
		 * Scope filters what a crawl follows, so a set of paths that do not link to
		 * each other used to yield the start URL alone. That is not a hypothetical:
		 * a project scoped to `/, /company` against a client's site fetched one page,
		 * because the site renders its navigation in the browser and the server-side
		 * markup links neither.
		 *
		 * Naming a path is asking for it to be checked, so each entry is requested
		 * directly as well as being a filter on what gets followed.
		 */
		const result = await crawl({
			...base(),
			includePaths: ["/", "/archive/unlinked"],
		});
		const paths = result.pages.map((p) => new URL(p.url).pathname).sort();

		// `/archive/unlinked` is in the fixture's sitemap and linked from nowhere.
		expect(paths).toEqual(["/", "/archive/unlinked"]);
	});

	it("does not invent a broken link out of a seeded path that is missing", async () => {
		/**
		 * The cost of seeding, and the guard on it. An entry naming something that
		 * is not a page gets requested and answers 404 — but nothing linked to it,
		 * so it is a page that failed rather than a link that is broken. Reporting
		 * it as a dead link would be reporting our own configuration as the
		 * client's defect.
		 */
		const result = await crawl({
			...base(),
			includePaths: ["/", "/nothing-here"],
		});
		const missing = result.pages.find(
			(p) => new URL(p.url).pathname === "/nothing-here",
		);

		expect(missing?.httpStatus).toBe(404);
		expect(
			result.pages.some((p) =>
				p.links.includes(`${site.baseUrl}/nothing-here`),
			),
		).toBe(false);
	});

	it("seeds nothing extra when no paths are named", async () => {
		/**
		 * An empty include list means the whole site, and the whole site is reached
		 * by following links from the start URL. Seeding must not change what an
		 * unscoped crawl does.
		 */
		const result = await crawl(base());

		expect(result.pages.length).toBeGreaterThan(3);
		expect(result.abortedReason).toBeNull();
	});

	it("crawls a page once even when linked under several spellings", async () => {
		await crawl(base());

		// The fixture links "/" as itself and as "/?utm_source=nav".
		const rootHits = site.requests.filter(
			(r) => r === "/" || r.startsWith("/?"),
		);
		expect(rootHits).toHaveLength(1);
	});

	it("stops at the page ceiling", async () => {
		const result = await crawl({ ...base(), maxPages: 3 });

		expect(result.pages.length).toBeLessThanOrEqual(3);
		expect(result.reachedPageLimit).toBe(true);
	});
});

describe("hreflang extraction", () => {
	it("records declared alternates as absolute URLs", async () => {
		const result = await crawl(base());
		const pricing = result.pages.find(
			(p) => new URL(p.url).pathname === "/pricing",
		);

		expect(pricing?.hreflangTargets).toEqual({
			en: `${site.baseUrl}/pricing`,
			de: `${site.baseUrl}/de/preise`,
		});
	});

	it("records nothing for a page that declares no alternates", async () => {
		const result = await crawl(base());
		const mono = result.pages.find(
			(p) => new URL(p.url).pathname === "/blog/monolingual",
		);

		expect(mono?.hreflangTargets).toEqual({});
	});
});

/**
 * The requirement these guard is that checking a site must never be capable of
 * degrading it. These are the tests to be most reluctant to weaken.
 */
describe("politeness", () => {
	it("never exceeds the configured concurrency ceiling", async () => {
		await crawl({ ...base(), maxConcurrency: 2 });

		expect(site.peakConcurrency).toBeLessThanOrEqual(2);
	});

	it("serialises entirely at a concurrency of one", async () => {
		await crawl({ ...base(), maxConcurrency: 1 });

		expect(site.peakConcurrency).toBe(1);
	});

	it("leaves a delay between requests", async () => {
		const started = Date.now();
		const result = await crawl({
			...base(),
			maxConcurrency: 1,
			requestDelayMs: 40,
			maxPages: 5,
		});
		const elapsed = Date.now() - started;

		// n requests carry at least (n-1) gaps between them.
		const minimum = (result.pages.length - 1) * 40;
		expect(elapsed).toBeGreaterThanOrEqual(minimum);
	});

	it("aborts rather than continuing to hammer a failing site", async () => {
		// The hub links five always-failing URLs, so a burst can accumulate.
		const result = await crawl({
			...base(),
			startUrl: `${site.baseUrl}/flaky-hub`,
			maxConcurrency: 1,
			failureBurstThreshold: 3,
			maxPages: 50,
		});

		expect(result.abortedReason).toMatch(/consecutive failures/i);
		// Stopped at the threshold rather than working through all five.
		expect(site.requests.filter((r) => r.startsWith("/flaky/")).length).toBe(3);
	});

	it("gives up on a hanging response instead of stalling the run", async () => {
		const result = await crawl({
			...base(),
			startUrl: `${site.baseUrl}/slow`,
			requestTimeoutMs: 100,
			maxPages: 1,
		});

		expect(result.pages[0]?.fetchError).toBeTruthy();
		expect(result.pages[0]?.httpStatus).toBeNull();
	});
});

describe("incremental persistence", () => {
	it("reports each page as it completes", async () => {
		const seen: string[] = [];
		const result = await crawl({
			...base(),
			onPage: (page) => {
				seen.push(page.url);
			},
		});

		expect(seen).toHaveLength(result.pages.length);
	});
});

/**
 * A page is the URL the server served, not the one we asked for.
 *
 * Found on a real client site: `/bg/careers` answers 200 from `/bg/karieri`, and
 * both were recorded as pages. The family swelled to nineteen members and the
 * rules reported four defects that were not there — every one of them naming a
 * page whose hreflang is correct.
 *
 * Every fixture crawl before this landed on the URL it requested, which is why
 * none of it was caught. These cases exist to make that impossible again.
 */
describe("page identity under redirects", () => {
	const path = (url: string) => new URL(url).pathname;

	it("records a redirected page under the URL the server served", async () => {
		const result = await crawl({
			...base(),
			startUrl: `${site.baseUrl}/moved/page`,
		});

		const paths = result.pages.map((p) => path(p.url));
		expect(paths).toContain("/final/page");
		expect(paths).not.toContain("/moved/page");
	});

	it("records one page when the alias is reached first", async () => {
		/**
		 * `/redirect-hub` lists the alias before the canonical URL, so the crawl
		 * records the page, then meets a second route to something it already has.
		 */
		const result = await crawl({
			...base(),
			startUrl: `${site.baseUrl}/redirect-hub`,
		});

		const finals = result.pages.filter((p) => path(p.url) === "/final/page");
		expect(finals).toHaveLength(1);
	});

	it("records one page when the canonical URL is reached first", async () => {
		/**
		 * The other order, which behaves differently and is the one more likely to
		 * be got wrong: the page is already recorded when the alias resolves to it.
		 */
		const result = await crawl({
			...base(),
			startUrl: `${site.baseUrl}/redirect-hub-reversed`,
		});

		const finals = result.pages.filter((p) => path(p.url) === "/final/page");
		expect(finals).toHaveLength(1);
	});

	it("resolves a relative link against the URL the server served", async () => {
		/**
		 * `/final/page` publishes `<a href="sibling">`. Against the URL we asked for
		 * that resolves to `/moved/sibling`, which does not exist; against the URL
		 * we landed on it resolves to `/final/sibling`, which does. A crawl that
		 * gets this wrong reports a dead link the site does not have.
		 */
		const result = await crawl({
			...base(),
			startUrl: `${site.baseUrl}/moved/page`,
		});

		const paths = result.pages.map((p) => path(p.url));
		expect(paths).toContain("/final/sibling");
		expect(paths).not.toContain("/moved/sibling");
	});

	it("does not count a discarded alias as a page or as a failure", async () => {
		/**
		 * An alias produces no page, so it must not advance the page ceiling and
		 * must not look like a failed request — it succeeded; it simply led
		 * somewhere already known.
		 */
		const result = await crawl({
			...base(),
			startUrl: `${site.baseUrl}/redirect-hub`,
		});

		expect(result.abortedReason).toBeNull();
		// Every recorded page is a distinct URL: no alias slipped in as a duplicate.
		const urls = result.pages.map((p) => p.url);
		expect(new Set(urls).size).toBe(urls.length);
	});
});

describe("the politeness guarantee this module exists for", () => {
	it("does not export its request pacer", async () => {
		/**
		 * This module's opening promise is that a caller cannot opt out of the
		 * concurrency ceiling, the inter-request delay, or the abort behaviour by
		 * forgetting to wrap something.
		 *
		 * The external sweep needed the pacer, and the tempting way to share it was
		 * to export it. That would have ended the guarantee: anything importing
		 * `crawler.ts` could then make paced-looking requests outside every abort
		 * counter. It is lent as a closure instead, and this asserts the door stayed
		 * shut — a structural claim no other test would catch.
		 */
		const exported = Object.keys(await import("./crawler")).sort();

		expect(exported).toEqual(["crawl", "normaliseUrl"]);
	});
});

describe("metadata capture", () => {
	const pathOf = (url: string) => new URL(url).pathname;

	async function crawled() {
		const result = await crawl(base());
		return new Map(result.pages.map((page) => [pathOf(page.url), page]));
	}

	it("records what a page declares about itself", async () => {
		const pages = await crawled();
		const complete = pages.get("/meta/complete");

		expect(complete?.metadata.title).toBe(
			"Everything a page should say about itself",
		);
		expect(complete?.metadata.description).toContain("A unique description");
		expect(complete?.metadata.canonicals).toEqual([
			`${site.baseUrl}/meta/complete`,
		]);
		expect(complete?.metadata.robots).toEqual([
			{ crawler: null, directives: ["index", "follow"] },
		]);
	});

	it("records the security headers on the closed list, and only those", async () => {
		/**
		 * The capture, over real HTTP rather than through a hand-built record. The
		 * rules are tested against stated headers; this is the half that proves the
		 * headers arrive at all.
		 *
		 * Reached by pointing the crawl at it directly: the page lives under
		 * `/private/`, so no detection crawl sees it and one page carrying headers
		 * the rest of the fixture lacks cannot make the whole site look
		 * inconsistent.
		 */
		const result = await crawl({
			...base(),
			startUrl: `${site.baseUrl}/private/security-headers`,
			excludePaths: [],
			maxPages: 1,
		});

		const headers = result.pages[0]?.securityHeaders ?? {};

		expect(headers["strict-transport-security"]).toBe(
			"max-age=63072000; includeSubDomains",
		);
		expect(headers["x-content-type-options"]).toBe("nosniff");
		expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");

		/**
		 * An absent header is an absent key, never an empty string. The rules read
		 * that distinction to tell a site saying nothing from a site publishing a
		 * header with nothing in it, and only the second is a defect.
		 */
		expect("content-security-policy" in headers).toBe(false);
		// Nothing outside the closed list is retained, whatever the server sent.
		expect(Object.keys(headers).sort()).toEqual([
			"referrer-policy",
			"strict-transport-security",
			"x-content-type-options",
		]);
	});

	it("fetches and parses the site's robots.txt", async () => {
		/**
		 * The channel, over real HTTP. What the directives *mean* is
		 * `robots.test.ts`'s job — this asserts only that the file arrives and
		 * comes back with its structure intact.
		 */
		const result = await crawl(base());

		expect(result.robots).not.toBeNull();
		expect(result.robots?.groups.map((g) => g.userAgents)).toEqual([
			["*"],
			["googlebot"],
		]);
		expect(result.robots?.sitemaps).toHaveLength(1);
		expect(site.requests.filter((path) => path === "/robots.txt")).toHaveLength(
			1,
		);
	});

	it("follows a sitemap index into its children, plain and gzipped alike", async () => {
		/**
		 * Three things at once, because they only exist together: an index is
		 * followed rather than read as pages, a `.gz` child is inflated, and the
		 * entries from every document land in one set.
		 *
		 * The gzip child is served as a gzip *file* rather than with
		 * `Content-Encoding: gzip` — `fetch` would decompress the latter itself, and
		 * the crawler's own inflation path would never run.
		 */
		const result = await crawl(base());

		expect(result.sitemap).not.toBeNull();
		expect(result.sitemap?.sources).toHaveLength(3);
		expect(result.sitemap?.truncated).toBe(false);

		const listed = (result.sitemap?.entries ?? []).map((entry) => entry.url);
		expect(listed).toContain(`${site.baseUrl}/about`);
		// From the gzipped child, which proves inflation happened.
		expect(listed).toContain(`${site.baseUrl}/blog/monolingual`);
	});

	it("prefers the sitemap robots.txt declares over the conventional path", async () => {
		/**
		 * A provenance decision rather than a technical one. The `Sitemap:` line is
		 * the site telling us where its sitemap is; `/sitemap.xml` is a guess we
		 * make. Both happen to be the same URL in this fixture, so what is asserted
		 * is which channel the crawl recorded having used.
		 */
		const result = await crawl(base());

		expect(result.sitemap?.discovery).toBe("robots");
	});

	it("refuses a corrupt gzipped sitemap without throwing", async () => {
		/**
		 * Gzip magic bytes over a body that is not gzip. A malformed sitemap is the
		 * site's problem to fix, not a reason for the whole run to fail — so the
		 * read returns nothing and the crawl carries on.
		 */
		const result = await crawl({
			...base(),
			startUrl: `${site.baseUrl}/sitemap-corrupt.xml.gz`,
			maxPages: 1,
		});

		expect(result.abortedReason).toBeNull();
	});

	it("crawls exactly the same pages whether or not robots.txt disallows them", async () => {
		/**
		 * The dependency FR-018 rests on, asserted rather than assumed.
		 *
		 * robots.txt is read for findings and deliberately not obeyed — a decision
		 * recorded twice in S-01 and left standing. The rule that reports a blocked
		 * page can only see it because the crawl went and looked, so if obedience
		 * ever arrives this test is where it will surface.
		 *
		 * `/private` is both `Disallow`ed by the fixture's robots.txt and excluded
		 * by configuration here, so the comparison is between a crawl that consults
		 * the file and one whose scope was widened to include the blocked prefix.
		 */
		const respectingScope = await crawl(base());
		const ignoringScope = await crawl({ ...base(), excludePaths: [] });

		const blocked = `${site.baseUrl}/private/secret`;

		expect(respectingScope.pages.some((p) => p.url === blocked)).toBe(false);
		// Widening our own scope reaches it, which robots.txt did nothing to stop.
		expect(ignoringScope.pages.some((p) => p.url === blocked)).toBe(true);
	});

	it("records a page that published no title and no description", async () => {
		const pages = await crawled();
		const bare = pages.get("/meta/bare");

		expect(bare?.metadata.title).toBeNull();
		expect(bare?.metadata.description).toBeNull();
	});

	it("records a directive that travelled only in a response header", async () => {
		/**
		 * The channel a markup-only check is blind to, and the reason the crawler
		 * keeps a header at all. This page's source says nothing about robots; the
		 * only evidence it is deindexed is the header.
		 */
		const pages = await crawled();
		const headerOnly = pages.get("/meta/noindex-header");

		expect(headerOnly?.metadata.robots).toEqual([]);
		expect(headerOnly?.xRobotsTag).toBe("noindex");
	});

	it("records both channels when they disagree", async () => {
		const pages = await crawled();
		const mixed = pages.get("/meta/noindex-mixed");

		expect(mixed?.metadata.robots).toEqual([
			{ crawler: null, directives: ["index", "follow"] },
		]);
		expect(mixed?.xRobotsTag).toBe("noindex");
	});

	it("records no header for a page that served none", async () => {
		const pages = await crawled();

		expect(pages.get("/meta/bare")?.xRobotsTag).toBeNull();
	});
});

describe("redirects, walked rather than followed", () => {
	const path = (url: string) => new URL(url).pathname;

	it("records every hop it walked", async () => {
		/**
		 * The capability the runtime hid. With `redirect: "follow"` the response
		 * carried only the final status, so no page in any run could show a 3xx and
		 * a chain left no trace at all.
		 */
		const result = await crawl({
			...base(),
			startUrl: `${site.baseUrl}/chain/start`,
			maxPages: 1,
		});

		const page = result.pages[0];
		expect(path(page?.url ?? "")).toBe("/final/page");
		expect(page?.redirectChain.map((hop) => path(hop.url))).toEqual([
			"/chain/start",
			"/chain/middle",
			"/chain/end",
		]);
		expect(page?.redirectChain.every((hop) => hop.status === 301)).toBe(true);
	});

	it("records no hops for a page reached directly", async () => {
		const result = await crawl({ ...base(), maxPages: 1 });

		expect(result.pages[0]?.redirectChain).toEqual([]);
	});

	it("stops a loop as a fetch error rather than as an abort", async () => {
		/**
		 * The runtime's own hop limit surfaced a loop as an opaque error, and being
		 * an error it counted towards the failure burst that ends the whole run. A
		 * site with a handful of circular redirects could stop its own crawl.
		 */
		const result = await crawl({
			...base(),
			startUrl: `${site.baseUrl}/circle/one`,
			maxPages: 1,
		});

		expect(result.abortedReason).toBeNull();
		expect(result.pages[0]?.fetchError).toContain("loop");
		expect(result.pages[0]?.redirectChain.length).toBeGreaterThan(0);
	});

	it("paces every hop, not just the first request", async () => {
		/**
		 * Each hop is a real request. The runtime followed them itself, so a chain
		 * of five was five requests the inter-request delay never saw — which is
		 * exactly the guarantee this module exists to make.
		 */
		site.reset();
		await crawl({
			...base(),
			startUrl: `${site.baseUrl}/chain/start`,
			maxPages: 1,
		});

		expect(site.requests).toContain("/chain/start");
		expect(site.requests).toContain("/chain/middle");
		expect(site.requests).toContain("/chain/end");
	});

	it("records the alias a discarded route was asked for", async () => {
		/**
		 * `page-identity-under-redirects` dropped this on the grounds that it was "a
		 * column nothing consumes until S-04". This is S-04, and the discard still
		 * throws the whole page away — hop list included — so the alias has to be
		 * kept where both names are still in hand.
		 */
		const result = await crawl({
			...base(),
			startUrl: `${site.baseUrl}/redirect-hub`,
		});

		expect(
			result.aliases.some(
				(alias) =>
					path(alias.requested) === "/moved/page" &&
					path(alias.served) === "/final/page",
			),
		).toBe(true);
	});
});

/**
 * What "only these paths" actually admits.
 *
 * The rule shipped as a bare `startsWith`, which reads as obviously right and is
 * wrong in two directions at once. A real project was configured with
 * `/, /company` — meaning the homepage and the company page — and crawled
 * ninety-two pages of a live client site in six languages before anyone stopped
 * it, because every pathname starts with `/`.
 *
 * So an include entry now matches a path only when it *is* that path or
 * continues it after a slash. `/` stops meaning the whole site, and `/company`
 * stops meaning `/company-profile`.
 *
 * Exclusion deliberately keeps the broad `startsWith`, and the asymmetry is the
 * point: over-matching an exclusion means not requesting a page, which fails
 * safe against someone else's server, while over-matching an inclusion means
 * requesting all of it.
 */
describe("inScopePath", () => {
	describe("with no include list", () => {
		it("admits anything the exclusions do not name", () => {
			expect(inScopePath("/anything", [], [])).toBe(true);
			expect(inScopePath("/", [], [])).toBe(true);
		});
	});

	describe("include entries match a path or its descendants", () => {
		it("admits the entry itself", () => {
			expect(inScopePath("/company", ["/company"], [])).toBe(true);
		});

		it("admits what continues the entry after a slash", () => {
			expect(inScopePath("/company/about", ["/company"], [])).toBe(true);
			expect(inScopePath("/company/team/leadership", ["/company"], [])).toBe(
				true,
			);
		});

		it("refuses a path that merely starts with the same characters", () => {
			/**
			 * The boundary a bare `startsWith` has none of. `/company-profile` is not
			 * inside `/company`; it is a different page whose name begins the same
			 * way, and a crawl that fetched it would be requesting pages of someone
			 * else's site that nobody asked for.
			 */
			expect(inScopePath("/company-profile", ["/company"], [])).toBe(false);
			expect(inScopePath("/companywide", ["/company"], [])).toBe(false);
			expect(inScopePath("/companies", ["/company"], [])).toBe(false);
		});

		it("refuses a path outside every entry", () => {
			expect(inScopePath("/pricing", ["/company"], [])).toBe(false);
		});
	});

	describe("the root as an include entry", () => {
		it("means the homepage, not the whole site", () => {
			/**
			 * The bug this was found by. Under a bare `startsWith` every path on the
			 * origin begins with `/`, so listing the homepage silently listed
			 * everything — and the second entry the user wrote could not narrow it,
			 * because the first had already admitted the site.
			 */
			expect(inScopePath("/", ["/"], [])).toBe(true);
			expect(inScopePath("/pricing", ["/"], [])).toBe(false);
			expect(inScopePath("/de/preise", ["/"], [])).toBe(false);
		});

		it("narrows to the homepage and one section when listed with it", () => {
			const only = ["/", "/company"];

			expect(inScopePath("/", only, [])).toBe(true);
			expect(inScopePath("/company", only, [])).toBe(true);
			expect(inScopePath("/company/about", only, [])).toBe(true);
			expect(inScopePath("/pricing", only, [])).toBe(false);
			expect(inScopePath("/it/risorse/eventi", only, [])).toBe(false);
		});
	});

	describe("trailing slashes are punctuation, not scope", () => {
		it("reads an entry the same with or without one", () => {
			expect(inScopePath("/company/about", ["/company/"], [])).toBe(true);
			expect(inScopePath("/company-profile", ["/company/"], [])).toBe(false);
		});

		it("reads a path the same with or without one", () => {
			expect(inScopePath("/company/", ["/company"], [])).toBe(true);
		});
	});

	describe("exclusion", () => {
		it("still matches broadly, and the asymmetry is deliberate", () => {
			/**
			 * `/administration` is excluded by `/admin`. That is over-matching, and it
			 * is the safe direction: the cost is a page of someone else's site we do
			 * not fetch. Narrowing this to match inclusion would make a crawl start
			 * requesting paths an operator had already said to stay out of.
			 */
			expect(inScopePath("/administration", [], ["/admin"])).toBe(false);
			expect(inScopePath("/admin/users", [], ["/admin"])).toBe(false);
		});

		it("wins over an include entry that also matches", () => {
			expect(
				inScopePath("/company/secret", ["/company"], ["/company/secret"]),
			).toBe(false);
		});

		it("excludes everything when the root is excluded", () => {
			/**
			 * Consistent with the above rather than special-cased: an operator who
			 * writes `/` in the exclusions has said to fetch nothing, and a crawl that
			 * quietly ignored that would be the unsafe direction.
			 */
			expect(inScopePath("/anything", [], ["/"])).toBe(false);
		});
	});
});
