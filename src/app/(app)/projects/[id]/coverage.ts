/**
 * What a run actually covered, and where it stopped.
 *
 * Split out for the reason `performance.ts` and `visual.ts` were: the decisions
 * are small enough to look obviously correct, which is exactly the kind of thing
 * that turns out not to be.
 *
 * Those two modules already refuse to overstate what they looked at, because a
 * sample is a claim about coverage. The crawl never got the same treatment — its
 * completeness columns exist to serve `comparability()`, which needs a *pair* of
 * runs, and a reader looking at one run inherits none of it. The consequence is
 * live: a crawl that stops at the page ceiling silences rules across two dozen
 * gates in `findings.ts`, so it reports *fewer* problems, and the run still says
 * "Complete". Absence of a finding then reads as a statement about the site when
 * it is a statement about us.
 *
 * Every column read here is nullable, and `null` means *not recorded* — a run
 * from before the column existed, or one that died before the closing update.
 * Defaulting any of them to `false` would assert the incomplete case, and
 * defaulting to `true` would assert the complete one. Neither is known, so
 * neither is said. That three-state discipline is the whole point of this file.
 */

import type { RenderSummary } from "./performance";
import type { VisualSummary } from "./visual";

/** The subset of a run row this module reads. Both `latestRun` and the history rows satisfy it. */
export type CoverageRun = {
	status: string;
	pagesCrawled: number;
	crawlComplete: boolean | null;
	reachedPageLimit: boolean | null;
	scope: {
		includePaths: string[];
		excludePaths: string[];
		locales: string[];
	} | null;
	ruleSet: string[] | null;
	renderSummary: RenderSummary;
	visualSummary: VisualSummary;
};

export type CrawlCoverage =
	/** Neither completeness column was written. Nothing is claimed either way. */
	| { kind: "not_recorded" }
	| { kind: "whole_crawl" }
	/** Stopped at the page ceiling. The site is larger than what was checked. */
	| { kind: "page_limit" }
	/** Ended before it ran out of pages — aborted, interrupted, or failed. */
	| { kind: "stopped_early" };

export type ScopeCoverage =
	| { kind: "not_recorded" }
	| { kind: "whole_site" }
	| {
			kind: "narrowed";
			includePaths: string[];
			excludePaths: string[];
			locales: string[];
	  };

export type RulesCoverage =
	/**
	 * Which checks ran is unrecoverable for this run.
	 *
	 * Worth saying out loud rather than skipping: without it, a check type with no
	 * findings is ambiguous between "nothing was wrong" and "we were not looking",
	 * and only the first is a statement about the site.
	 */
	{ kind: "not_recorded" } | { kind: "recorded"; count: number };

export type SampleCoverage =
	| { kind: "not_recorded" }
	| { kind: "unavailable" }
	| { kind: "nothing_measured" }
	| { kind: "sampled"; measured: number; crawled: number };

export type PictureCoverage =
	| { kind: "not_recorded" }
	| { kind: "unavailable" }
	| { kind: "no_baseline" }
	| { kind: "nothing_watched" }
	| { kind: "watched"; compared: number; crawled: number };

export type RunCoverage = {
	crawl: CrawlCoverage;
	scope: ScopeCoverage;
	rules: RulesCoverage;
	sample: SampleCoverage;
	pictures: PictureCoverage;
};

function crawlCoverage(run: CoverageRun): CrawlCoverage {
	/*
	 * The ceiling is checked first because it is the more specific fact. A run
	 * that hit it also has `crawlComplete: false`, and "stopped early" would be
	 * true but useless — it would not tell the reader the site is bigger than the
	 * check.
	 */
	if (run.reachedPageLimit === true) return { kind: "page_limit" };
	if (run.crawlComplete === false) return { kind: "stopped_early" };
	if (run.crawlComplete === true) return { kind: "whole_crawl" };

	/*
	 * `crawlComplete` is null here. `reachedPageLimit === false` narrows nothing
	 * on its own — knowing the ceiling was not hit says nothing about whether the
	 * crawl finished for some other reason.
	 */
	return { kind: "not_recorded" };
}

