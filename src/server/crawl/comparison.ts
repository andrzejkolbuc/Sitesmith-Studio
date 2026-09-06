import { findingIdentity } from "./identity";

/**
 * What changed between two runs, and whether that question may be asked at all.
 *
 * A run diff is a claim about two of *our* observations, not about the client's
 * site. That distinction is the whole of this module. "This finding is gone"
 * means the site was fixed only if both crawls looked at the same site under the
 * same instructions — otherwise it means we looked somewhere else, or stopped
 * early, and reporting it as a fix would be the fourth entry in
 * `context/foundation/lessons.md` written a fifth time.
 *
 * So the comparison refuses before it reports. `comparability` is checked first
 * and its reason travels with the answer, because a view that shows nothing and
 * says nothing is the thing that makes people stop trusting a tool.
 */

/** The run fields a comparison reads. Structural, so tests need no database. */
export type ComparableRun = {
	crawlComplete: boolean | null;
	scope: {
		includePaths: string[];
		excludePaths: string[];
		locales: string[];
	} | null;
	/** The detection rules that could have fired; null on runs from before it. */
	ruleSet: string[] | null;
};

export type ComparabilityReason =
	/** One of the runs predates comparison, or died before recording anything. */
	| "not_recorded"
	/** One of the runs aborted or hit the page ceiling. */
	| "incomplete_crawl"
	/** The project was told to crawl something different in between. */
	| "scope_changed"
	/** We changed what we check for between the two runs. */
	| "rules_changed";

export type Comparability =
	| { comparable: true }
	| { comparable: false; reason: ComparabilityReason };

/** A finding as stored, in the shape the comparison needs. */
export type StoredFinding = {
	id: string;
	type: string;
	detail: Record<string, unknown>;
};

export type FindingStatus = "new" | "still_present" | "resolved";

export type AnnotatedFinding<T extends StoredFinding = StoredFinding> = T & {
	status: FindingStatus;
};

/** Set equality over two string arrays, order and repetition aside. */
function sameSet(a: string[], b: string[]): boolean {
	const left = new Set(a);
	const right = new Set(b);
	if (left.size !== right.size) return false;
	for (const value of left) if (!right.has(value)) return false;
	return true;
}

/**
 * Whether two runs may be compared, and if not, why not.
 *
 * Checks run most-fundamental first, so the reason reported is the one the
 * reader has to fix first: a run that recorded nothing cannot also be judged on
 * its scope.
 *
 * Both runs must have finished the whole site. A truncated run supports neither
 * direction of the comparison — a finding absent from it may live in the part
 * that was never visited, and a finding present in it may have been present
 * before in a part the other run missed.
 */
export function comparability(
	previous: ComparableRun,
	current: ComparableRun,
): Comparability {
	if (
		previous.crawlComplete === null ||
		current.crawlComplete === null ||
		previous.scope === null ||
		current.scope === null ||
		previous.ruleSet === null ||
		current.ruleSet === null
	) {
		return { comparable: false, reason: "not_recorded" };
	}

	if (!previous.crawlComplete || !current.crawlComplete) {
		return { comparable: false, reason: "incomplete_crawl" };
	}

	/**
	 * Set equality, not similarity. `correlate.ts` states the same rule for the
	 * same reason: a threshold on "close enough" is a number nobody can defend,
	 * and the scope arrays are short enough that equality is the honest test.
	 *
	 * Locales are compared alongside the paths because they are an instruction
	 * too — a project that stops expecting French stops being able to report
	 * French missing, and every one of those findings would otherwise read as
	 * resolved.
	 */
	if (
		!sameSet(previous.scope.includePaths, current.scope.includePaths) ||
		!sameSet(previous.scope.excludePaths, current.scope.excludePaths) ||
		!sameSet(previous.scope.locales, current.scope.locales)
	) {
		return { comparable: false, reason: "scope_changed" };
	}

	/**
	 * Evaluated last, and deliberately so. Every reason above is either something
	 * the reader can act on or something about their own site; this one is about
	 * us. When a run differs in both, the scope is what they can fix, so that is
	 * the answer they are given.
	 *
	 * Without the clause the first comparison after any new rule ships reports
	 * every finding that rule produces as new — "your site broke" where the truth
	 * is "we started checking". Set equality again, for the reason the scope uses
	 * it: the rule set is recorded sorted, but a reordering is still not a change.
	 */
	if (!sameSet(previous.ruleSet, current.ruleSet)) {
		return { comparable: false, reason: "rules_changed" };
	}

	return { comparable: true };
}

