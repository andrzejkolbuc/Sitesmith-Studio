import { describe, expect, it } from "vitest";

import {
	type CoverageRun,
	coverageSentences,
	runCoverage,
	runStatusLabel,
} from "./coverage";

/** A run that covered everything and recorded that it did. */
const complete: CoverageRun = {
	status: "done",
	pagesCrawled: 120,
	crawlComplete: true,
	reachedPageLimit: false,
	scope: { includePaths: [], excludePaths: [], locales: ["en", "de"] },
	ruleSet: ["link_broken", "missing_locale"],
	renderSummary: { chosen: 12, measured: 12, cap: 12, complete: true },
	visualSummary: {
		baselineRunId: "r0",
		watched: 10,
		captured: 10,
		compared: 10,
		differing: 0,
		complete: true,
	},
};

const run = (overrides: Partial<CoverageRun>): CoverageRun => ({
	...complete,
	...overrides,
});

const LABELS = {
	queued: "Queued",
	running: "Crawling",
	done: "Complete",
	failed: "Stopped early",
	interrupted: "Interrupted",
};

describe("runCoverage — crawl", () => {
	it("reports the page ceiling ahead of mere incompleteness", () => {
		/*
		 * A ceiling hit also sets crawlComplete false, so both branches are true.
		 * "Stopped early" would be accurate and useless — it would not tell the
		 * reader the site is bigger than the check.
		 */
		const coverage = runCoverage(
			run({ crawlComplete: false, reachedPageLimit: true }),
		);

		expect(coverage.crawl).toEqual({ kind: "page_limit" });
	});

	it("separates a crawl that ended early from one that hit the ceiling", () => {
		const coverage = runCoverage(
			run({ crawlComplete: false, reachedPageLimit: false }),
		);

		expect(coverage.crawl).toEqual({ kind: "stopped_early" });
	});

	it("reports a complete crawl as complete", () => {
		expect(runCoverage(complete).crawl).toEqual({ kind: "whole_crawl" });
	});

	/**
	 * The distinction the module exists for. Null is not false and not true — a
	 * run from before the column existed, or one that died before recording it,
	 * has no answer, and inventing one is how the absence of a finding turns into
	 * a claim about the client's site.
	 */
	it("treats an unrecorded crawl as unknown, never as complete or incomplete", () => {
		const coverage = runCoverage(
			run({ crawlComplete: null, reachedPageLimit: null }),
		);

		expect(coverage.crawl).toEqual({ kind: "not_recorded" });
		expect(coverage.crawl.kind).not.toBe("whole_crawl");
		expect(coverage.crawl.kind).not.toBe("stopped_early");
	});

	it("does not infer completeness from the ceiling alone", () => {
		/*
		 * Knowing the crawl did not hit its limit says nothing about whether it
		 * finished for some other reason.
		 */
		const coverage = runCoverage(
			run({ crawlComplete: null, reachedPageLimit: false }),
		);

		expect(coverage.crawl).toEqual({ kind: "not_recorded" });
	});
});

describe("runCoverage — scope, rules and samples", () => {
	it("reads an unrecorded scope as unknown rather than as the whole site", () => {
		expect(runCoverage(run({ scope: null })).scope).toEqual({
			kind: "not_recorded",
		});
	});

	it("treats an unnarrowed scope as the whole site", () => {
		expect(runCoverage(complete).scope).toEqual({ kind: "whole_site" });
	});

	it("carries the narrowing so the reader can see what was left out", () => {
		const coverage = runCoverage(
			run({
				scope: {
					includePaths: ["/docs"],
					excludePaths: ["/admin"],
					locales: ["en"],
				},
			}),
		);

		expect(coverage.scope).toEqual({
			kind: "narrowed",
			includePaths: ["/docs"],
			excludePaths: ["/admin"],
			locales: ["en"],
		});
	});

	it("reads an unrecorded rule set as unknown", () => {
		expect(runCoverage(run({ ruleSet: null })).rules).toEqual({
			kind: "not_recorded",
		});
	});

	it("counts the rules that could have fired", () => {
		expect(runCoverage(complete).rules).toEqual({ kind: "recorded", count: 2 });
	});

	it("distinguishes an unrecorded render pass from one that could not run", () => {
		expect(runCoverage(run({ renderSummary: null })).sample).toEqual({
			kind: "not_recorded",
		});

		expect(
			runCoverage(
				run({
					renderSummary: { chosen: 0, measured: 0, cap: 12, complete: false },
				}),
			).sample,
		).toEqual({ kind: "unavailable" });
	});

	it("carries the sample against what was crawled", () => {
		expect(runCoverage(complete).sample).toEqual({
			kind: "sampled",
			measured: 12,
			crawled: 120,
		});
	});

	it("distinguishes an unrecorded visual pass from an unpinned baseline", () => {
		expect(runCoverage(run({ visualSummary: null })).pictures).toEqual({
			kind: "not_recorded",
		});

		expect(
			runCoverage(
				run({
					visualSummary: {
						baselineRunId: null,
						watched: 0,
						captured: 0,
						compared: 0,
						differing: 0,
						complete: true,
					},
				}),
			).pictures,
		).toEqual({ kind: "no_baseline" });
	});
});

