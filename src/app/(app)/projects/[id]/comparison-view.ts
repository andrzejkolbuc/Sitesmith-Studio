import type {
	Comparability,
	ComparabilityReason,
	FindingStatus,
} from "~/server/crawl/comparison";

/**
 * Presenting what changed since the previous run.
 *
 * Split out from the component for the reason `summarise.ts` and `parity.ts`
 * are: the decisions here are small enough to look obviously correct, which is
 * exactly the kind of thing that turns out not to be.
 */

/** A finding as the view holds it, once the comparison has annotated it. */
export type AnnotatedRow = {
	id: string;
	type: string;
	detail: Record<string, unknown>;
	/** Null when this run has no predecessor, or the two are not comparable. */
	status: FindingStatus | null;
};

/**
 * Why no comparison is shown, in the reader's words.
 *
 * An unexplained absence is the thing that makes people stop trusting a tool —
 * the same reasoning the stale-run sweep was written under. Each sentence names
 * what happened and, where there is one, what the reader can do about it.
 */
export const REASON_SENTENCE: Record<ComparabilityReason, string> = {
	not_recorded:
		"The previous run finished before this check could record what it covered, so there is nothing safe to compare against. The next run will have a baseline.",
	incomplete_crawl:
		"One of these two runs stopped before it reached the whole site, so anything missing from it might simply never have been visited.",
	scope_changed:
		"The crawl scope changed between these two runs. They looked at different parts of the site, so a finding that is absent now was not necessarily fixed.",
	/**
	 * The one refusal that is about us rather than about them, and it says so.
	 * A reader told only that the runs differ would go looking for what they
	 * changed, and there is nothing on their side to find.
	 */
	rules_changed:
		"We added or changed checks between these two runs, so the two runs were not looking for the same things. There is nothing to fix on your side — the next run will have a matching baseline.",
};

/** The heading above the refusal, kept beside the sentence it introduces. */
export const REASON_HEADING: Record<ComparabilityReason, string> = {
	not_recorded: "No comparison available",
	incomplete_crawl: "Not compared — a run did not finish",
	scope_changed: "Not compared — the scope changed",
	rules_changed: "Not compared — our checks changed",
};

/**
 * Whether the view should render comparison at all.
 *
 * Three states collapse to two questions, and keeping them apart here stops the
 * component from re-deriving them: a first run has no predecessor and is not a
 * refusal, while an incomparable pair is.
 */
export function comparisonState(comparability: Comparability | null):
	| { kind: "none" }
	| { kind: "refused"; reason: ComparabilityReason }
	| {
			kind: "compared";
	  } {
	if (comparability === null) return { kind: "none" };
	if (comparability.comparable) return { kind: "compared" };
	return { kind: "refused", reason: comparability.reason };
}

/**
 * Splits annotated findings into the ones this run still has and the ones it no
 * longer does.
 *
 * Resolved findings are held apart rather than mixed into the list, because
 * they describe what is *no longer* wrong — rendering them beside live problems
 * would make a fixed page compete for attention with a broken one, which is the
 * opposite of what the comparison is for.
 */
export function splitResolved<T extends { status: FindingStatus | null }>(
	findings: T[],
): { present: T[]; resolved: T[] } {
	const present: T[] = [];
	const resolved: T[] = [];

	for (const finding of findings) {
		if (finding.status === "resolved") resolved.push(finding);
		else present.push(finding);
	}

	return { present, resolved };
}

/**
 * How many findings inside a correlated problem are new.
 *
 * A problem folding twenty findings, three of them new, is a different message
 * from one that is entirely new — the first says a known problem spread, the
 * second says a problem appeared. Counted from the annotated rows rather than
 * carried through correlation, so `correlate.ts` stays unaware of comparison.
 */
export function newCount(
	findingIds: string[],
	statusById: Map<string, FindingStatus | null>,
): number {
	return findingIds.filter((id) => statusById.get(id) === "new").length;
}

/** Status lookup for a set of annotated rows, keyed by finding id. */
export function statusIndex<
	T extends { id: string; status: FindingStatus | null },
>(findings: T[]): Map<string, FindingStatus | null> {
	return new Map(findings.map((f) => [f.id, f.status]));
}

/**
 * What a problem's new-finding count says, or nothing at all.
 *
 * Silent when the whole problem is new and when none of it is: in the first
 * case the badge on the problem already says so, and in the second there is
 * nothing to report. A count is shown only where it tells the reader something
 * the surrounding markers do not.
 */
export function spreadSentence(
	newInProblem: number,
	total: number,
): string | null {
	if (newInProblem === 0) return null;
	if (newInProblem === total) return null;
	return `${newInProblem} of ${total} new since the previous run`;
}
