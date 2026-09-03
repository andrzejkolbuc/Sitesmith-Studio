import { afterEach, describe, expect, it } from "vitest";

import {
	type HostileFixture,
	startHostileSite,
} from "../../../test/fixtures/hostile-site";
import { crawl } from "./crawler";

/**
 * What the crawl does to a site that is already in trouble.
 *
 * The requirement is unusually blunt about the stakes: "causing a client
 * incident is a worse outcome than the regression being hunted". So the question
 * is not whether the crawler finds things, but whether it knows when to stop.
 *
 * `crawler.test.ts` already covers the clean cases — the concurrency ceiling,
 * the inter-request delay, the timeout, and the abort when every request fails.
 * Those are the easy shapes. This file covers the shape that defeats them: a
 * site failing often enough to be struggling and rarely enough that a
 * consecutive-failure counter never fills. A crawl that only stops on a clean
 * burst will happily keep going.
 */

let site: HostileFixture;

afterEach(async () => {
	await site?.close();
});

/** Options every case shares, so each test states only what it is varying. */
const baseOptions = {
	includePaths: [],
	excludePaths: [],
	requestDelayMs: 0,
	maxPages: 200,
	requestTimeoutMs: 2_000,
};

describe("a site that is failing intermittently", () => {
	it("stops rather than continuing against a site failing half its requests", async () => {
		/**
		 * The case the consecutive-failure counter cannot see.
		 *
		 * At one request at a time and a failure every other response, the counter
		 * reaches one, resets, reaches one, resets — forever. The site is returning
		 * a 500 to half of everything it is asked for, which is a site in trouble by
		 * any reading, and the crawl has no reason to believe its own requests are
		 * not part of the reason.
		 */
		site = await startHostileSite({ fanOut: 30, failEvery: 2 });

		const result = await crawl({
			...baseOptions,
			startUrl: `${site.baseUrl}/flapping-hub`,
			maxConcurrency: 1,
		});

		expect(result.abortedReason).toMatch(/fail/i);

		/**
		 * Stopping eventually is not the same as stopping in time. The hub links to
		 * thirty children; a crawl that reads all of them has not protected anyone.
		 */
		expect(result.pages.length).toBeLessThan(31);
	});

	it("says why it stopped, in terms an operator can act on", async () => {
		site = await startHostileSite({ fanOut: 30, failEvery: 2 });

		const result = await crawl({
			...baseOptions,
			startUrl: `${site.baseUrl}/flapping-hub`,
			maxConcurrency: 1,
		});

		/**
		 * An abort with no explanation is indistinguishable from a crash, and the
		 * operator's next move — retry now, or call the client — depends entirely on
		 * knowing which happened.
		 */
		expect(result.abortedReason).toBeTruthy();
		expect(result.abortedReason?.length).toBeGreaterThan(20);
	});

	it("does not stop over a single failure on a small site", async () => {
		/**
		 * The counterweight, and the reason the rate check has a minimum sample: a
		 * rate is meaningless over three requests. One 500 on a small site is a
		 * finding, not grounds for abandoning the run — aborting here would be its
		 * own false positive, and the operator would learn to ignore the reason.
		 */
		site = await startHostileSite({ fanOut: 3, failEvery: 3 });

		const result = await crawl({
			...baseOptions,
			startUrl: `${site.baseUrl}/flapping-hub`,
			maxConcurrency: 1,
		});

		// The failure is real; it is the reaction to it that must stay proportionate.
		expect(site.failuresServed).toBe(1);
		expect(result.abortedReason).toBeNull();
	});

	it("does not stop on a healthy site large enough to be judged", async () => {
		/**
		 * The guard on the guard. Every other case here pushes toward stopping
		 * sooner, and a rate check that fires on a site doing nothing wrong would be
		 * far worse than the problem it solves — the crawl would abandon healthy
		 * clients and the operator would have no way to tell why.
		 *
		 * Thirty-one pages, comfortably past the sample floor, none of them failing.
		 */
		site = await startHostileSite({ fanOut: 30, failEvery: 0, slowMs: 0 });

		const result = await crawl({
			...baseOptions,
			startUrl: `${site.baseUrl}/flapping-hub`,
			maxConcurrency: 2,
		});

		expect(site.failuresServed).toBe(0);
		expect(result.pages).toHaveLength(31);
		expect(result.abortedReason).toBeNull();
	});

	it("does not stop over 404s, which are findings rather than failures", async () => {
		/**
		 * A site full of dead links is exactly what this product exists to report.
		 * Treating "not found" as "struggling" would abort the runs with the most to
		 * say, and the worse the site, the less the operator would learn about it.
		 */
		site = await startHostileSite({ fanOut: 0 });

		const result = await crawl({
			...baseOptions,
			startUrl: `${site.baseUrl}/missing-entirely`,
			maxConcurrency: 1,
		});

		expect(result.abortedReason).toBeNull();
		expect(result.pages[0]?.httpStatus).toBe(404);
	});
});

