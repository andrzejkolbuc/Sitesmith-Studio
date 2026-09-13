import { describe, expect, it } from "vitest";

import {
	BAND_MARK,
	BAND_MEANING,
	type Band,
	bandFor,
	type Observation,
	orderObservations,
	parseCls,
	performanceState,
} from "./performance";

const observation = (over: Partial<Observation> = {}): Observation => ({
	url: "https://x.test/en/home",
	ttfbMs: 120,
	lcpMs: 900,
	cls: "0.02",
	firstPartyErrors: 0,
	thirdPartyErrors: 0,
	renderError: null,
	...over,
});

const summary = (
	over: Partial<NonNullable<Parameters<typeof performanceState>[0]>> = {},
) => ({
	chosen: 2,
	measured: 2,
	cap: 12,
	complete: true,
	...over,
});

describe("performanceState", () => {
	/**
	 * The sentence the whole section turns on. A reader who is not told the
	 * coverage will read a clean table as a statement about their site, because
	 * every other section on this page is one.
	 */
	it("says how many pages were measured, of how many crawled", () => {
		const state = performanceState(summary(), [observation()], 533);

		expect(state).toEqual({
			kind: "measured",
			coverage: "1 page measured of 533 pages crawled",
		});
	});

	it("names the pages it could not measure rather than omitting them", () => {
		const state = performanceState(
			summary({ chosen: 2 }),
			[
				observation(),
				observation({ url: "https://x.test/b", renderError: "timeout" }),
			],
			10,
		);

		expect(state.kind).toBe("measured");
		expect(state.kind === "measured" && state.coverage).toContain(
			"1 could not be measured",
		);
	});

	/**
	 * A run from before rendering existed has no absence to explain — the feature
	 * did not exist when it happened, and a notice would be about us.
	 */
	it("stays silent for a run that predates rendering", () => {
		expect(performanceState(null, [], 10)).toEqual({ kind: "not_recorded" });
	});

	/**
	 * The distinction the section exists to preserve. A browser that would not
	 * start is our failure; presenting it as a site with no measurable problems
	 * would be reporting our infrastructure as their result.
	 */
	it("distinguishes a browser that could not run from a site with nothing to measure", () => {
		expect(performanceState(summary({ complete: false }), [], 10)).toEqual({
			kind: "unavailable",
		});

		expect(
			performanceState(summary({ chosen: 0, measured: 0 }), [], 10),
		).toEqual({ kind: "nothing_to_measure" });
	});

	it("treats a complete pass with no observations as nothing to measure", () => {
		expect(performanceState(summary(), [], 0)).toEqual({
			kind: "nothing_to_measure",
		});
	});
});

describe("bandFor", () => {
	/**
	 * Google's numbers, not ours. The test states them literally so that changing
	 * one is a deliberate act rather than a refactor's side effect.
	 */
	it("follows Google's published thresholds", () => {
		expect(bandFor("lcpMs", 2000)).toBe("good");
		expect(bandFor("lcpMs", 3000)).toBe("needs-improvement");
		expect(bandFor("lcpMs", 5000)).toBe("poor");

		expect(bandFor("cls", 0.05)).toBe("good");
		expect(bandFor("cls", 0.2)).toBe("needs-improvement");
		expect(bandFor("cls", 0.4)).toBe("poor");
	});

	/**
	 * An unmeasured value is not a good one. Banding null as "good" would paint
	 * the pages we know least about in the colour that means "nothing to do".
	 */
	it("bands an absent measurement as unmeasured, never as good", () => {
		expect(bandFor("lcpMs", null)).toBe("unmeasured");
		expect(bandFor("cls", null)).toBe("unmeasured");
	});

	it("treats the threshold itself as the better band", () => {
		expect(bandFor("lcpMs", 2500)).toBe("good");
		expect(bandFor("lcpMs", 4000)).toBe("needs-improvement");
	});
});

describe("parseCls", () => {
	it("keeps the precision the browser reported", () => {
		expect(parseCls("0.0123")).toBeCloseTo(0.0123, 5);
	});

	/** A value that will not parse is unknown, and unknown is not zero. */
	it("returns null for a value that will not parse", () => {
		expect(parseCls(null)).toBeNull();
		expect(parseCls("not a number")).toBeNull();
	});
});

describe("orderObservations", () => {
	/**
	 * A page that could not be measured is the one fact here the reader cannot
	 * get anywhere else, so it leads. Sorting by speed alone would bury it behind
	 * pages that merely loaded slowly.
	 */
	it("puts unmeasurable pages first, then errors, then the slowest", () => {
		const ordered = orderObservations([
			observation({ url: "https://x.test/slow", lcpMs: 4000 }),
			observation({ url: "https://x.test/fast", lcpMs: 100 }),
			observation({ url: "https://x.test/errors", firstPartyErrors: 3 }),
			observation({ url: "https://x.test/failed", renderError: "timeout" }),
		]);

		expect(ordered.map((o) => new URL(o.url).pathname)).toEqual([
			"/failed",
			"/errors",
			"/slow",
			"/fast",
		]);
	});

	it("orders alphabetically when everything else is equal", () => {
		const ordered = orderObservations([
			observation({ url: "https://x.test/b" }),
			observation({ url: "https://x.test/a" }),
		]);

		expect(ordered.map((o) => new URL(o.url).pathname)).toEqual(["/a", "/b"]);
	});

	it("does not mutate the array it was given", () => {
		const input = [
			observation({ url: "https://x.test/b" }),
			observation({ url: "https://x.test/a" }),
		];
		const copy = [...input];

		orderObservations(input);

		expect(input).toEqual(copy);
	});
});

describe("BAND_MARK — the verdict without colour", () => {
	/*
	 * The table carries the band as a text colour. These assertions are what stop
	 * that being the *only* carrier, which is the state the printed report and any
	 * reader who does not separate amber from red would otherwise be left in.
	 */
	const BANDS: Band[] = ["good", "needs-improvement", "poor", "unmeasured"];

	it("gives the two verdicts that need acting on distinct marks", () => {
		expect(BAND_MARK["needs-improvement"]).not.toBe("");
		expect(BAND_MARK.poor).not.toBe("");
		expect(BAND_MARK.poor).not.toBe(BAND_MARK["needs-improvement"]);
	});

	it("leaves good and unmeasured unmarked, so a mark always means something", () => {
		expect(BAND_MARK.good).toBe("");
		expect(BAND_MARK.unmeasured).toBe("");
	});

	it("gives every marked band a word for a reader who cannot see the glyph", () => {
		for (const band of BANDS) {
			if (BAND_MARK[band] === "") continue;
			expect(BAND_MEANING[band]).not.toBe("");
		}
	});

	it("covers every band the thresholds can produce", () => {
		for (const band of BANDS) {
			expect(BAND_MARK).toHaveProperty(band);
			expect(BAND_MEANING).toHaveProperty(band);
		}

		/** The bands are not a free-standing list: they are what `bandFor` returns. */
		expect(bandFor("lcpMs", 900)).toBe("good");
		expect(bandFor("lcpMs", 3000)).toBe("needs-improvement");
		expect(bandFor("lcpMs", 5000)).toBe("poor");
		expect(bandFor("lcpMs", null)).toBe("unmeasured");
	});
});
