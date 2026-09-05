import { describe, expect, it } from "vitest";

import type { ComparableRun } from "~/server/crawl/comparison";
import { FINDING_TYPES } from "~/server/crawl/findings";
import { FINDING_LABEL } from "./finding-labels";
import {
	buildTrend,
	GAP_SENTENCE,
	type TrendCount,
	type TrendRun,
	trendGap,
} from "./trend";

const run = (id: string, day: number, ruleSet: string[] | null): TrendRun => ({
	id,
	createdAt: new Date(Date.UTC(2026, 8, day)),
	ruleSet,
});

const count = (runId: string, type: string, value: number): TrendCount => ({
	runId,
	type,
	count: value,
});

const cellsOf = (trend: ReturnType<typeof buildTrend>, type: string) =>
	trend.rows.find((row) => row.type === type)?.cells;

describe("buildTrend", () => {
	/**
	 * The distinction the whole slice rests on. A rule that did not exist yet
	 * found nothing in the sense that nobody looked, and drawing that as a zero
	 * would show every rule we have ever shipped as a problem the client fixed
	 * on the day we shipped it.
	 */
	it("renders a type outside a run's rule set as not checked, never as zero", () => {
		const trend = buildTrend(
			[
				run("r1", 1, ["link_broken"]),
				run("r2", 2, ["link_broken", "no_hreflang"]),
			],
			[count("r2", "no_hreflang", 4)],
		);

		expect(cellsOf(trend, "no_hreflang")).toEqual([
			{ kind: "not-checked" },
			{ kind: "count", value: 4 },
		]);
	});

	it("renders a checked type with no findings as zero", () => {
		const trend = buildTrend(
			[run("r1", 1, ["link_broken"]), run("r2", 2, ["link_broken"])],
			[count("r1", "link_broken", 2)],
		);

		expect(cellsOf(trend, "link_broken")).toEqual([
			{ kind: "count", value: 2 },
			{ kind: "count", value: 0 },
		]);
	});

	/**
	 * A type checked by only one of the plotted runs has one answer, and one
	 * answer cannot have moved. Counting its arrival as movement would sort our
	 * own rule shipping to the top of a grid built to keep it out.
	 */
	it("does not treat a rule arriving as movement", () => {
		const trend = buildTrend(
			[
				run("r1", 1, ["link_broken"]),
				run("r2", 2, ["link_broken", "no_hreflang"]),
			],
			[count("r2", "no_hreflang", 9)],
		);

		expect(trend.rows.find((row) => row.type === "no_hreflang")?.moved).toBe(
			false,
		);
	});

	it("sorts moved rows above flat ones", () => {
		const rules = ["a_flat", "z_moved"];
		const trend = buildTrend(
			[run("r1", 1, rules), run("r2", 2, rules)],
			[
				count("r1", "a_flat", 3),
				count("r2", "a_flat", 3),
				count("r1", "z_moved", 1),
				count("r2", "z_moved", 5),
			],
		);

		expect(trend.rows.map((row) => row.type)).toEqual(["z_moved", "a_flat"]);
	});

	/**
	 * Most of the two dozen rules find nothing on any given site. Alphabetical
	 * order alone would fill the grid with empty rows and summarise the site's
	 * actual problems away as "and N more".
	 */
	it("sorts a type that has found something above one that never has", () => {
		const rules = ["a_empty", "z_found"];
		const trend = buildTrend(
			[run("r1", 1, rules), run("r2", 2, rules)],
			[count("r1", "z_found", 2), count("r2", "z_found", 2)],
		);

		expect(trend.rows.map((row) => row.type)).toEqual(["z_found", "a_empty"]);
	});

	it("hides only flat rows when the row cap bites", () => {
		const rules = ["a_flat", "b_flat", "c_moved"];
		const trend = buildTrend(
			[run("r1", 1, rules), run("r2", 2, rules)],
			[
				count("r1", "a_flat", 1),
				count("r2", "a_flat", 1),
				count("r1", "b_flat", 2),
				count("r2", "b_flat", 2),
				count("r1", "c_moved", 1),
				count("r2", "c_moved", 7),
			],
			2,
		);

		expect(trend.rows.map((row) => row.type)).toEqual(["c_moved", "a_flat"]);
		expect(trend.hidden).toBe(1);
		expect(trend.rows.every((row) => row.moved || row.type !== "c_moved")).toBe(
			true,
		);
	});

	it("keeps the most recent runs when the column cap bites", () => {
		const rules = ["link_broken"];
		const trend = buildTrend(
			[run("r1", 1, rules), run("r2", 2, rules), run("r3", 3, rules)],
			[
				count("r1", "link_broken", 1),
				count("r2", "link_broken", 2),
				count("r3", "link_broken", 3),
			],
			14,
			2,
		);

		expect(trend.runs.map((r) => r.id)).toEqual(["r2", "r3"]);
		expect(cellsOf(trend, "link_broken")).toEqual([
			{ kind: "count", value: 2 },
			{ kind: "count", value: 3 },
		]);
	});

	it("returns an empty grid rather than throwing on empty input", () => {
		expect(buildTrend([], [])).toEqual({ runs: [], rows: [], hidden: 0 });
	});

	/**
	 * A single qualifying run is a grid with one column, not an error. The view
	 * decides what to say about it; the builder's job is to hand it something
	 * shaped like a grid either way.
	 */
	it("shapes a single run as a one-column grid", () => {
		const trend = buildTrend(
			[run("r1", 1, ["link_broken"])],
			[count("r1", "link_broken", 3)],
		);

		expect(trend.runs).toHaveLength(1);
		expect(cellsOf(trend, "link_broken")).toEqual([
			{ kind: "count", value: 3 },
		]);
	});

	/**
	 * A count whose type is absent from the run's own rule set means the two have
	 * drifted. Dropping the row would hide the drift; showing it surfaces it.
	 */
	it("keeps a counted type the rule set does not mention", () => {
		const trend = buildTrend(
			[run("r1", 1, ["link_broken"])],
			[count("r1", "surprise_type", 1)],
		);

		expect(cellsOf(trend, "surprise_type")).toEqual([{ kind: "not-checked" }]);
	});
});