describe("a site that is slow but never times out", () => {
	it("holds to the concurrency ceiling instead of piling requests up", async () => {
		/**
		 * The failure mode worth naming: when responses are slow, a crawler that
		 * paces by *finishing* rather than by starting ends up with more and more
		 * requests in flight against the site least able to serve them. Slowness is
		 * the site asking for less load, and the ceiling has to hold precisely when
		 * it is inconvenient.
		 */
		site = await startHostileSite({ fanOut: 12, slowMs: 80 });

		await crawl({
			...baseOptions,
			startUrl: `${site.baseUrl}/slow-hub`,
			maxConcurrency: 2,
		});

		expect(site.peakConcurrency).toBeLessThanOrEqual(2);
	});

	it("finishes rather than hanging", async () => {
		site = await startHostileSite({ fanOut: 8, slowMs: 60 });

		const result = await crawl({
			...baseOptions,
			startUrl: `${site.baseUrl}/slow-hub`,
			maxConcurrency: 2,
		});

		// Nine pages: the hub and its eight children, none of them lost.
		expect(result.pages).toHaveLength(9);
		expect(result.abortedReason).toBeNull();
	});
});

describe("a site whose links go in circles", () => {
	it("terminates instead of following the cycle forever", async () => {
		/**
		 * Pagination, calendars and faceted search all produce this shape by
		 * accident. The crawl has to finish on its own rather than on the page
		 * ceiling, because a ceiling reached is a crawl that stopped early and
		 * reported less than it could have.
		 */
		site = await startHostileSite();

		const result = await crawl({
			...baseOptions,
			startUrl: `${site.baseUrl}/loop/a`,
			maxConcurrency: 2,
		});

		expect(result.pages).toHaveLength(2);
		expect(result.reachedPageLimit).toBe(false);
		expect(result.abortedReason).toBeNull();
	});

	it("respects the page ceiling on a site with more pages than the limit", async () => {
		site = await startHostileSite({ fanOut: 40, failEvery: 0, slowMs: 0 });

		const result = await crawl({
			...baseOptions,
			startUrl: `${site.baseUrl}/slow-hub`,
			maxConcurrency: 2,
			maxPages: 5,
		});

		expect(result.reachedPageLimit).toBe(true);

		/**
		 * Workers check the ceiling before fetching, so several in flight can each
		 * pass the check and overshoot by up to one page per worker. Asserted as the
		 * bound it actually holds to rather than as an exact count, since pretending
		 * to an exactness the design does not have would make this test flake.
		 */
		expect(result.pages.length).toBeGreaterThanOrEqual(5);
		expect(result.pages.length).toBeLessThanOrEqual(5 + 2);
	});
});

describe("a failure that might not be one", () => {
	/**
	 * The scar this pass exists to close: a page on a real client site answered
	 * 200 on five consecutive re-fetches while the crawl had recorded it 502 — "a
	 * true observation at crawl time and a false statement about the site".
	 *
	 * Every rule that reads a status inherited that, so the fix belongs in the
	 * crawl rather than in any one of them.
	 */
	it("keeps the second answer when a failure turns out to be transient", async () => {
		site = await startHostileSite({ fanOut: 0, failEvery: 0 });

		const result = await crawl({
			...baseOptions,
			startUrl: `${site.baseUrl}/transient-hub`,
			maxConcurrency: 1,
		});

		const recovered = result.pages.find((page) =>
			page.url.endsWith("/transient/recovers"),
		);

		expect(recovered?.httpStatus).toBe(200);

		const entry = result.reverified.find((r) =>
			r.url.endsWith("/transient/recovers"),
		);
		expect(entry?.first.httpStatus).toBe(503);
		expect(entry?.second.httpStatus).toBe(200);
		expect(entry?.confirmed).toBe(false);
	});

	it("confirms a failure that survives being asked again", async () => {
		site = await startHostileSite({ fanOut: 0, failEvery: 0 });

		const result = await crawl({
			...baseOptions,
			startUrl: `${site.baseUrl}/transient-hub`,
			maxConcurrency: 1,
		});

		const entry = result.reverified.find((r) =>
			r.url.endsWith("/transient/stays-broken"),
		);

		expect(entry?.confirmed).toBe(true);
		expect(entry?.second.httpStatus).toBe(500);
	});

	it("never asks a second time about a 404", async () => {
		/**
		 * A 404 is a stable answer and the thing this product exists to report.
		 * Re-requesting every dead link would double the load on exactly the sites
		 * with the most of them — the opposite of what the pass is for.
		 */
		site = await startHostileSite({ fanOut: 0, failEvery: 0 });

		const result = await crawl({
			...baseOptions,
			startUrl: `${site.baseUrl}/transient-hub`,
			maxConcurrency: 1,
		});

		expect(
			result.reverified.some((r) => r.url.endsWith("/transient/gone")),
		).toBe(false);
		expect(
			site.requests.filter((path) => path === "/transient/gone"),
		).toHaveLength(1);
	});

	it("asks again exactly once per transient failure", async () => {
		site = await startHostileSite({ fanOut: 0, failEvery: 0 });

		await crawl({
			...baseOptions,
			startUrl: `${site.baseUrl}/transient-hub`,
			maxConcurrency: 1,
		});

		expect(
			site.requests.filter((path) => path === "/transient/recovers"),
		).toHaveLength(2);
		expect(
			site.requests.filter((path) => path === "/transient/stays-broken"),
		).toHaveLength(2);
	});

	it("asks nothing again on a crawl that aborted", async () => {
		/**
		 * The abort exists because the site is struggling. A site that made us stop
		 * is the last one to go back to with a second round of requests — and the
		 * pass would be aimed squarely at the pages that failed, which on an
		 * aborting site is most of them.
		 */
		site = await startHostileSite({ fanOut: 30, failEvery: 2 });

		const result = await crawl({
			...baseOptions,
			startUrl: `${site.baseUrl}/flapping-hub`,
			maxConcurrency: 1,
		});

		expect(result.abortedReason).not.toBeNull();
		expect(result.reverified).toEqual([]);
	});
});
