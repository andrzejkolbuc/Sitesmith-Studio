import { type Fixture, startFixtureSite } from "../test/fixtures/site";

/**
 * The crawlable site the journeys point at.
 *
 * Reuses the same fixture the unit tests crawl, so there is exactly one
 * description of what each finding means. If a rule changes, the fixture changes
 * once and both suites move together — two fixtures would drift, and the browser
 * suite would start asserting findings the rules no longer produce.
 *
 * Started per test rather than globally: an ephemeral port keeps journeys from
 * colliding, and a test that owns its server can stop it deterministically.
 */
export async function startCrawlableSite(): Promise<Fixture> {
	return startFixtureSite();
}

/**
 * Findings the fixture is built to produce, for a project expecting en/de/fr
 * with nothing excluded.
 *
 * Assertions name these rather than counting rows. A count breaks whenever a
 * rule is tuned and tells you nothing about which finding went missing; naming
 * the behaviour means a failure says what stopped being detected.
 */
export const EXPECTED = {
	/** `/contact` declares a German page that returns 404. */
	brokenVariant: {
		heading: "Declared variant is broken",
		locale: "de",
	},
	/** Families publishing en and de where the project also expects fr. */
	missingLocale: {
		heading: "Missing language variant",
		locale: "fr",
	},
	/** `/de/blog-post` is locale-shaped and declares no alternates. */
	noAlternates: {
		heading: "No language variants declared",
	},
	/**
	 * `/support`, `/de/hilfe` and `/fr/aide` do not all point at each other —
	 * each is declared by a sibling it does not declare back.
	 */
	inconsistentLinks: {
		heading: "Language links that disagree",
		/**
		 * The line the finding must produce, asserted whole rather than by page
		 * name: a page name appears both as the page to fix and as a sibling, and
		 * matching either would pass on output that named the page without saying
		 * what to do about it.
		 */
		instruction: "does not link back to /support",
	},
	/**
	 * `/careers` and `/de/karriere` both declare a French page that 404s. Two
	 * declarers is the threshold at which the per-URL reports collapse into one.
	 */
	divergedVariant: {
		heading: "One variant broken, its siblings fine",
		locale: "fr",
	},
	/**
	 * The negative case. `/blog/monolingual` has no hreflang and no locale in its
	 * URL, and must produce nothing at all — this is the guard on the narrowing
	 * that keeps ordinary single-language pages quiet.
	 */
	silentPath: "/blog/monolingual",
} as const;
