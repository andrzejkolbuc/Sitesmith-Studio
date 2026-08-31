import { describe, expect, it } from "vitest";

import { buildParity, type ParityPage } from "./parity";

/**
 * The grid is the one screen that claims to summarise a whole site at a glance,
 * which makes a wrong cell worse than a wrong finding: a finding is read once,
 * a grid is trusted repeatedly.
 *
 * The cases below are about what a cell is allowed to claim. In particular a
 * blank must never mean two different things — "this language is fine" and
 * "this language was never asked for" have to be distinguishable, or the grid
 * quietly turns a monolingual site into a wall of gaps.
 */

const B = "https://shop.test";

const page = (
	path: string,
	locale: string | null,
	group: string,
	status = 200,
): ParityPage => ({
	url: `${B}${path}`,
	locale,
	variantGroupKey: `${B}${group}`,
	httpStatus: status,
	fetchError: null,
});

describe("buildParity", () => {
	it("puts the project's languages first and appends what it also found", () => {
		/**
		 * A configured list is a priority order, not a set. An operator writing
		 * "en, de, fr" has said which language matters most, and re-sorting that
		 * alphabetically would discard information they took the trouble to give.
		 */
		const parity = buildParity(
			[
				page("/en", "en", "/en"),
				page("/de", "de", "/en"),
				page("/it", "it", "/en"),
			],
			["en", "de"],
		);

		expect(parity.locales).toEqual(["en", "de", "it"]);
	});

	it("marks a language the project expects and the family does not publish", () => {
		const parity = buildParity(
			[page("/en", "en", "/en"), page("/de", "de", "/en")],
			["en", "de", "fr"],
		);

		expect(parity.rows[0]?.cells).toEqual(["present", "present", "missing"]);
		expect(parity.rows[0]?.hasProblem).toBe(true);
	});

	it("does not call a language missing when nobody asked for it", () => {
		/**
		 * The distinction the whole grid rests on. A site that publishes English and
		 * German, checked by a project that expects English and German, is complete
		 * — even though it publishes no Italian. If an unasked-for column read as a
		 * gap, every monolingual site would render as a wall of marks.
		 */
		const parity = buildParity(
			[
				page("/en", "en", "/en"),
				page("/de", "de", "/en"),
				page("/it/solo", "it", "/it/solo"),
			],
			["en", "de"],
		);

		const family = parity.rows.find((r) => r.groupKey === `${B}/en`);

		/**
		 * Three columns, because the site turned out to publish Italian somewhere
		 * else — but this family is complete all the same. The Italian cell says
		 * "not-expected", which the grid draws as nothing, rather than "missing".
		 */
		expect(family?.cells).toEqual(["present", "present", "not-expected"]);
		expect(family?.hasProblem).toBe(false);
	});

	it("marks a variant that answered with an error", () => {
		const parity = buildParity(
			[page("/en", "en", "/en"), page("/de", "de", "/en", 404)],
			["en", "de"],
		);

		expect(parity.rows[0]?.cells).toEqual(["present", "broken"]);
	});

	it("accepts a regional variant as answering the language it refines", () => {
		/**
		 * Matches the detection rules rather than diverging from them: a site
		 * publishing en-gb publishes English. A grid that disagreed with the
		 * findings list would leave the reader to work out which one was lying.
		 */
		const parity = buildParity(
			[page("/en-gb", "en-gb", "/en-gb"), page("/de", "de", "/en-gb")],
			["en", "de"],
		);

		expect(parity.rows[0]?.cells).toEqual(["present", "present"]);
		expect(parity.locales).toEqual(["en", "de"]);
	});

	it("sorts families with problems above families without", () => {
		const parity = buildParity(
			[
				page("/a", "en", "/a"),
				page("/a/de", "de", "/a"),
				page("/b", "en", "/b"),
				page("/b/de", "de", "/b", 404),
			],
			["en", "de"],
		);

		expect(parity.rows[0]?.groupKey).toBe(`${B}/b`);
		expect(parity.rows[0]?.hasProblem).toBe(true);
	});

	it("caps the list without ever hiding a problem", () => {
		/**
		 * The cap exists so a large site stays readable, and it is only safe because
		 * problems sort first. If a hidden row could carry a mark, the grid would be
		 * claiming a site is healthier than it is.
		 */
		const pages: ParityPage[] = [];
		for (let i = 0; i < 30; i++) {
			pages.push(page(`/clean-${i}`, "en", `/clean-${i}`));
			pages.push(page(`/clean-${i}/de`, "de", `/clean-${i}`));
		}
		pages.push(page("/broken", "en", "/broken"));
		pages.push(page("/broken/de", "de", "/broken", 404));

		const parity = buildParity(pages, ["en", "de"], 5);

		expect(parity.rows).toHaveLength(5);
		expect(parity.hidden).toBe(26);
		expect(parity.rows.filter((r) => r.hasProblem)).toHaveLength(1);
		expect(parity.rows[0]?.groupKey).toBe(`${B}/broken`);
		expect(parity.clean).toBe(30);
	});

	it("survives a page the crawl could not place in a family", () => {
		/**
		 * `variantGroupKey` is filled in after the crawl, so a row can exist without
		 * one if a run was interrupted between writing pages and grouping them. The
		 * page becomes its own family rather than crashing the screen.
		 */
		const orphan: ParityPage = {
			url: `${B}/loose`,
			locale: "en",
			variantGroupKey: null,
			httpStatus: 200,
			fetchError: null,
		};

		const parity = buildParity([orphan], ["en"]);

		/**
		 * Keyed by its own URL rather than crashing, and then counted as a page
		 * with no variants rather than drawn as a row missing everything.
		 */
		expect(parity.rows).toEqual([]);
		expect(parity.singles).toBe(1);
	});

	it("treats a page that never answered as broken, not absent", () => {
		const timedOut: ParityPage = {
			url: `${B}/de`,
			locale: "de",
			variantGroupKey: `${B}/en`,
			httpStatus: null,
			fetchError: "socket hang up",
		};

		const parity = buildParity(
			[page("/en", "en", "/en"), timedOut],
			["en", "de"],
		);

		expect(parity.rows[0]?.cells).toEqual(["present", "broken"]);
	});
});