const RULES = ["link_broken", "no_hreflang"];

const sound = (over: Partial<ComparableRun> = {}): ComparableRun => ({
	crawlComplete: true,
	scope: { includePaths: [], excludePaths: ["/private"], locales: ["en"] },
	ruleSet: RULES,
	...over,
});

describe("trendGap", () => {
	it("says nothing when there are two comparable runs to draw", () => {
		expect(trendGap([sound(), sound()], 2)).toBeNull();
	});

	it("names a project that has never been checked", () => {
		expect(trendGap([], 0)).toEqual({ kind: "no_runs" });
	});

	/**
	 * One run is not a fault and must not read as one. The reader is told the
	 * next check draws the first comparison, rather than being shown a section
	 * that looks broken.
	 */
	it("names a single run as one point rather than a failure", () => {
		expect(trendGap([sound()], 1)).toEqual({ kind: "one_run" });
	});

	/**
	 * The case the explanation exists for: runs the reader can see in the history
	 * above, absent from the grid below it. Saying nothing would read as a bug in
	 * the grid; naming the precondition tells them what happened.
	 */
	it("names why an existing run could not be drawn", () => {
		expect(
			trendGap(
				[
					sound(),
					sound({
						scope: {
							includePaths: ["/handbook"],
							excludePaths: ["/private"],
							locales: ["en"],
						},
					}),
				],
				1,
			),
		).toEqual({ kind: "excluded", reason: "scope_changed" });
	});

	it("names the newest run's own verdict when no run is sound", () => {
		expect(trendGap([sound({ crawlComplete: false }), sound()], 0)).toEqual({
			kind: "excluded",
			reason: "incomplete_crawl",
		});
	});

	/**
	 * Runs from before this recording answer `not_recorded`, which is the reason
	 * an existing project sees on the day this ships.
	 */
	it("names unrecorded conditions on runs that predate the column", () => {
		expect(trendGap([sound({ ruleSet: null }), sound()], 0)).toEqual({
			kind: "excluded",
			reason: "not_recorded",
		});
	});

	it("has a sentence for every gap it can report", () => {
		for (const kind of ["no_runs", "one_run"] as const) {
			expect(GAP_SENTENCE[kind].length).toBeGreaterThan(20);
		}
	});
});

describe("row labels", () => {
	/**
	 * A row header the reader cannot read is a row they cannot act on. The grid
	 * falls back to the raw type rather than blanking, but every type the rules
	 * can emit should have words.
	 */
	it("labels every finding type the rules can produce", () => {
		for (const type of Object.values(FINDING_TYPES)) {
			expect(FINDING_LABEL[type], type).toBeTruthy();
		}
	});
});
