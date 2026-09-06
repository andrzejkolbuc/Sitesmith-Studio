import { describe, expect, it } from "vitest";

import {
	changeShare,
	orderSnapshots,
	type SnapshotRow,
	uncomparedReason,
	type VisualSummary,
	visualState,
} from "./visual";

/**
 * What the appearance section says about itself.
 *
 * The property under test throughout is the one the performance section
 * established and this one inherits: **the section never implies it looked at
 * more than it did, and never reads as a clean bill of health when it looked at
 * nothing.** The state it spends most of its life in — no baseline pinned — is
 * the sharpest case of that.
 */

const R = "https://client.test";

function row(overrides: Partial<SnapshotRow> = {}): SnapshotRow {
	return {
		id: "s1",
		url: `${R}/`,
		byteSize: 120_000,
		captureError: null,
		expiredAt: null,
		comparison: {
			comparable: true,
			changedPixels: 0,
			comparedPixels: 1_000_000,
		},
		...overrides,
	};
}

function summary(overrides: Partial<NonNullable<VisualSummary>> = {}) {
	return {
		baselineRunId: "baseline-run",
		watched: 3,
		captured: 3,
		compared: 3,
		differing: 0,
		complete: true,
		...overrides,
	};
}

describe("visualState", () => {
	it("says nothing at all about a run from before the visual pass", () => {
		expect(visualState(null, [], 100, null)).toEqual({ kind: "not_recorded" });
	});

	/**
	 * Not a pass and not a failure. The section has to say what to do, because
	 * this is where a project lives until somebody pins something.
	 */
	it("reports a project with no baseline as needing one", () => {
		expect(
			visualState(summary({ baselineRunId: null }), [row()], 100, null),
		).toEqual({ kind: "no_baseline" });
	});

	/**
	 * The bug an e2e journey caught: a run records what was true when it closed,
	 * so pinning afterwards does not retroactively compare it. Repeating the
	 * "pin one" instruction here would read to the reader as their pin not
	 * having taken.
	 */
	it("does not re-ask for a baseline the reader has already pinned", () => {
		expect(
			visualState(
				summary({ baselineRunId: null }),
				[row()],
				100,
				"baseline-run",
			),
		).toEqual({ kind: "predates_baseline" });
	});

	/** A comparison against a reference that is no longer the reference is a
	 * fact about us, and is said rather than silently ignored. */
	it("flags numbers measured against a baseline since replaced", () => {
		const state = visualState(summary(), [row()], 100, "a-newer-baseline");

		if (state.kind !== "compared") throw new Error("expected a comparison");
		expect(state.supersededBaseline).toBe(true);
	});

	it("reports an unusable browser as our failure, not the site's", () => {
		expect(
			visualState(summary({ complete: false }), [], 100, "baseline-run"),
		).toEqual({
			kind: "unavailable",
		});
	});

	it("reports a baseline whose pages were all missed", () => {
		expect(
			visualState(summary({ watched: 0 }), [], 100, "baseline-run"),
		).toEqual({
			kind: "nothing_watched",
		});
		expect(visualState(summary(), [], 100, "baseline-run")).toEqual({
			kind: "nothing_watched",
		});
	});

	/**
	 * The load-bearing sentence. Every rendering of it carries how many pages
	 * were compared and how many the crawl found, so a reader cannot mistake a
	 * quiet section for a statement about their whole site.
	 */
	it("states its coverage against the size of the crawl", () => {
		const state = visualState(
			summary(),
			[row(), row(), row()],
			480,
			"baseline-run",
		);

		expect(state).toEqual({
			kind: "compared",
			coverage: "3 pages compared against the baseline of 480 pages crawled",
			supersededBaseline: false,
		});
	});

	it("says how many watched pages it could not compare", () => {
		const state = visualState(
			summary({ watched: 5, compared: 3 }),
			[row(), row(), row()],
			480,
			"baseline-run",
		);

		if (state.kind !== "compared") throw new Error("expected a comparison");
		expect(state.coverage).toContain("2 could not be compared");
	});

	it("never claims the site has no problems", () => {
		const states = [
			visualState(summary({ baselineRunId: null }), [row()], 100, null),
			visualState(summary({ complete: false }), [], 100, "baseline-run"),
			visualState(summary({ watched: 0 }), [], 100, "baseline-run"),
			visualState(summary(), [row()], 100, "baseline-run"),
		];

		for (const state of states) {
			const text = "coverage" in state ? state.coverage : "";
			expect(text.toLowerCase()).not.toContain("no problem");
			expect(text.toLowerCase()).not.toContain("no changes");
		}
	});

	it("keeps its singulars and plurals honest", () => {
		const state = visualState(
			summary({ watched: 1, compared: 1 }),
			[row()],
			1,
			"baseline-run",
		);

		if (state.kind !== "compared") throw new Error("expected a comparison");
		expect(state.coverage).toBe(
			"1 page compared against the baseline of 1 page crawled",
		);
	});
});

