import { describe, expect, it } from "vitest";

import type { ComparabilityReason } from "~/server/crawl/comparison";
import {
	comparisonState,
	newCount,
	REASON_HEADING,
	REASON_SENTENCE,
	splitResolved,
	spreadSentence,
	statusIndex,
} from "./comparison-view";

const REASONS: ComparabilityReason[] = [
	"not_recorded",
	"incomplete_crawl",
	"scope_changed",
];

describe("refusal wording", () => {
	/**
	 * Every reason must reach the reader as words. A reason added later with no
	 * sentence would render as an empty area, which is the unexplained absence
	 * the refusal exists to avoid.
	 */
	it("has a sentence and a heading for every reason", () => {
		for (const reason of REASONS) {
			expect(REASON_SENTENCE[reason]?.length ?? 0).toBeGreaterThan(20);
			expect(REASON_HEADING[reason]?.length ?? 0).toBeGreaterThan(0);
		}
	});

	it("says something different for each reason", () => {
		const sentences = REASONS.map((r) => REASON_SENTENCE[r]);
		expect(new Set(sentences).size).toBe(REASONS.length);
	});
});

describe("comparisonState", () => {
	it("treats a run with no predecessor as neither compared nor refused", () => {
		expect(comparisonState(null)).toEqual({ kind: "none" });
	});

	it("reports a comparable pair as compared", () => {
		expect(comparisonState({ comparable: true })).toEqual({ kind: "compared" });
	});

	it("carries the reason through a refusal", () => {
		expect(
			comparisonState({ comparable: false, reason: "scope_changed" }),
		).toEqual({ kind: "refused", reason: "scope_changed" });
	});
});

describe("splitResolved", () => {
	const row = (
		id: string,
		status: "new" | "still_present" | "resolved" | null,
	) => ({
		id,
		status,
	});

	it("holds resolved findings apart from live ones", () => {
		const { present, resolved } = splitResolved([
			row("a", "new"),
			row("b", "resolved"),
			row("c", "still_present"),
		]);

		expect(present.map((r) => r.id)).toEqual(["a", "c"]);
		expect(resolved.map((r) => r.id)).toEqual(["b"]);
	});

	it("treats unannotated findings as present", () => {
		const { present, resolved } = splitResolved([row("a", null)]);

		expect(present.map((r) => r.id)).toEqual(["a"]);
		expect(resolved).toEqual([]);
	});

	it("preserves the order within each group", () => {
		const { present } = splitResolved([
			row("a", "still_present"),
			row("b", "resolved"),
			row("c", "new"),
			row("d", "still_present"),
		]);

		expect(present.map((r) => r.id)).toEqual(["a", "c", "d"]);
	});
});

describe("newCount", () => {
	const index = statusIndex([
		{ id: "a", status: "new" as const },
		{ id: "b", status: "still_present" as const },
		{ id: "c", status: "new" as const },
		{ id: "d", status: null },
	]);

	it("counts only the new findings of a problem", () => {
		expect(newCount(["a", "b", "c"], index)).toBe(2);
	});

	it("counts nothing when a problem is entirely known", () => {
		expect(newCount(["b"], index)).toBe(0);
	});

	it("ignores ids it has no status for", () => {
		expect(newCount(["a", "unknown"], index)).toBe(1);
	});
});

describe("spreadSentence", () => {
	/**
	 * The case the sentence exists for: a known problem that has spread. The
	 * reader learns something the per-finding markers alone would make them count.
	 */
	it("reports a partly new problem", () => {
		expect(spreadSentence(3, 20)).toBe("3 of 20 new since the previous run");
	});

	/** Silent where the surrounding markers already say it. */
	it("says nothing when the whole problem is new", () => {
		expect(spreadSentence(20, 20)).toBeNull();
	});

	it("says nothing when none of it is new", () => {
		expect(spreadSentence(0, 20)).toBeNull();
	});
});
