/**
 * The parity grid: families down, languages across.
 *
 * This is the spreadsheet an agency builds by hand — one row per page, one
 * column per language, a mark where a translation is missing or broken — and it
 * is the question the product exists to answer, asked in one picture instead of
 * one finding at a time.
 *
 * It runs entirely on rows the crawl already stores. Every page is written with
 * its locale and the family it belongs to; until now nothing displayed either.
 *
 * Pure, so the shape of the answer can be tested without a browser. The cell
 * vocabulary is deliberately small: a page is there, or it is broken, or it is
 * expected and absent, or it was never expected at all. The last of those must
 * render as nothing, because a site that does not publish Portuguese is not
 * missing Portuguese.
 */

export type Cell = "present" | "broken" | "missing" | "not-expected";

export type ParityRow = {
	/** The family, named by the page the crawl treats as its key. */
	groupKey: string;
	/** One cell per column, in the same order as `locales`. */
	cells: Cell[];
	/** Whether anything in this row needs attention. */
	hasProblem: boolean;
};

export type Parity = {
	/** Column order: what the project asked for first, then what it also found. */
	locales: string[];
	rows: ParityRow[];
	/** Families not shown because the list was capped. */
	hidden: number;
	/** Pages with no variants at all, which are not parity subjects. */
	singles: number;
	/** Families with nothing wrong, whether shown or not. */
	clean: number;
};

export type ParityPage = {
	url: string;
	locale: string | null;
	variantGroupKey: string | null;
	httpStatus: number | null;
	fetchError: string | null;
};

/**
 * How many families to draw before summarising the rest.
 *
 * A two-hundred-page site has too many rows to read, and a grid nobody reads is
 * worse than no grid. Problem rows sort first, so the cap only ever hides
 * families that were fine.
 */
export const MAX_ROWS = 14;

const broken = (page: ParityPage): boolean =>
	page.fetchError !== null ||
	page.httpStatus === null ||
	page.httpStatus >= 400;

/** Whether a present locale answers a column, allowing regional refinements. */
const answers = (present: string, column: string): boolean =>
	present === column || present.startsWith(`${column}-`);

export function buildParity(
	pages: ParityPage[],
	expectedLocales: string[],
	limit: number = MAX_ROWS,
): Parity {
	const expected = expectedLocales.map((l) => l.toLowerCase());

	const families = new Map<string, ParityPage[]>();
	for (const page of pages) {
		const key = page.variantGroupKey ?? page.url;
		families.set(key, [...(families.get(key) ?? []), page]);
	}

	/**
	 * Columns are what the project asked for, then anything the site turned out to
	 * publish as well. Configured order is kept because an operator listing
	 * "en, de, fr" is describing a priority, and re-sorting it alphabetically
	 * would throw that away.
	 */
	const found = new Set<string>();
	for (const page of pages) if (page.locale) found.add(page.locale);

	const extra = [...found]
		.filter((l) => !expected.some((e) => answers(l, e)))
		.sort();
	const locales = [...expected, ...extra];

	const rows: ParityRow[] = [];
	let clean = 0;
	let singles = 0;

	for (const [groupKey, members] of families) {
		/**
		 * A page with no siblings is not a parity subject, and the detection rules
		 * already say so — rule 1 carries the same two-member guard, added after it
		 * fired seven times where two was correct.
		 *
		 * Without this the grid marks every lone page as missing every language,
		 * including the ones the rules are built to stay silent about, and then
		 * contradicts the findings list sitting directly beneath it.
		 */
		if (members.length < 2) {
			singles += 1;
			continue;
		}

		const cells = locales.map((column): Cell => {
			const page = members.find(
				(m) => m.locale !== null && answers(m.locale, column),
			);
			if (page) return broken(page) ? "broken" : "present";
			// Only a column the project asked for can be *missing*; the rest are
			// simply languages this site does not publish.
			return expected.includes(column) ? "missing" : "not-expected";
		});

		const hasProblem = cells.some((c) => c === "broken" || c === "missing");
		if (!hasProblem) clean += 1;
		rows.push({ groupKey, cells, hasProblem });
	}

	/** Problems first, then alphabetical, so the cap never hides a problem. */
	rows.sort(
		(a, b) =>
			Number(b.hasProblem) - Number(a.hasProblem) ||
			a.groupKey.localeCompare(b.groupKey),
	);

	const shown = rows.slice(0, Math.max(1, limit));

	return {
		locales,
		rows: shown,
		hidden: rows.length - shown.length,
		singles,
		clean,
	};
}
