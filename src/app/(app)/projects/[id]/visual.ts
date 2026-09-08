import { MIN_CHANGED_SHARE } from "~/server/crawl/visual-noise";

/**
 * Presenting what the pictures showed, and how little of the site they cover.
 *
 * Split from the component for the reason `performance.ts`, `parity.ts` and
 * `trend.ts` are: the decisions are small enough to look obviously correct,
 * which is exactly the kind of thing that turns out not to be.
 *
 * This section carries one state the performance section does not, and it is the
 * state it will spend most of its life in: **no baseline pinned.** That is
 * neither a pass nor a failure, and it must not be rendered as either. A visual
 * section reading "no problems found" on a project nobody has told what the site
 * should look like would be the product's most confident lie.
 */

export type SnapshotRow = {
	/** The row's id, which is what the image route is addressed by. */
	id: string;
	url: string;
	/** Null when the picture failed, or when retention expired it. */
	byteSize: number | null;
	/** Set when the capture failed, and says why. */
	captureError: string | null;
	/** Set when retention dropped the bytes. */
	expiredAt: Date | null;
	/**
	 * How this page compares against the baseline, or null where the run made no
	 * comparison for it.
	 */
	comparison:
		| { comparable: true; changedPixels: number; comparedPixels: number }
		| { comparable: false; reason: string }
		| null;
};

export type VisualSummary = {
	baselineRunId: string | null;
	watched: number;
	captured: number;
	compared: number;
	differing: number;
	complete: boolean;
} | null;

export type VisualState =
	/** The run predates the visual pass, or died before recording it. */
	| { kind: "not_recorded" }
	/** No baseline pinned. Neither a pass nor a failure — say what to do. */
	| { kind: "no_baseline" }
	/**
	 * This run had no baseline, but the project has one now.
	 *
	 * Distinct from `no_baseline` because the instruction would be wrong: the
	 * reader has already done the thing, and repeating it would read as though
	 * their pin had not taken. What is true is narrower and more useful — this
	 * particular run predates the baseline, and the next one will be compared.
	 */
	| { kind: "predates_baseline" }
	/** A browser could not be used, so nothing was pictured and nothing is claimed. */
	| { kind: "unavailable" }
	/** A baseline exists but this run watched nothing — every page has gone. */
	| { kind: "nothing_watched" }
	| {
			kind: "compared";
			coverage: string;
			/**
			 * True when the baseline has been re-pinned since this run.
			 *
			 * The numbers below are then measured against something that is no
			 * longer the reference, which is a fact about *us* rather than about
			 * their site — the same thing `visualComparability` refuses on.
			 */
			supersededBaseline: boolean;
	  };

/**
 * What the section should say about itself, in one sentence.
 *
 * Never "no visual changes found" unqualified: that sentence, over a dozen
 * pages of a five-hundred-page site, is the product overstating what it looked
 * at. The count of watched pages travels in every sentence for that reason.
 */
export function visualState(
	summary: VisualSummary,
	rows: SnapshotRow[],
	pagesCrawled: number,
	/**
	 * The project's baseline *now*, which is not necessarily the one this run was
	 * measured against. A run records what was true when it closed; pinning
	 * afterwards does not retroactively compare it, and telling a reader to pin
	 * something they have already pinned reads as their action not having taken.
	 */
	projectBaselineRunId: string | null,
): VisualState {
	if (summary === null) return { kind: "not_recorded" };
	if (!summary.complete) return { kind: "unavailable" };

	if (summary.baselineRunId === null) {
		return projectBaselineRunId === null
			? { kind: "no_baseline" }
			: { kind: "predates_baseline" };
	}

	if (summary.watched === 0 || rows.length === 0) {
		return { kind: "nothing_watched" };
	}

	const of =
		pagesCrawled > 0
			? ` of ${pagesCrawled} page${pagesCrawled === 1 ? "" : "s"} crawled`
			: "";

	const base = `${summary.compared} page${
		summary.compared === 1 ? "" : "s"
	} compared against the baseline${of}`;

	const uncompared = summary.watched - summary.compared;

	return {
		kind: "compared",
		coverage:
			uncompared === 0 ? base : `${base}; ${uncompared} could not be compared`,
		supersededBaseline: summary.baselineRunId !== projectBaselineRunId,
	};
}

/**
 * Why a page has no comparison, in words rather than a discriminator.
 *
 * Every one of these is a fact about *us* — a picture we could not take, a
 * viewport we changed, a mask list that was edited. That is exactly why none of
 * them is a finding, and exactly why the section has to say them out loud: a
 * page silently absent from the comparison reads as a page that was fine.
 */
export function uncomparedReason(row: SnapshotRow): string | null {
	if (row.captureError !== null) return "could not be photographed";
	if (row.expiredAt !== null) return "its picture has expired";
	if (row.comparison === null) return "was not compared";
	if (row.comparison.comparable) return null;

	switch (row.comparison.reason) {
		case "missing":
			return "has no picture on one side to compare";
		case "viewport_differs":
			return "was photographed at a different size than the baseline";
		case "masks_differ":
			return "was photographed under different masks than the baseline";
		case "width_differs":
			return "produced a picture of a different width than the baseline";
		case "unreadable":
			return "produced a picture that could not be read";
		default:
			return "was not compared";
	}
}

/**
 * Whether this page differs, and by how much.
 *
 * A share rather than a grade. The denominator is stated because a raw pixel
 * count means nothing without one, and no threshold turns either number into a
 * verdict — that judgement is the reader's, over pictures they can see.
 */
export function changeShare(row: SnapshotRow): number | null {
	if (!row.comparison?.comparable) return null;
	if (row.comparison.comparedPixels === 0) return null;
	return row.comparison.changedPixels / row.comparison.comparedPixels;
}

