import {
	type ComparabilityReason,
	type ComparableRun,
	comparability,
} from "~/server/crawl/comparison";

/**
 * The trend grid: finding types down, runs across.
 *
 * The parity grid asked one question in one picture; this asks the other one —
 * not "what is wrong now" but "has it been getting better". It is the same
 * shape with different axes, and deliberately so: the product's whole vocabulary
 * is tables and a small set of glyphs, and a chart would introduce a second
 * idiom to say something a grid already says.
 *
 * Per type, never as a total. On the one real project with ten runs, the total
 * reads 12 -> 8 -> 9 -> 42 -> 66 -> 67, and almost none of that is the site:
 * it is detection rules arriving. A single line drawn through those numbers is a
 * claim about the client that the data does not support.
 *
 * Pure, so the shape of the answer can be tested without a browser. The cell
 * vocabulary is two words wide: a count, or *not checked*. The second must not
 * render as zero — a rule that did not exist yet found nothing in the sense that
 * nobody looked, and reporting that as "no problems" is a statement about us
 * dressed up as a statement about them.
 */

/**
 * Why there is no grid yet, when there is not one.
 *
 * A section that renders an empty frame, or hides itself, teaches the reader
 * that the feature is broken or absent. Naming the missing precondition is the
 * same discipline the comparison's refusal follows, and it draws on the same
 * vocabulary so that one page never explains the same fact two ways.
 */
export type TrendGap =
	/** The project has never been checked. */
	| { kind: "no_runs" }
	/** One run, and one point is not a trend. Nothing is wrong. */
	| { kind: "one_run" }
	/** Runs exist that could not be drawn beside the reference. */
	| { kind: "excluded"; reason: ComparabilityReason };

/** What to say when the grid has fewer than two columns. Null when it does not. */
export function trendGap(
	/** The project's whole run history, newest first. */
	history: ComparableRun[],
	/** How many runs the trend actually returned. */
	plotted: number,
): TrendGap | null {
	if (plotted >= 2) return null;

	const newest = history[0];
	if (!newest) return { kind: "no_runs" };
	if (history.length === 1 && plotted === 1) return { kind: "one_run" };

	/**
	 * The same reference the aggregate picks: the most recent run that is sound
	 * on its own terms. Where there is none, the newest run's own verdict on
	 * itself is the reason — it is what stopped anything from being drawn.
	 */
	const reference = history.find((run) => comparability(run, run).comparable);
	if (!reference) {
		const verdict = comparability(newest, newest);
		return verdict.comparable
			? { kind: "one_run" }
			: { kind: "excluded", reason: verdict.reason };
	}

	/**
	 * The newest run that could not join the reference. The newest, because it is
	 * the one whose exclusion the reader is most likely to be asking about.
	 */
	for (const run of history) {
		if (run === reference) continue;
		const verdict = comparability(run, reference);
		if (!verdict.comparable)
			return { kind: "excluded", reason: verdict.reason };
	}

	return { kind: "one_run" };
}

/**
 * The gaps, in the reader's words.
 *
 * `excluded` deliberately does **not** reuse `REASON_SENTENCE`. It did, and on a
 * real project the result was the comparison's refusal and the trend's
 * explanation printing the same paragraph twice, one directly above the other —
 * which reads as a bug in the page rather than as two sections agreeing. The
 * reason is named; the explanation of what it means belongs to the refusal,
 * which is already on screen saying it.
 */
export const GAP_SENTENCE: Record<"no_runs" | "one_run", string> = {
	no_runs:
		"Nothing has been checked yet. A trend appears once this project has been checked twice under the same settings.",
	one_run:
		"Only one check counts towards a trend so far, and one point is not a trend. The next check under the same settings will draw the first comparison.",
};

export type TrendCell =
	| { kind: "count"; value: number }
	/** The rule was not part of this run, so this run has no answer. */
	| { kind: "not-checked" };

export type TrendRun = {
	id: string;
	createdAt: Date;
	/** Null cannot reach the grid: such runs never qualify as trend points. */
	ruleSet: string[] | null;
};

/** One `(runId, type)` count, as the aggregate returns it. */
export type TrendCount = {
	runId: string;
	type: string;
	count: number;
};

