import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type Fixture, startFixtureSite } from "../../../test/fixtures/site";
import { crawl, normaliseUrl } from "./crawler";

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