describe("families that are not parity subjects", () => {
	/**
	 * Caught by looking at the screen rather than by reasoning about it.
	 *
	 * The fixture's `/blog/monolingual` is the negative case for the whole rule
	 * set: no hreflang, no locale in its URL, and every rule is built to stay
	 * silent about it. The findings list did. The grid drew three "missing" marks
	 * next to it — contradicting the findings on the same screen, and leaving a
	 * reader to work out which half of their own results page was lying.
	 *
	 * The rules already answer this: a family of one is not evidence that
	 * translations were ever expected, which is why rule 1 carries a two-member
	 * guard. The grid needs the same one, or it re-invents a false positive the
	 * detection side fixed three times.
	 */
	it("leaves out a page that has no variants at all", () => {
		const parity = buildParity(
			[
				page("/en", "en", "/en"),
				page("/de", "de", "/en"),
				{
					url: `${B}/blog/monolingual`,
					locale: null,
					variantGroupKey: `${B}/blog/monolingual`,
					httpStatus: 200,
					fetchError: null,
				},
			],
			["en", "de", "fr"],
		);

		expect(parity.rows.map((r) => r.groupKey)).toEqual([`${B}/en`]);
	});

	it("counts the pages it left out rather than dropping them silently", () => {
		/**
		 * A grid that quietly showed eight of twenty families would overstate how
		 * much of the site it had just described.
		 */
		const parity = buildParity(
			[
				page("/en", "en", "/en"),
				page("/de", "de", "/en"),
				page("/lonely", "en", "/lonely"),
				page("/also-lonely", "de", "/also-lonely"),
			],
			["en", "de"],
		);

		expect(parity.rows).toHaveLength(1);
		expect(parity.singles).toBe(2);
	});

	it("still includes a family whose only sibling is broken", () => {
		/**
		 * The boundary. A declared variant that 404s was still crawled, so the
		 * family has two members and is exactly the case worth drawing.
		 */
		const parity = buildParity(
			[page("/en", "en", "/en"), page("/de", "de", "/en", 404)],
			["en", "de"],
		);

		expect(parity.rows).toHaveLength(1);
		expect(parity.rows[0]?.cells).toEqual(["present", "broken"]);
	});
});