/**
 * Whether this page differs by enough to say so.
 *
 * Reads the same {@link MIN_CHANGED_SHARE} the rule does, from the same module,
 * because the alternative is a page the findings list calls changed and this
 * section calls unchanged. Two parts of one screen contradicting each other
 * about one page reads as a bug in the product, and the only way they cannot is
 * if there is one number.
 */
export function differsMeaningfully(row: SnapshotRow): boolean {
	const share = changeShare(row);
	return share !== null && share >= MIN_CHANGED_SHARE;
}

/**
 * The order the reader should meet these in.
 *
 * A page that could not be compared comes first — it is the one fact here that
 * is unavailable anywhere else on the page. Then the most-changed, because that
 * is what the reader opened the section to find. URL last, so two runs of an
 * unchanged project list in the same order.
 */
export function orderSnapshots(rows: SnapshotRow[]): SnapshotRow[] {
	return [...rows].sort((a, b) => {
		const uncomparable =
			Number(uncomparedReason(b) !== null) -
			Number(uncomparedReason(a) !== null);
		if (uncomparable !== 0) return uncomparable;

		/** Sub-floor differences are not differences, so they do not sort as ones. */
		const changed =
			(differsMeaningfully(b) ? (changeShare(b) ?? 0) : -1) -
			(differsMeaningfully(a) ? (changeShare(a) ?? 0) : -1);
		if (changed !== 0) return changed;

		return a.url.localeCompare(b.url);
	});
}

/** A rectangle of the page that differs, in the picture's own coordinates. */
type ChangedRegion = { x: number; y: number; width: number; height: number };

/**
 * What the findings list says about a page that stopped looking like itself.
 *
 * Here rather than in the component for the reason the rest of this file is:
 * the sentence is a decision, and the one time it was left to the component it
 * silently printed the raw detail object at a reader.
 *
 * It deliberately does **not** print a percentage. The appearance section above
 * already says "8.1% of the page differs" for the same page, and a findings
 * entry repeating it would be one fact wearing two hats. What this adds is the
 * count with its denominator — the pixels, over the area both pictures actually
 * cover — and where on the page they are, which is the half of FR-033 a share
 * cannot carry.
 */
export function describeVisualChange(detail: Record<string, unknown>): {
	sentence: string;
	/** Largest first: what the reader opened the finding to find. */
	regions: string[];
	/** Null when the page is exactly as long as the baseline. */
	height: string | null;
	/** Null when the finding predates the recorded threshold. */
	threshold: string | null;
} {
	const num = (key: string): number | null =>
		typeof detail[key] === "number" ? (detail[key] as number) : null;

	const changed = num("changedPixels");
	const compared = num("comparedPixels");
	const capped = detail.regionsCapped === true;
	const heightDelta = num("heightDelta");
	const thresholdShare = num("thresholdShare");

	const regions: ChangedRegion[] = (
		Array.isArray(detail.regions) ? (detail.regions as ChangedRegion[]) : []
	)
		.filter(
			(region): region is ChangedRegion =>
				typeof region?.width === "number" && typeof region?.height === "number",
		)
		.sort((a, b) => b.width * b.height - a.width * a.height);

	/**
	 * A detail written by an older rule set still has to render. Silence about a
	 * number we do not have beats a sentence built around `null of null`.
	 */
	const sentence =
		changed === null || compared === null
			? "Differs from the baseline"
			: `${changed.toLocaleString("en-GB")} of ${compared.toLocaleString("en-GB")} compared pixels differ, in ${regions.length} ${regions.length === 1 ? "region" : "regions"}${capped ? " or more" : ""}`;

	return {
		sentence,
		regions: regions.map(
			(region) =>
				`${region.width} × ${region.height} at ${region.x}, ${region.y}`,
		),
		/**
		 * A page that reflowed shifts every pixel below the edit, so the regions
		 * read as though the whole page moved. Saying the length changed is what
		 * turns that from alarming into explicable.
		 */
		height:
			heightDelta === null || heightDelta === 0
				? null
				: `The page is ${Math.abs(heightDelta)}px ${heightDelta < 0 ? "shorter" : "taller"} than the baseline`,
		/**
		 * Ours, so it is shown — the same courtesy `image_oversized` extends with
		 * its byte threshold. A reader who thinks 0.05% is too coarse for their
		 * site can then disagree with the number rather than only with the verdict.
		 */
		threshold:
			thresholdShare === null
				? null
				: `Reported above ${Number((thresholdShare * 100).toFixed(4))}% of the compared area`,
	};
}

/** The procedure's own limits, checked here so a reader hears them first. */
const MAX_MASKS = 50;
const MAX_SELECTOR_LENGTH = 255;

/**
 * A textarea of masked regions, read as a list.
 *
 * **One selector per line, never comma-separated.** A comma is part of CSS —
 * `h1, h2` is a single selector list — so splitting on it would quietly mask two
 * things where the reader wrote one, and the reader would have no way to say
 * what they meant.
 *
 * The limits are `project.setMasks`'s. Repeating them here is not a second
 * validation of the same thing: the procedure's job is to refuse bad input, and
 * this one's is to tell the person typing what is wrong before they send it.
 */
export function parseMaskSelectors(text: string): {
	selectors: string[];
	/** Null when the list is sendable. A sentence, not a code. */
	problem: string | null;
} {
	const selectors = [
		...new Set(
			text
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0),
		),
	];

	const problem =
		selectors.length > MAX_MASKS
			? `A project can mask at most ${MAX_MASKS} regions.`
			: selectors.some((selector) => selector.length > MAX_SELECTOR_LENGTH)
				? `A selector cannot be longer than ${MAX_SELECTOR_LENGTH} characters.`
				: null;

	return { selectors, problem };
}
