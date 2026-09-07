import { describe, expect, it } from "vitest";

import { MIN_CHANGED_SHARE } from "~/server/crawl/visual-noise";

import {
	changeShare,
	describeVisualChange,
	differsMeaningfully,
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

/**
 * The section and the rule must agree about every page.
 *
 * They read the same `MIN_CHANGED_SHARE` from the same module, and these cases
 * exist because the alternative — a page the findings list calls changed and
 * this section calls unchanged — reads as a bug in the product rather than as a
 * fact about the site.
 */
describe("differsMeaningfully", () => {
	const withChange = (changedPixels: number, comparedPixels = 1_000_000) =>
		row({ comparison: { comparable: true, changedPixels, comparedPixels } });

	it("is false below the measured noise floor", () => {
		const justUnder = Math.floor(1_000_000 * MIN_CHANGED_SHARE) - 1;
		expect(differsMeaningfully(withChange(justUnder))).toBe(false);
	});

	it("is true at the floor", () => {
		const atFloor = Math.ceil(1_000_000 * MIN_CHANGED_SHARE);
		expect(differsMeaningfully(withChange(atFloor))).toBe(true);
	});

	/** The exact noise a real unchanged site produced. The section must call
	 * both of these pages a match, as the rule does. */
	it("calls the noise a real unchanged site produced a match", () => {
		expect(differsMeaningfully(withChange(1_831, 12_322_560))).toBe(false);
		expect(differsMeaningfully(withChange(10, 9_008_640))).toBe(false);
	});

	it("is false where there was no comparison", () => {
		expect(differsMeaningfully(row({ comparison: null }))).toBe(false);
		expect(
			differsMeaningfully(
				row({ comparison: { comparable: false, reason: "missing" } }),
			),
		).toBe(false);
	});

	/** Ordering follows the same decision, so a sub-floor page never sorts
	 * above a page that genuinely matched. */
	it("keeps sub-floor pages out of the changed group when ordering", () => {
		const noise = row({
			id: "noise",
			url: "https://client.test/noise",
			comparison: {
				comparable: true,
				changedPixels: 1_831,
				comparedPixels: 12_322_560,
			},
		});
		const real = row({
			id: "real",
			url: "https://client.test/real",
			comparison: {
				comparable: true,
				changedPixels: 500_000,
				comparedPixels: 1_000_000,
			},
		});
		const clean = row({ id: "clean", url: "https://client.test/clean" });

		expect(orderSnapshots([noise, clean, real]).map((r) => r.id)).toEqual([
			"real",
			"clean",
			"noise",
		]);
	});
});

/**
 * What the findings list says about a changed page.
 *
 * Caught by hand, not by a test: `visual_changed` reached the Problems list
 * with no entry in the evidence switch, so the reader was shown the raw detail
 * object — `{"url":"…","regions":[{"x":224,…`. Every other finding type states
 * what was expected and what was observed in the reader's own terms, and this
 * one has to as well.
 *
 * The property throughout: it says something the appearance section does not.
 * The section already gives the share; repeating it here would be two lines of
 * one fact, so this says the count, its denominator, and where on the page.
 */
describe("describeVisualChange", () => {
	const detail = {
		url: "https://client.test/",
		changedPixels: 209_286,
		comparedPixels: 2_595_840,
		regions: [
			{ x: 224, y: 192, width: 832, height: 176 },
			{ x: 272, y: 448, width: 736, height: 128 },
		],
		regionsCapped: false,
		thresholdShare: MIN_CHANGED_SHARE,
		heightDelta: -32,
	};

	it("counts the changed pixels against the area both pictures cover", () => {
		expect(describeVisualChange(detail).sentence).toBe(
			"209,286 of 2,595,840 compared pixels differ, in 2 regions",
		);
	});

	/** A share here would be the appearance section's sentence, printed twice. */
	it("does not repeat the section's percentage", () => {
		expect(describeVisualChange(detail).sentence).not.toContain("%");
	});

	/**
	 * Where, not just how much. FR-033 is the requirement that a reader be told
	 * which part of the page moved, and a region nobody can locate does not.
	 */
	it("places each region by size and position", () => {
		expect(describeVisualChange(detail).regions).toEqual([
			"832 × 176 at 224, 192",
			"736 × 128 at 272, 448",
		]);
	});

	/** The largest first: it is what the reader opened the finding to find. */
	it("puts the largest region first", () => {
		const described = describeVisualChange({
			...detail,
			regions: [
				{ x: 10, y: 10, width: 20, height: 20 },
				{ x: 40, y: 60, width: 400, height: 300 },
			],
		});
		expect(described.regions[0]).toBe("400 × 300 at 40, 60");
	});

	/** A capped list is a list that is not the whole truth, and says so. */
	it("says when there were more regions than it kept", () => {
		expect(
			describeVisualChange({ ...detail, regionsCapped: true }).sentence,
		).toBe("209,286 of 2,595,840 compared pixels differ, in 2 regions or more");
	});

	/**
	 * A page that reflowed shifts everything below the change, so the regions
	 * read as a page-wide difference. Saying the length moved is what makes that
	 * legible rather than alarming.
	 */
	it("reports a page that got shorter", () => {
		expect(describeVisualChange(detail).height).toBe(
			"The page is 32px shorter than the baseline",
		);
	});

	it("reports a page that got taller", () => {
		expect(describeVisualChange({ ...detail, heightDelta: 48 }).height).toBe(
			"The page is 48px taller than the baseline",
		);
	});

	it("says nothing about length when the page is the same height", () => {
		expect(
			describeVisualChange({ ...detail, heightDelta: 0 }).height,
		).toBeNull();
	});

	/** Ours, so it is shown — the same courtesy `image_oversized` extends. */
	it("shows the threshold that made it say so", () => {
		expect(describeVisualChange(detail).threshold).toBe(
			"Reported above 0.05% of the compared area",
		);
	});

	/**
	 * The detail is a `Record<string, unknown>` off a database row, so a shape
	 * that predates a field must render rather than throw.
	 */
	it("survives a detail missing every optional field", () => {
		const described = describeVisualChange({ url: "https://client.test/" });
		expect(described.sentence).toBe("Differs from the baseline");
		expect(described.regions).toEqual([]);
		expect(described.height).toBeNull();
		expect(described.threshold).toBeNull();
	});
});