describe("uncomparedReason", () => {
	it("is silent for a page that was compared", () => {
		expect(uncomparedReason(row())).toBeNull();
	});

	it("names a capture that failed", () => {
		expect(uncomparedReason(row({ captureError: "timeout" }))).toBe(
			"could not be photographed",
		);
	});

	it("names a picture retention has dropped", () => {
		expect(
			uncomparedReason(
				row({ byteSize: null, expiredAt: new Date(), comparison: null }),
			),
		).toBe("its picture has expired");
	});

	/**
	 * Each of these is a change *we* made. Saying so out loud is the point: a
	 * page silently absent from the comparison reads as a page that was fine.
	 */
	it("names each refusal in words the reader can act on", () => {
		const reasons = [
			"missing",
			"viewport_differs",
			"masks_differ",
			"width_differs",
			"unreadable",
		];

		const said = reasons.map((reason) =>
			uncomparedReason(row({ comparison: { comparable: false, reason } })),
		);

		expect(said.every((text) => text !== null && text.length > 0)).toBe(true);
		/** Distinct, so a reader can tell which of our changes caused it. */
		expect(new Set(said).size).toBe(reasons.length);
	});

	it("falls back rather than printing a raw discriminator", () => {
		expect(
			uncomparedReason(
				row({ comparison: { comparable: false, reason: "something_new" } }),
			),
		).toBe("was not compared");
	});
});

describe("changeShare", () => {
	it("is the changed pixels over what was compared", () => {
		expect(
			changeShare(
				row({
					comparison: {
						comparable: true,
						changedPixels: 5_000,
						comparedPixels: 1_000_000,
					},
				}),
			),
		).toBeCloseTo(0.005);
	});

	it("is nothing where there was no comparison", () => {
		expect(changeShare(row({ comparison: null }))).toBeNull();
		expect(
			changeShare(
				row({ comparison: { comparable: false, reason: "missing" } }),
			),
		).toBeNull();
	});

	/** Zero compared pixels has no share; dividing would produce NaN and render
	 * as a page that changed by an unknowable amount. */
	it("is nothing where nothing was compared", () => {
		expect(
			changeShare(
				row({
					comparison: {
						comparable: true,
						changedPixels: 0,
						comparedPixels: 0,
					},
				}),
			),
		).toBeNull();
	});
});

describe("orderSnapshots", () => {
	it("puts what could not be compared first, then the most changed", () => {
		const changedALot = row({
			id: "a",
			url: `${R}/a`,
			comparison: {
				comparable: true,
				changedPixels: 500_000,
				comparedPixels: 1_000_000,
			},
		});
		const changedALittle = row({
			id: "b",
			url: `${R}/b`,
			comparison: {
				comparable: true,
				changedPixels: 10,
				comparedPixels: 1_000_000,
			},
		});
		const unchanged = row({ id: "c", url: `${R}/c` });
		const failed = row({ id: "d", url: `${R}/d`, captureError: "timeout" });

		expect(
			orderSnapshots([unchanged, changedALittle, changedALot, failed]).map(
				(r) => r.id,
			),
		).toEqual(["d", "a", "b", "c"]);
	});

	it("orders equal rows by URL so two runs read the same", () => {
		const first = orderSnapshots([
			row({ id: "z", url: `${R}/z` }),
			row({ id: "a", url: `${R}/a` }),
		]);
		const second = orderSnapshots([
			row({ id: "a", url: `${R}/a` }),
			row({ id: "z", url: `${R}/z` }),
		]);

		expect(first.map((r) => r.id)).toEqual(["a", "z"]);
		expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
	});

	it("does not mutate what it was given", () => {
		const rows = [row({ id: "z", url: `${R}/z` }), row({ id: "a" })];
		orderSnapshots(rows);
		expect(rows.map((r) => r.id)).toEqual(["z", "a"]);
	});
});
