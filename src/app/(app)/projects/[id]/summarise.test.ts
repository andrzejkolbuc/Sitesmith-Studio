import { describe, expect, it } from "vitest";

import {
	countPages,
	MAX_LISTED,
	pagesInvolved,
	summariseList,
} from "./summarise";

/**
 * The truncation rule, made checkable.
 *
 * The fixture site's families are small, so no crawl the test suite performs
 * ever produces a list long enough to truncate — which would have left the
 * "states how many were not shown" criterion asserting nothing. Extracted and
 * tested here rather than left to a manual glance at a screen that cannot
 * currently show the case.
 */

const list = (n: number) => Array.from({ length: n }, (_, i) => `item ${i}`);

describe("summariseList", () => {
	it("shows everything when the list is short enough", () => {
		const { shown, hidden } = summariseList(list(3));

		expect(shown).toHaveLength(3);
		expect(hidden).toBe(0);
	});

	it("shows everything at exactly the limit", () => {
		/**
		 * The boundary that decides whether a reader is told "and 0 more". Off by
		 * one here produces a finding that claims to be hiding nothing while saying
		 * so, which reads as a bug in the tool.
		 */
		const { shown, hidden } = summariseList(list(MAX_LISTED));

		expect(shown).toHaveLength(MAX_LISTED);
		expect(hidden).toBe(0);
	});

	it("counts exactly what it left out", () => {
		const { shown, hidden } = summariseList(list(12));

		expect(shown).toHaveLength(MAX_LISTED);
		expect(hidden).toBe(12 - MAX_LISTED);
		// The two together must account for the whole list, or the count misleads.
		expect(shown.length + hidden).toBe(12);
	});

	it("keeps the order it was given", () => {
		/**
		 * The entries arrive sorted so that two runs over the same site produce
		 * comparable output. Reordering here would break that at the last step.
		 */
		const { shown } = summariseList(["c", "a", "b"], 2);

		expect(shown).toEqual(["c", "a"]);
	});

	it("handles an empty list without claiming anything is hidden", () => {
		expect(summariseList([])).toEqual({ shown: [], hidden: 0 });
	});

	it("never hides everything, however small the limit", () => {
		/**
		 * A limit of zero would render nothing but a count, telling the reader a
		 * number and no page they could act on.
		 */
		const { shown, hidden } = summariseList(list(4), 0);

		expect(shown).toHaveLength(1);
		expect(hidden).toBe(3);
	});
});

describe("pagesInvolved", () => {
	const B = "https://shop.test";

	it("counts every member of a family-level finding", () => {
		/**
		 * The reason this exists. One finding, six pages — a count of findings
		 * alone would tell the reader this problem touches one page.
		 */
		expect(
			pagesInvolved({
				type: "hreflang_family_inconsistent",
				url: null,
				detail: { memberUrls: [`${B}/a`, `${B}/b`, `${B}/c`] },
			}),
		).toHaveLength(3);
	});

	it("counts both ends of a broken declaration", () => {
		/**
		 * Two pages are implicated: the one carrying the link, which is where the
		 * fix goes, and the one it points at.
		 */
		expect(
			pagesInvolved({
				type: "hreflang_target_failed",
				url: `${B}/en`,
				detail: { declaredBy: `${B}/en`, target: `${B}/de` },
			}),
		).toEqual([`${B}/en`, `${B}/de`]);
	});

	it("counts the declarers and the broken page of a divergence", () => {
		expect(
			pagesInvolved({
				type: "variant_diverged",
				url: null,
				detail: {
					declaredBy: [`${B}/en`, `${B}/de`],
					brokenUrl: `${B}/fr`,
				},
			}),
		).toHaveLength(3);
	});

	it("falls back to the page a finding names when its type is unknown", () => {
		/**
		 * A rule added later and not listed here would otherwise report as
		 * affecting no pages, which reads as a problem that touches nothing.
		 */
		expect(
			pagesInvolved({ type: "something_new", url: `${B}/x`, detail: {} }),
		).toEqual([`${B}/x`]);
	});

	it("survives a detail that is missing or the wrong shape", () => {
		/**
		 * Detail is jsonb written by whatever produced the run, including runs
		 * recorded before a field existed. A crash here would take down the whole
		 * results screen over one malformed row.
		 */
		expect(
			pagesInvolved({ type: "missing_locale", url: null, detail: {} }),
		).toEqual([]);
		expect(
			pagesInvolved({
				type: "missing_locale",
				url: null,
				detail: { memberUrls: "not an array" },
			}),
		).toEqual([]);
	});
});

describe("countPages", () => {
	const B = "https://shop.test";

	it("counts a page once however many findings name it", () => {
		/**
		 * Two problems on overlapping pages is three pages affected, not four. The
		 * number is meant to answer "how much of my site is this", so double
		 * counting would overstate it.
		 */
		expect(
			countPages([
				{ type: "no_hreflang", url: null, detail: { url: `${B}/a` } },
				{
					type: "hreflang_family_inconsistent",
					url: null,
					detail: { memberUrls: [`${B}/a`, `${B}/b`, `${B}/c`] },
				},
			]),
		).toBe(3);
	});
});

describe("pagesInvolved for content findings", () => {
	const B = "https://shop.test";

	it("counts every page sharing identical content", () => {
		/**
		 * The group-level shape. One finding, three pages — counting only the one it
		 * names would report a problem spanning a whole family as touching nothing,
		 * because this kind carries no `url` at all.
		 */
		expect(
			pagesInvolved({
				type: "content_untranslated",
				url: null,
				detail: {
					kind: "identical_to_siblings",
					urls: [`${B}/en`, `${B}/de`, `${B}/fr`],
				},
			}),
		).toHaveLength(3);
	});

	it("counts the single page a marker finding names", () => {
		expect(
			pagesInvolved({
				type: "content_untranslated",
				url: `${B}/draft`,
				detail: { kind: "placeholder_markers", url: `${B}/draft` },
			}),
		).toEqual([`${B}/draft`]);
	});
});

describe("pagesInvolved for a structure difference", () => {
	it("counts every member of the family it compared", () => {
		expect(
			pagesInvolved({
				type: "content_structure_differs",
				url: null,
				detail: {
					memberUrls: [
						"https://shop.test/en",
						"https://shop.test/de",
						"https://shop.test/fr",
					],
				},
			}),
		).toHaveLength(3);
	});
});

describe("pagesInvolved for metadata findings", () => {
	const B = "https://shop.test";

	it("counts every page carrying a duplicated string", () => {
		/**
		 * A duplicate is a problem about a set of pages, and this kind carries no
		 * `url` at all — so without a case here it would fall through to the
		 * default and report a problem touching nothing, which is the failure this
		 * mapping exists to prevent.
		 */
		expect(
			pagesInvolved({
				type: "metadata_duplicated",
				url: null,
				detail: {
					field: "title",
					language: "en",
					value: "Legal information",
					urls: [`${B}/en/legal`, `${B}/en/privacy`, `${B}/en/terms`],
				},
			}),
		).toHaveLength(3);
	});

	it("counts the single page a missing-metadata finding names", () => {
		expect(
			pagesInvolved({
				type: "metadata_missing",
				url: `${B}/en/bare`,
				detail: { url: `${B}/en/bare`, fields: ["title", "description"] },
			}),
		).toEqual([`${B}/en/bare`]);
	});
});