/** The visual half of a run, in the shape its own comparability check needs. */
export type ComparableVisual = {
	visualSummary: { baselineRunId: string | null } | null;
};

export type VisualComparabilityReason =
	/** One of the runs predates the visual pass, or died before recording it. */
	| "not_recorded"
	/** The two runs were measured against different baselines. */
	| "baseline_changed";

export type VisualComparability =
	| { comparable: true }
	| { comparable: false; reason: VisualComparabilityReason };

/**
 * Whether two runs' *visual* findings may be called new or resolved.
 *
 * Separate from {@link comparability}, and deliberately so. A baseline moving
 * says nothing whatever about the hreflang graph, so folding it into the
 * whole-run check would suppress every other comparison over a fact that
 * concerns one rule. The narrower question gets a narrower answer.
 *
 * What it is guarding is the fourth entry in `context/foundation/lessons.md`
 * wearing a different coat. That rule says a rule shipping is not the site
 * changing; **a re-baseline is not the site changing either**. Re-pin a project
 * and every page that differed from the old baseline stops differing from the
 * new one, which without this reads as a deploy that fixed the whole site.
 *
 * A run compared against *no* baseline and a run compared against one are also
 * not comparable, and fall out of the same equality: `null` is a baseline id
 * like any other here.
 */
export function visualComparability(
	previous: ComparableVisual,
	current: ComparableVisual,
): VisualComparability {
	if (
		previous.visualSummary === null ||
		current.visualSummary === null ||
		/**
		 * A run that recorded a summary but no baseline had nothing to compare
		 * against, so there is no earlier visual state for this one to be measured
		 * against either. Reported as not-recorded rather than as a changed
		 * baseline, because nothing changed — there was never one.
		 */
		(previous.visualSummary.baselineRunId === null &&
			current.visualSummary.baselineRunId === null)
	) {
		return { comparable: false, reason: "not_recorded" };
	}

	if (
		previous.visualSummary.baselineRunId !== current.visualSummary.baselineRunId
	) {
		return { comparable: false, reason: "baseline_changed" };
	}

	return { comparable: true };
}

/**
 * Annotates the current run's findings against the previous run's.
 *
 * Resolved findings carry the *previous* run's row, because there is no current
 * row to carry — they are the half of "what changed" that exists only in the
 * older run.
 *
 * Findings sharing one identity within a single run are matched pairwise rather
 * than as sets, so three of a kind yesterday and one today reports one still
 * present and two resolved instead of collapsing to a single match. The rules
 * are not supposed to emit duplicates, but a comparison that quietly loses
 * count if they do would hide the fact.
 */
export function compareFindings<T extends StoredFinding>(
	previous: T[],
	current: T[],
): AnnotatedFinding<T>[] {
	const remaining = new Map<string, T[]>();
	for (const finding of previous) {
		const identity = findingIdentity(finding);
		const bucket = remaining.get(identity);
		if (bucket) bucket.push(finding);
		else remaining.set(identity, [finding]);
	}

	/**
	 * The current run's order is preserved. The results view groups by type and
	 * `correlate` orders its own output, and deciding either of those here would
	 * take the decision away from the place that documents it.
	 */
	const annotated: AnnotatedFinding<T>[] = current.map((finding) => {
		const bucket = remaining.get(findingIdentity(finding));
		const matched = bucket?.shift();

		return { ...finding, status: matched ? "still_present" : "new" };
	});

	/** Whatever the current run did not account for is gone from the site. */
	for (const bucket of remaining.values()) {
		for (const finding of bucket) {
			annotated.push({ ...finding, status: "resolved" });
		}
	}

	return annotated;
}
