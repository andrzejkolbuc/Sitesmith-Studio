import { describe, expect, it } from "vitest";

import {
	type ComparableRun,
	comparability,
	compareFindings,
	type StoredFinding,
} from "./comparison";

const scope = (over: Partial<NonNullable<ComparableRun["scope"]>> = {}) => ({
	includePaths: [],
	excludePaths: ["/private"],
	locales: ["en", "de"],
	...over,
});

const complete = (over: Partial<ComparableRun> = {}): ComparableRun => ({
	crawlComplete: true,
	scope: scope(),
	...over,
});

/** A stored finding, named so the assertions read as the story they tell. */
const link = (id: string, target: string, over: Record<string, unknown> = {}) =>
	({
		id,
		type: "link_broken",
		detail: { target, httpStatus: 404, linkedFrom: [], ...over },
	}) satisfies StoredFinding;

describe("comparability", () => {
	it("allows two complete runs of the same scope", () => {
		expect(comparability(complete(), complete())).toEqual({ comparable: true });
	});

	/**
	 * The pre-existing runs in every database this ships to. Their completeness
	 * and scope were never observed, and the honest handling of an unobserved
	 * condition is to decline rather than to assume the favourable one.
	 */
	it("refuses when either run recorded nothing", () => {
		expect(
			comparability(complete({ crawlComplete: null }), complete()),
		).toEqual({ comparable: false, reason: "not_recorded" });

		expect(comparability(complete(), complete({ scope: null }))).toEqual({
			comparable: false,
			reason: "not_recorded",
		});
	});

	/**
	 * A truncated crawl breaks the comparison in both directions: a finding
	 * missing from it may live in the part never visited, and one present in it
	 * may have been present before in a part the other run missed.
	 */
	it("refuses when either crawl did not finish", () => {
		expect(
			comparability(complete({ crawlComplete: false }), complete()),
		).toEqual({ comparable: false, reason: "incomplete_crawl" });

		expect(
			comparability(complete(), complete({ crawlComplete: false })),
		).toEqual({ comparable: false, reason: "incomplete_crawl" });
	});

	/**
	 * The case this guard was written for: the 472-page project narrowed to two
	 * pages between runs. Without this, four hundred and seventy findings would
	 * report as fixed.
	 */
	it("refuses when the crawl scope changed", () => {
		expect(
			comparability(
				complete(),
				complete({ scope: scope({ includePaths: ["/handbook"] }) }),
			),
		).toEqual({ comparable: false, reason: "scope_changed" });
	});

	/**
	 * Expected locales are an instruction too. A project that stops expecting
	 * French stops being able to report French missing, and every one of those
	 * findings would otherwise read as resolved.
	 */
	it("refuses when the expected locales changed", () => {
		expect(
			comparability(
				complete(),
				complete({ scope: scope({ locales: ["en"] }) }),
			),
		).toEqual({ comparable: false, reason: "scope_changed" });
	});

	it("does not treat a reordered scope as a change", () => {
		expect(
			comparability(
				complete({ scope: scope({ locales: ["en", "de"] }) }),
				complete({ scope: scope({ locales: ["de", "en"] }) }),
			),
		).toEqual({ comparable: true });
	});

	/**
	 * Most fundamental first: a run that recorded nothing cannot also be judged on
	 * a scope it does not have, so the reader is given the reason they must fix
	 * before the others become meaningful.
	 */
	it("reports the most fundamental reason when several apply", () => {
		expect(
			comparability(
				complete({ crawlComplete: null, scope: null }),
				complete({ crawlComplete: false, scope: scope({ locales: ["fr"] }) }),
			),
		).toEqual({ comparable: false, reason: "not_recorded" });
	});
});

describe("compareFindings", () => {
	/**
	 * The property the whole slice is judged on. Two runs over a site nobody
	 * touched must report nothing as new and nothing as resolved — anything else
	 * is the product inventing a change.
	 */
	it("reports an unchanged set as entirely still present", () => {
		const before = [link("a", "https://x.test/gone")];
		const after = [link("b", "https://x.test/gone")];

		const result = compareFindings(before, after);

		expect(result).toHaveLength(1);
		expect(result[0]?.status).toBe("still_present");
	});

	it("reports an added finding as new", () => {
		const result = compareFindings(
			[link("a", "https://x.test/gone")],
			[link("b", "https://x.test/gone"), link("c", "https://x.test/also-gone")],
		);

		expect(result.filter((f) => f.status === "new").map((f) => f.id)).toEqual([
			"c",
		]);
		expect(result.filter((f) => f.status === "resolved")).toEqual([]);
	});

	it("reports a removed finding as resolved, carrying the older row", () => {
		const result = compareFindings(
			[link("a", "https://x.test/gone"), link("b", "https://x.test/fixed")],
			[link("c", "https://x.test/gone")],
		);

		const resolved = result.filter((f) => f.status === "resolved");
		expect(resolved).toHaveLength(1);
		// The previous run's row, since the current run has none to carry.
		expect(resolved[0]?.id).toBe("b");
		expect(resolved[0]?.detail.target).toBe("https://x.test/fixed");
	});

	/**
	 * The reason identity is a projection rather than a deep equality. Everything
	 * moved here except the dead URL, and the reader is told the problem is still
	 * standing rather than that one was fixed and another appeared.
	 */
	it("reports a finding whose evidence moved as still present", () => {
		const result = compareFindings(
			[link("a", "https://x.test/gone", { httpStatus: 500, linkedFrom: [] })],
			[
				link("b", "https://x.test/gone", {
					httpStatus: 503,
					linkedFrom: ["https://x.test/new-page"],
				}),
			],
		);

		expect(result).toHaveLength(1);
		expect(result[0]?.status).toBe("still_present");
	});

	it("keeps the current run's order and appends resolved findings", () => {
		const result = compareFindings(
			[link("old", "https://x.test/fixed")],
			[link("a", "https://x.test/one"), link("b", "https://x.test/two")],
		);

		expect(result.map((f) => f.id)).toEqual(["a", "b", "old"]);
	});

	/**
	 * Duplicates within one run are matched one-for-one rather than as sets. The
	 * rules are not supposed to emit them, but a comparison that silently loses
	 * count if they do would hide that fact rather than surface it.
	 */
	it("matches same-identity findings pairwise", () => {
		const result = compareFindings(
			[
				link("a", "https://x.test/gone"),
				link("b", "https://x.test/gone"),
				link("c", "https://x.test/gone"),
			],
			[link("d", "https://x.test/gone")],
		);

		expect(result.filter((f) => f.status === "still_present")).toHaveLength(1);
		expect(result.filter((f) => f.status === "resolved")).toHaveLength(2);
	});

	it("reports everything as new against an empty previous run", () => {
		const result = compareFindings([], [link("a", "https://x.test/gone")]);

		expect(result.map((f) => f.status)).toEqual(["new"]);
	});

	it("reports everything as resolved when the current run is clean", () => {
		const result = compareFindings([link("a", "https://x.test/gone")], []);

		expect(result.map((f) => f.status)).toEqual(["resolved"]);
	});
});
