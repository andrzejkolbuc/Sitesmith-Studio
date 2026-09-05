import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Fixture, startFixtureSite } from "../../../test/fixtures/site";
import { renderSample } from "./render";

/**
 * Longer than vitest's default, because every case here launches a browser and
 * then deliberately waits out the settle window that makes CLS meaningful. The
 * default five seconds is a limit on our patience, not on the thing being
 * measured, and letting it fail the suite would teach us to shorten the settle.
 */
const RENDER_TEST_TIMEOUT_MS = 60_000;

/**
 * The render pass against a real browser and a real server.
 *
 * There is no unit-testable version of this. A console error exists only once
 * something executes the page, and Core Web Vitals are numbers a browser
 * produces about its own painting — stubbing either would leave a test that
 * passes while the thing it describes has never run.
 *
 * Named `*.integration.test.ts` so the integration config collects it: this
 * needs Chromium on the machine, which is exactly the guarantee the unit bucket
 * exists to keep.
 *
 * The load-bearing cases are the failures. A browser that will not start, or a
 * page that never settles, must produce silence and a recorded reason — never a
 * clean bill of health, and never a failed run.
 */

let site: Fixture;

beforeAll(async () => {
	site = await startFixtureSite();
});

afterAll(async () => {
	await site.close();
});

const origin = () => new URL(site.baseUrl).origin;

describe("what the browser sees", () => {
	it(
		"measures a page and reports the browser's own vitals",
		async () => {
			const result = await renderSample({
				urls: [`${site.baseUrl}/handbook`],
				origin: origin(),
			});

			expect(result.complete).toBe(true);
			expect(result.observations).toHaveLength(1);

			const [observation] = result.observations;
			expect(observation?.renderError).toBeNull();
			/**
			 * A number, not a particular number. What this fixes is that the browser
			 * reported something at all — asserting a threshold here would be asserting
			 * the speed of whatever machine the suite runs on.
			 */
			expect(observation?.vitals.ttfbMs).toBeGreaterThanOrEqual(0);
			expect(observation?.vitals.cls).not.toBeNull();
		},
		RENDER_TEST_TIMEOUT_MS,
	);

	it(
		"reports a page whose own script throws",
		async () => {
			const result = await renderSample({
				urls: [`${site.baseUrl}/broken-script`],
				origin: origin(),
			});

			const [observation] = result.observations;
			expect(observation?.firstPartyErrors).toBeGreaterThan(0);
			expect(observation?.samples[0]?.message).toContain("first-party failure");
			expect(observation?.samples[0]?.firstParty).toBe(true);
		},
		RENDER_TEST_TIMEOUT_MS,
	);

	/**
	 * An uncaught exception and a `console.error` are the same fact to a reader
	 * and arrive on different events. Observing only one channel would miss the
	 * more serious class of failure while counting the lesser.
	 */
	it(
		"reports an error the page logged rather than threw",
		async () => {
			const result = await renderSample({
				urls: [`${site.baseUrl}/logs-error`],
				origin: origin(),
			});

			const [observation] = result.observations;
			expect(observation?.firstPartyErrors).toBeGreaterThan(0);
			expect(observation?.samples[0]?.message).toContain("logged failure");
		},
		RENDER_TEST_TIMEOUT_MS,
	);

	it(
		"says nothing about a page whose scripts behaved",
		async () => {
			const result = await renderSample({
				urls: [`${site.baseUrl}/handbook`],
				origin: origin(),
			});

			const [observation] = result.observations;
			expect(observation?.firstPartyErrors).toBe(0);
			expect(observation?.thirdPartyErrors).toBe(0);
		},
		RENDER_TEST_TIMEOUT_MS,
	);

	/**
	 * The bound that makes the pass safe to run at all. `/slow` holds the response
	 * for two seconds; a timeout under that must give up, record why, and leave
	 * the rest of the sample measurable.
	 */
	it(
		"records a timeout and keeps going",
		async () => {
			const result = await renderSample({
				urls: [`${site.baseUrl}/slow`, `${site.baseUrl}/handbook`],
				origin: origin(),
				perRenderTimeoutMs: 300,
			});

			expect(result.complete).toBe(true);
			expect(result.observations).toHaveLength(2);

			const slow = result.observations.find((o) => o.url.endsWith("/slow"));

			expect(slow?.renderError).not.toBeNull();
			expect(slow?.vitals.lcpMs).toBeNull();
			/**
			 * The budget is per page, so at 300ms the second page may well time out
			 * too. What this fixes is that the pass did not stop at the first failure:
			 * both pages have a row, and the pass reports itself usable.
			 */
			expect(result.observations.map((o) => o.url)).toHaveLength(2);
		},
		RENDER_TEST_TIMEOUT_MS,
	);

	it(
		"renders nothing, completely, when given nothing",
		async () => {
			const result = await renderSample({ urls: [], origin: origin() });

			expect(result).toEqual({ observations: [], complete: true });
		},
		RENDER_TEST_TIMEOUT_MS,
	);

	/**
	 * A page whose measurement failed still gets a row. "This page timed out" and
	 * "this page was never in the sample" are different facts, and a reader shown
	 * neither would assume the second.
	 */
	it(
		"gives an unmeasurable page a row rather than dropping it",
		async () => {
			const result = await renderSample({
				urls: [`${site.baseUrl}/nothing-here-at-all`],
				origin: origin(),
				perRenderTimeoutMs: 5_000,
			});

			expect(result.observations).toHaveLength(1);
			expect(result.observations[0]?.url).toContain("/nothing-here-at-all");
		},
		RENDER_TEST_TIMEOUT_MS,
	);
});