export type TrendRow = {
	type: string;
	/** One cell per column, in the same order as `runs`. */
	cells: TrendCell[];
	/** Whether the checked counts in this row differ from each other. */
	moved: boolean;
};

export type Trend = {
	/** Column order: oldest first, which is the reading order of the grid. */
	runs: TrendRun[];
	rows: TrendRow[];
	/** Types not shown because the list was capped. */
	hidden: number;
};

/**
 * How many types to draw before summarising the rest.
 *
 * Mirrors the parity grid's cap for the same reason: a grid nobody reads is
 * worse than no grid. Moved rows sort first, so the cap only ever hides types
 * whose counts never changed.
 */
export const MAX_ROWS = 14;

/**
 * How many runs to draw.
 *
 * Kept in step with the aggregate's own bound in `project.trend`. If the two
 * ever drift the grid still shows the most recent runs, so the consequence is
 * how much history is drawn, never which runs are trusted.
 */
export const MAX_COLUMNS = 12;

/**
 * Whether this run could have produced this finding type at all.
 *
 * The whole reason `runs.ruleSet` exists. Without it a type with no rows is
 * ambiguous between "the rule found nothing" and "the rule did not exist yet",
 * and only the first of those is about the site.
 */
const checked = (run: TrendRun, type: string): boolean =>
	run.ruleSet?.includes(type) ?? false;

export function buildTrend(
	runs: TrendRun[],
	counts: TrendCount[],
	limit: number = MAX_ROWS,
	columns: number = MAX_COLUMNS,
): Trend {
	/** The most recent runs, still oldest-first, so the grid reads left to right. */
	const shownRuns = runs.slice(Math.max(0, runs.length - Math.max(1, columns)));
	const shownIds = new Set(shownRuns.map((r) => r.id));

	const byRunAndType = new Map<string, number>();
	for (const row of counts) {
		if (shownIds.has(row.runId)) {
			byRunAndType.set(`${row.runId}\u0000${row.type}`, row.count);
		}
	}

	/**
	 * Every type any shown run checked for, plus anything that actually produced
	 * a finding. The second half is defensive: a count whose type is absent from
	 * the run's own rule set means the two have drifted, and silently dropping
	 * the row would hide the drift rather than show it.
	 */
	const types = new Set<string>();
	for (const run of shownRuns)
		for (const type of run.ruleSet ?? []) types.add(type);
	for (const row of counts) if (shownIds.has(row.runId)) types.add(row.type);

	const rows: TrendRow[] = [...types].map((type) => {
		const cells = shownRuns.map(
			(run): TrendCell =>
				checked(run, type)
					? {
							kind: "count",
							value: byRunAndType.get(`${run.id}\u0000${type}`) ?? 0,
						}
					: { kind: "not-checked" },
		);

		/**
		 * Movement is judged across the runs that checked, and only those. A type
		 * introduced halfway along has one answer, and one answer cannot have
		 * moved — treating its arrival as a change would put our own rule shipping
		 * at the top of a grid built to keep it out.
		 */
		const values = cells
			.filter((c): c is { kind: "count"; value: number } => c.kind === "count")
			.map((c) => c.value);
		const moved = values.some((v) => v !== values[0]);

		return { type, cells, moved };
	});

	/**
	 * Moved first, then types that have ever found something, then alphabetical.
	 *
	 * The middle clause is what makes the cap usable rather than merely safe. Most
	 * of the two dozen rules find nothing on any given site, so sorting straight
	 * to alphabetical would fill a fourteen-row grid with empty rows and summarise
	 * away the site's actual problems as "and N more".
	 */
	const found = (row: TrendRow) =>
		row.cells.some((c) => c.kind === "count" && c.value > 0);

	rows.sort(
		(a, b) =>
			Number(b.moved) - Number(a.moved) ||
			Number(found(b)) - Number(found(a)) ||
			a.type.localeCompare(b.type),
	);

	const shown = rows.slice(0, Math.max(1, limit));

	return {
		runs: shownRuns,
		rows: shown,
		hidden: rows.length - shown.length,
	};
}