function scopeCoverage(run: CoverageRun): ScopeCoverage {
	if (run.scope === null) return { kind: "not_recorded" };

	const { includePaths, excludePaths, locales } = run.scope;
	if (includePaths.length === 0 && excludePaths.length === 0) {
		return { kind: "whole_site" };
	}

	return { kind: "narrowed", includePaths, excludePaths, locales };
}

function sampleCoverage(run: CoverageRun): SampleCoverage {
	const summary = run.renderSummary;
	if (summary === null) return { kind: "not_recorded" };
	if (!summary.complete) return { kind: "unavailable" };
	if (summary.chosen === 0) return { kind: "nothing_measured" };

	return {
		kind: "sampled",
		measured: summary.measured,
		crawled: run.pagesCrawled,
	};
}

function pictureCoverage(run: CoverageRun): PictureCoverage {
	const summary = run.visualSummary;
	if (summary === null) return { kind: "not_recorded" };
	if (!summary.complete) return { kind: "unavailable" };
	if (summary.baselineRunId === null) return { kind: "no_baseline" };
	if (summary.watched === 0) return { kind: "nothing_watched" };

	return {
		kind: "watched",
		compared: summary.compared,
		crawled: run.pagesCrawled,
	};
}

export function runCoverage(run: CoverageRun): RunCoverage {
	return {
		crawl: crawlCoverage(run),
		scope: scopeCoverage(run),
		rules:
			run.ruleSet === null
				? { kind: "not_recorded" }
				: { kind: "recorded", count: run.ruleSet.length },
		sample: sampleCoverage(run),
		pictures: pictureCoverage(run),
	};
}

/**
 * What the run should say about its own coverage, above what it found.
 *
 * Deliberately narrower than `RunCoverage`. The sampled subsystems already state
 * their coverage in their own sections, a few hundred pixels below this — saying
 * it twice on one screen trains the reader to skip both. What is said here is
 * what has no other surface: where the crawl stopped, what it was scoped to, and
 * whether we know which checks ran.
 *
 * Returns an empty list for a run that covered everything and recorded that it
 * did. A clean run must not be made to look qualified; a block that always
 * appears is a block nobody reads.
 */
export function coverageSentences(coverage: RunCoverage): string[] {
	const out: string[] = [];

	switch (coverage.crawl.kind) {
		case "page_limit":
			out.push(
				"This check stopped at its page limit, so the site is larger than what was looked at. Some checks do not run on a partial crawl and report nothing here.",
			);
			break;
		case "stopped_early":
			out.push(
				"This check ended before it had seen the whole site. Some checks do not run on a partial crawl and report nothing here.",
			);
			break;
		case "not_recorded":
			out.push(
				"Whether this check reached the whole site was not recorded, so how much of the site this describes is unknown.",
			);
			break;
		case "whole_crawl":
			break;
	}

	if (coverage.scope.kind === "narrowed") {
		const { includePaths, excludePaths } = coverage.scope;
		const parts: string[] = [];
		if (includePaths.length > 0) {
			parts.push(`limited to ${includePaths.join(", ")}`);
		}
		if (excludePaths.length > 0) {
			parts.push(`excluding ${excludePaths.join(", ")}`);
		}
		out.push(
			`This check was scoped to part of the site — ${parts.join(", ")}.`,
		);
	}

	if (coverage.rules.kind === "not_recorded") {
		out.push(
			"Which checks ran was not recorded for this run, so a check type with nothing listed may mean it found nothing or may mean it did not run.",
		);
	}

	return out;
}

/**
 * The run's status in the reader's words.
 *
 * Derived from completeness rather than read straight off `status`, because a
 * run that stops at the page ceiling sets no abort reason and therefore closes
 * as `done`. Left alone, the most-read element on the page tells a reader their
 * site was fully checked when it was not.
 *
 * The status *value* is deliberately untouched. It is what `comparability()`,
 * the history list and the stale-run sweep all read, and widening the enum to
 * carry a presentational distinction would put the same fact in two places.
 */
export type StatusRun = Pick<
	CoverageRun,
	"status" | "crawlComplete" | "reachedPageLimit"
>;

export function runStatusLabel(
	run: StatusRun,
	labels: Record<string, string>,
): string {
	if (run.status === "done") {
		if (run.reachedPageLimit === true) return "Stopped at page limit";
		if (run.crawlComplete === false) return "Partial";
	}

	return labels[run.status] ?? run.status;
}
