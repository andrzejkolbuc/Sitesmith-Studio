/**
 * Presenting what a browser saw, and how little of the site that was.
 *
 * Split out from the component for the reason `summarise.ts`, `parity.ts` and
 * `trend.ts` are: the decisions here are small enough to look obviously correct,
 * which is exactly the kind of thing that turns out not to be.
 *
 * The load-bearing decision is the sentence about coverage. Everything else on
 * the project page describes the whole crawl; this section describes a handful
 * of pages, and a reader who carries the page's habit into it will read "no
 * console errors" as a statement about their site rather than about twelve of
 * its pages. So the coverage is stated, not implied — and where the pass could
 * not run at all, that is said instead of showing an empty table.
 */

export type Observation = {
	url: string;
	ttfbMs: number | null;
	lcpMs: number | null;
	/** Stored as text to keep the browser's precision; parsed for display only. */
	cls: string | null;
	firstPartyErrors: number;
	thirdPartyErrors: number;
	renderError: string | null;
};

export type RenderSummary = {
	chosen: number;
	measured: number;
	cap: number;
	complete: boolean;
} | null;

export type PerformanceState =
	/** The pass never ran, or ran before this feature existed. */
	| { kind: "not_recorded" }
	/** A browser could not be used, so nothing was measured and nothing is claimed. */
	| { kind: "unavailable" }
	/** Nothing qualified for measurement — an empty crawl, or nothing renderable. */
	| { kind: "nothing_to_measure" }
	| { kind: "measured"; coverage: string };

/**
 * Google's published thresholds, cited as Google's.
 *
 * The one place this product uses a number it did not derive from the site, and
 * it is defensible precisely because it is *not ours*: the reader can look it
 * up, and disagreeing with it is disagreeing with Google rather than with an
 * index we invented. A composite score built on top of these would be ours
 * again, which is why there isn't one.
 */
export const VITAL_BANDS = {
	lcpMs: { good: 2500, poor: 4000 },
	cls: { good: 0.1, poor: 0.25 },
	ttfbMs: { good: 800, poor: 1800 },
} as const;

export type Band = "good" | "needs-improvement" | "poor" | "unmeasured";

export function bandFor(
	metric: keyof typeof VITAL_BANDS,
	value: number | null,
): Band {
	if (value === null || Number.isNaN(value)) return "unmeasured";
	const { good, poor } = VITAL_BANDS[metric];
	if (value <= good) return "good";
	if (value <= poor) return "needs-improvement";
	return "poor";
}

/** CLS is stored as text; a value that will not parse is not a zero. */
export function parseCls(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * What the section should say about itself, in one sentence the reader can act
 * on.
 *
 * Never "no problems found": that sentence, on a section that looked at twelve
 * pages of five hundred, is the product overstating what it did.
 */
export function performanceState(
	summary: RenderSummary,
	observations: Observation[],
	pagesCrawled: number,
): PerformanceState {
	if (summary === null) return { kind: "not_recorded" };
	if (!summary.complete) return { kind: "unavailable" };
	if (summary.chosen === 0 || observations.length === 0) {
		return { kind: "nothing_to_measure" };
	}

	const measured = observations.filter((o) => o.renderError === null).length;
	const failed = observations.length - measured;

	const of =
		pagesCrawled > 0
			? ` of ${pagesCrawled} page${pagesCrawled === 1 ? "" : "s"} crawled`
			: "";

	const base = `${measured} page${measured === 1 ? "" : "s"} measured${of}`;

	return {
		kind: "measured",
		coverage: failed === 0 ? base : `${base}; ${failed} could not be measured`,
	};
}

/**
 * Whether this observation is worth the reader's attention.
 *
 * Used only for ordering. A page that could not be measured comes first — it is
 * the one fact here the reader cannot get anywhere else — then pages with
 * errors, then the slowest. Sorting by speed alone would bury a page that
 * failed to load behind pages that merely loaded slowly.
 */
export function orderObservations(observations: Observation[]): Observation[] {
	return [...observations].sort((a, b) => {
		const failed =
			Number(b.renderError !== null) - Number(a.renderError !== null);
		if (failed !== 0) return failed;

		const errors = b.firstPartyErrors - a.firstPartyErrors;
		if (errors !== 0) return errors;

		const slowest = (b.lcpMs ?? -1) - (a.lcpMs ?? -1);
		if (slowest !== 0) return slowest;

		return a.url.localeCompare(b.url);
	});
}

/**
 * The band, said without colour.
 *
 * `BAND_STYLE` in the table carries the verdict as a text colour, and colour is
 * the one carrier that does not survive the journeys this product's output
 * actually takes: a grayscale print, a reader with a colour vision deficiency,
 * a screen reader. A glyph survives all three, so the verdict travels as shape
 * first and colour second rather than colour alone.
 *
 * `good` and `unmeasured` are deliberately unmarked. A mark on every row is a
 * mark that carries nothing — the reader learns the shape of "fine" and stops
 * seeing it — and the absence is unambiguous next to rows that do carry one.
 */
export const BAND_MARK: Record<Band, string> = {
	good: "",
	"needs-improvement": "△",
	poor: "▲",
	unmeasured: "",
};

/** The same verdict in words, for a reader who cannot see the glyph. */
export const BAND_MEANING: Record<Band, string> = {
	good: "",
	"needs-improvement": "needs improvement",
	poor: "poor",
	unmeasured: "",
};