describe("coverageSentences", () => {
	/**
	 * A block that always appears is a block nobody reads, and a clean run made
	 * to look qualified is its own kind of dishonesty.
	 */
	it("says nothing about a run that covered everything and recorded it", () => {
		expect(coverageSentences(runCoverage(complete))).toEqual([]);
	});

	it("says the site is larger than the check when the ceiling was hit", () => {
		const sentences = coverageSentences(
			runCoverage(run({ crawlComplete: false, reachedPageLimit: true })),
		);

		expect(sentences).toHaveLength(1);
		expect(sentences[0]).toContain("page limit");
		expect(sentences[0]).toContain("larger than what was looked at");
	});

	it("warns that some checks do not run on a partial crawl", () => {
		/*
		 * The load-bearing sentence. A truncated crawl reports fewer findings, and
		 * without this the reader reads that as a healthier site.
		 */
		for (const partial of [
			run({ crawlComplete: false, reachedPageLimit: true }),
			run({ crawlComplete: false, reachedPageLimit: false }),
		]) {
			expect(coverageSentences(runCoverage(partial))[0]).toContain(
				"do not run on a partial crawl",
			);
		}
	});

	it("states an unrecorded rule set as an ambiguity rather than a silence", () => {
		const sentences = coverageSentences(runCoverage(run({ ruleSet: null })));

		expect(sentences).toHaveLength(1);
		expect(sentences[0]).toContain("may mean it did not run");
	});

	it("names what a narrowed scope was limited to and what it excluded", () => {
		const sentences = coverageSentences(
			runCoverage(
				run({
					scope: {
						includePaths: ["/docs"],
						excludePaths: ["/admin"],
						locales: [],
					},
				}),
			),
		);

		expect(sentences).toHaveLength(1);
		expect(sentences[0]).toContain("/docs");
		expect(sentences[0]).toContain("/admin");
	});

	it("stacks every condition that applies", () => {
		const sentences = coverageSentences(
			runCoverage(
				run({
					crawlComplete: false,
					reachedPageLimit: true,
					ruleSet: null,
					scope: {
						includePaths: ["/docs"],
						excludePaths: [],
						locales: [],
					},
				}),
			),
		);

		expect(sentences).toHaveLength(3);
	});

	it("does not restate what the sampled sections already say for themselves", () => {
		/*
		 * Performance and appearance each carry their own coverage line a few
		 * hundred pixels below this block. Saying it twice on one screen trains the
		 * reader to skip both.
		 */
		const sentences = coverageSentences(
			runCoverage(
				run({
					renderSummary: null,
					visualSummary: null,
				}),
			),
		);

		expect(sentences).toEqual([]);
	});
});

describe("runStatusLabel", () => {
	/**
	 * The badge is the most-read element on the page. A run that stopped at its
	 * ceiling sets no abort reason and so closes as `done`; left alone it tells
	 * the reader their whole site was checked.
	 */
	it("refuses to call a run that hit its page limit complete", () => {
		expect(
			runStatusLabel(
				run({ status: "done", crawlComplete: false, reachedPageLimit: true }),
				LABELS,
			),
		).toBe("Stopped at page limit");
	});

	it("marks a done-but-incomplete run as partial", () => {
		expect(
			runStatusLabel(
				run({ status: "done", crawlComplete: false, reachedPageLimit: false }),
				LABELS,
			),
		).toBe("Partial");
	});

	it("leaves a genuinely complete run alone", () => {
		expect(runStatusLabel(complete, LABELS)).toBe("Complete");
	});

	it("does not second-guess a run that never claimed completeness", () => {
		expect(
			runStatusLabel(
				run({
					status: "failed",
					crawlComplete: false,
					reachedPageLimit: false,
				}),
				LABELS,
			),
		).toBe("Stopped early");
	});

	it("says nothing new about a run whose completeness was not recorded", () => {
		expect(
			runStatusLabel(
				run({ status: "done", crawlComplete: null, reachedPageLimit: null }),
				LABELS,
			),
		).toBe("Complete");
	});

	it("falls back to the raw status for a value it has no word for", () => {
		expect(runStatusLabel(run({ status: "unheard_of" }), LABELS)).toBe(
			"unheard_of",
		);
	});
});
