import { describe, expect, it } from "vitest";

import { FINDING_TYPES } from "./findings";
import { findingIdentity } from "./identity";

/**
 * Identity is what lets a comparison say "this is the same problem you had
 * yesterday". Two properties matter, and they pull in opposite directions:
 *
 *   - It must **hold still** while the evidence around a finding moves, or a
 *     standing problem reports as fixed and immediately re-broken.
 *   - It must **separate** findings that are genuinely different, or two
 *     problems collapse into one and the second is never reported at all.
 *
 * The per-type cases below fix the first. The `separates` block fixes the
 * second. The coverage case makes sure a type added later cannot slip through
 * unmapped without somebody noticing.
 */

const id = (type: string, detail: Record<string, unknown>) =>
	findingIdentity({ type, detail });

/** One representative detail per type, shaped as the rules actually emit it. */
const SAMPLES: Record<string, Record<string, unknown>> = {
	[FINDING_TYPES.MISSING_LOCALE]: {
		groupKey: "https://x.test/",
		missingLocale: "fr",
		presentLocales: ["de", "en"],
		memberUrls: ["https://x.test/", "https://x.test/de/"],
	},
	[FINDING_TYPES.HREFLANG_TARGET_FAILED]: {
		declaredBy: "https://x.test/",
		locale: "de",
		target: "https://x.test/de/",
		httpStatus: 500,
		fetchError: null,
	},
	[FINDING_TYPES.HREFLANG_TARGET_UNREACHED]: {
		declaredBy: "https://x.test/",
		locale: "fr",
		target: "https://x.test/fr/",
	},
	[FINDING_TYPES.NO_HREFLANG]: {
		url: "https://x.test/de/page",
		impliedLocale: "de",
	},
	[FINDING_TYPES.HREFLANG_FAMILY_INCONSISTENT]: {
		groupKey: "https://x.test/",
		memberUrls: ["https://x.test/", "https://x.test/de/"],
		defects: [{ kind: "asymmetric" }],
	},
	[FINDING_TYPES.VARIANT_DIVERGED]: {
		groupKey: "https://x.test/",
		brokenUrl: "https://x.test/de/",
		locale: "de",
		httpStatus: 404,
		fetchError: null,
		declaredBy: ["https://x.test/", "https://x.test/fr/"],
		healthyUrls: ["https://x.test/", "https://x.test/fr/"],
	},
	[FINDING_TYPES.CONTENT_UNTRANSLATED]: {
		kind: "placeholder_markers",
		url: "https://x.test/de/page",
		locale: "de",
		markers: ["{{title}}"],
	},
	[FINDING_TYPES.CONTENT_STRUCTURE_DIFFERS]: {
		groupKey: "https://x.test/",
		memberUrls: ["https://x.test/", "https://x.test/de/"],
		differences: [{ block: "form" }],
	},
	[FINDING_TYPES.METADATA_MISSING]: {
		url: "https://x.test/page",
		fields: ["title"],
	},
	[FINDING_TYPES.METADATA_DUPLICATED]: {
		field: "title",
		language: "en",
		value: "Home",
		urls: ["https://x.test/a", "https://x.test/b"],
	},
	[FINDING_TYPES.CANONICAL_MISSING]: {
		url: "https://x.test/page",
		pagesDeclaringCanonical: 12,
	},
	[FINDING_TYPES.CANONICAL_CONFLICTING]: {
		kind: "multiple",
		url: "https://x.test/page",
		canonicals: ["https://x.test/a", "https://x.test/b"],
	},
	[FINDING_TYPES.CANONICAL_TARGET_BROKEN]: {
		kind: "failed",
		url: "https://x.test/page",
		canonical: "https://x.test/gone",
		httpStatus: 404,
		fetchError: null,
	},
	[FINDING_TYPES.NOINDEX_PRESENT]: {
		url: "https://x.test/page",
		sources: ["markup"],
		channels: ["markup"],
		indexingChannels: ["markup"],
	},
	[FINDING_TYPES.CONTENT_DUPLICATED]: {
		digest: "abc123",
		textLength: 900,
		urls: ["https://x.test/a", "https://x.test/b"],
	},
	[FINDING_TYPES.LINK_BROKEN]: {
		target: "https://x.test/gone",
		httpStatus: 500,
		fetchError: null,
		confirmed: true,
		linkedFrom: ["https://x.test/a"],
	},
	[FINDING_TYPES.LINK_EXTERNAL_BROKEN]: {
		target: "https://other.test/gone",
		httpStatus: 404,
		fetchError: null,
		confirmed: true,
		linkedFrom: ["https://x.test/a"],
	},
	[FINDING_TYPES.CERTIFICATE_PROBLEM]: {
		kind: "expiring_soon",
		origin: "https://x.test",
		validTo: "2026-10-01T00:00:00.000Z",
		daysRemaining: 27,
		issuer: "Example CA",
		subject: "x.test",
		authorizationError: null,
	},
	[FINDING_TYPES.SECURITY_HEADER_CONTRADICTION]: {
		kind: "malformed",
		header: "content-security-policy",
		value: "default-src",
		affectedUrls: ["https://x.test/a"],
	},
	[FINDING_TYPES.SITEMAP_URL_FAILED]: {
		sitemapSource: "https://x.test/sitemap.xml",
		discovery: "robots",
		entries: [
			{ loc: "https://x.test/gone", normalised: "https://x.test/gone" },
		],
	},
	[FINDING_TYPES.PAGE_MISSING_FROM_SITEMAP]: {
		sitemapSource: "https://x.test/sitemap.xml",
		discovery: "robots",
		sitemapEntryCount: 40,
		urls: ["https://x.test/a", "https://x.test/b"],
	},
	[FINDING_TYPES.ROBOTS_BLOCKS_INDEXABLE]: {
		rule: "/private",
		ruleLine: "Disallow: /private",
		ruleLineNumber: 4,
		userAgentGroup: "*",
		sitemapSource: "https://x.test/sitemap.xml",
		discovery: "robots",
		urls: ["https://x.test/private/a"],
	},
	[FINDING_TYPES.PAGE_ORPHANED]: {
		sitemapSource: "https://x.test/sitemap.xml",
		discovery: "robots",
		urls: ["https://x.test/orphan"],
	},
	[FINDING_TYPES.IMAGE_MISSING_DIMENSIONS]: {
		url: "https://x.test/en/home",
		count: 4,
		of: 6,
		images: ["https://x.test/a.jpg", "https://x.test/b.jpg"],
		listed: 2,
	},
	[FINDING_TYPES.IMAGE_LEGACY_FORMAT]: {
		url: "https://x.test/en/home",
		count: 3,
		of: 6,
		images: ["https://x.test/a.jpg"],
		listed: 1,
	},
	[FINDING_TYPES.REDIRECT_CHAIN]: {
		kind: "chain",
		from: "https://x.test/old",
		to: "https://x.test/new",
		hops: [{ url: "https://x.test/mid", status: 301, location: "/new" }],
		linkedFrom: ["https://x.test/a"],
	},
};

describe("finding identity", () => {
	/**
	 * The guard against a rule added in a later slice whose author never came
	 * here. It would still get an identity from the fallback, but the fallback is
	 * documented as a safety net rather than as a design, and a set-valued type
	 * left on it churns. Failing loudly is cheaper than discovering it on a site.
	 */
	it("has a sample for every finding type", () => {
		const missing = Object.values(FINDING_TYPES).filter(
			(type) => !(type in SAMPLES),
		);
		expect(missing).toEqual([]);
	});

	it("produces a non-empty, type-prefixed key for every type", () => {
		for (const [type, detail] of Object.entries(SAMPLES)) {
			const identity = id(type, detail);
			expect(
				identity.startsWith(type),
				`${type} key is not type-prefixed`,
			).toBe(true);
			expect(identity.length).toBeGreaterThan(type.length);
		}
	});

	it("gives every type a key distinct from every other type", () => {
		const keys = Object.entries(SAMPLES).map(([type, d]) => id(type, d));
		expect(new Set(keys).size).toBe(keys.length);
	});
});

/**
 * The half that matters most. Each case moves something the crawl observed, or
 * something the population happens to be, and asserts the finding is still
 * recognised as itself.
 */
describe("identity holds still while evidence moves", () => {
	it("ignores a new page linking to the same dead URL", () => {
		const base = SAMPLES[FINDING_TYPES.LINK_BROKEN] as Record<string, unknown>;

		expect(id(FINDING_TYPES.LINK_BROKEN, base)).toBe(
			id(FINDING_TYPES.LINK_BROKEN, {
				...base,
				linkedFrom: ["https://x.test/a", "https://x.test/b"],
			}),
		);
	});

	it("ignores a dead link changing which way it fails", () => {
		const base = SAMPLES[FINDING_TYPES.LINK_BROKEN] as Record<string, unknown>;

		expect(id(FINDING_TYPES.LINK_BROKEN, base)).toBe(
			id(FINDING_TYPES.LINK_BROKEN, {
				...base,
				httpStatus: 503,
				confirmed: false,
			}),
		);
	});

	it("ignores a certificate renewal that leaves the problem standing", () => {
		const base = SAMPLES[FINDING_TYPES.CERTIFICATE_PROBLEM] as Record<
			string,
			unknown
		>;

		expect(id(FINDING_TYPES.CERTIFICATE_PROBLEM, base)).toBe(
			id(FINDING_TYPES.CERTIFICATE_PROBLEM, {
				...base,
				validTo: "2027-01-01T00:00:00.000Z",
				daysRemaining: 12,
			}),
		);
	});

	it("ignores a duplicated title spreading to another page", () => {
		const base = SAMPLES[FINDING_TYPES.METADATA_DUPLICATED] as Record<
			string,
			unknown
		>;

		expect(id(FINDING_TYPES.METADATA_DUPLICATED, base)).toBe(
			id(FINDING_TYPES.METADATA_DUPLICATED, {
				...base,
				urls: ["https://x.test/a", "https://x.test/b", "https://x.test/c"],
			}),
		);
	});

	it("ignores a page losing a second metadata field", () => {
		const base = SAMPLES[FINDING_TYPES.METADATA_MISSING] as Record<
			string,
			unknown
		>;

		expect(id(FINDING_TYPES.METADATA_MISSING, base)).toBe(
			id(FINDING_TYPES.METADATA_MISSING, {
				...base,
				fields: ["title", "description"],
			}),
		);
	});

	/**
	 * The deliberate asymmetry with `canonical_conflicting` below. Both kinds
	 * describe one canonical that does not resolve; which one was observed
	 * depends on whether the crawl reached the target.
	 */
	it("ignores a broken canonical changing how it was observed", () => {
		const base = SAMPLES[FINDING_TYPES.CANONICAL_TARGET_BROKEN] as Record<
			string,
			unknown
		>;

		expect(id(FINDING_TYPES.CANONICAL_TARGET_BROKEN, base)).toBe(
			id(FINDING_TYPES.CANONICAL_TARGET_BROKEN, {
				kind: "unreached",
				url: base.url,
				canonical: base.canonical,
			}),
		);
	});

	it("ignores the order a set-valued finding lists its URLs in", () => {
		const base = SAMPLES[FINDING_TYPES.PAGE_ORPHANED] as Record<
			string,
			unknown
		>;

		expect(
			id(FINDING_TYPES.PAGE_ORPHANED, {
				...base,
				urls: ["https://x.test/a", "https://x.test/b"],
			}),
		).toBe(
			id(FINDING_TYPES.PAGE_ORPHANED, {
				...base,
				urls: ["https://x.test/b", "https://x.test/a"],
			}),
		);
	});

	it("ignores which URLs a robots rule currently catches", () => {
		const base = SAMPLES[FINDING_TYPES.ROBOTS_BLOCKS_INDEXABLE] as Record<
			string,
			unknown
		>;

		expect(id(FINDING_TYPES.ROBOTS_BLOCKS_INDEXABLE, base)).toBe(
			id(FINDING_TYPES.ROBOTS_BLOCKS_INDEXABLE, {
				...base,
				urls: ["https://x.test/private/a", "https://x.test/private/b"],
			}),
		);
	});
});

describe("identity separates genuinely different problems", () => {
	it("separates two canonical defects on one page", () => {
		const base = SAMPLES[FINDING_TYPES.CANONICAL_CONFLICTING] as Record<
			string,
			unknown
		>;

		expect(id(FINDING_TYPES.CANONICAL_CONFLICTING, base)).not.toBe(
			id(FINDING_TYPES.CANONICAL_CONFLICTING, { ...base, kind: "chain" }),
		);
	});

	it("separates two duplicated strings in the same field", () => {
		const base = SAMPLES[FINDING_TYPES.METADATA_DUPLICATED] as Record<
			string,
			unknown
		>;

		expect(id(FINDING_TYPES.METADATA_DUPLICATED, base)).not.toBe(
			id(FINDING_TYPES.METADATA_DUPLICATED, { ...base, value: "About" }),
		);
	});

	it("separates two dead links", () => {
		const base = SAMPLES[FINDING_TYPES.LINK_BROKEN] as Record<string, unknown>;

		expect(id(FINDING_TYPES.LINK_BROKEN, base)).not.toBe(
			id(FINDING_TYPES.LINK_BROKEN, {
				...base,
				target: "https://x.test/also-gone",
			}),
		);
	});

	it("separates the same dead URL inside and outside the site", () => {
		expect(
			id(FINDING_TYPES.LINK_BROKEN, { target: "https://x.test/gone" }),
		).not.toBe(
			id(FINDING_TYPES.LINK_EXTERNAL_BROKEN, {
				target: "https://x.test/gone",
			}),
		);
	});

	it("separates the two kinds of untranslated content", () => {
		expect(
			id(FINDING_TYPES.CONTENT_UNTRANSLATED, {
				kind: "placeholder_markers",
				url: "https://x.test/de/page",
			}),
		).not.toBe(
			id(FINDING_TYPES.CONTENT_UNTRANSLATED, {
				kind: "identical_to_siblings",
				groupKey: "https://x.test/de/page",
			}),
		);
	});

	/**
	 * The separator's job, stated as a test. Titles are arbitrary site text: if
	 * the parts were joined on a character a title can contain, two unrelated
	 * duplicates would key the same and the second would never be reported.
	 */
	it("does not let a value containing the separator forge another key", () => {
		expect(
			id(FINDING_TYPES.METADATA_DUPLICATED, {
				field: "title",
				language: "en",
				value: "Home",
			}),
		).not.toBe(
			id(FINDING_TYPES.METADATA_DUPLICATED, {
				field: "title",
				language: "en Home",
				value: "",
			}),
		);
	});

	it("does not let two URL sets with the same concatenation collide", () => {
		expect(id(FINDING_TYPES.PAGE_ORPHANED, { urls: ["ab", "c"] })).not.toBe(
			id(FINDING_TYPES.PAGE_ORPHANED, { urls: ["a", "bc"] }),
		);
	});
});

describe("an unmapped type", () => {
	/**
	 * Falls back to the subject `evidenceRoles` derives, which for an unknown
	 * type is the URL the finding names. Workable rather than absent — and
	 * carrying the type, so it can never match a mapped finding.
	 */
	it("still gets a stable key from its subject", () => {
		const a = findingIdentity({
			type: "some_future_rule",
			detail: { url: "https://x.test/page" },
		});
		const b = findingIdentity({
			type: "some_future_rule",
			detail: { url: "https://x.test/page" },
		});

		expect(a).toBe(b);
		expect(a.startsWith("some_future_rule")).toBe(true);
	});

	it("does not collide with a different unmapped type", () => {
		expect(
			findingIdentity({ type: "rule_a", detail: { url: "https://x.test/" } }),
		).not.toBe(
			findingIdentity({ type: "rule_b", detail: { url: "https://x.test/" } }),
		);
	});

	/**
	 * The failure the fallback exists to prevent, asserted directly.
	 *
	 * A corpus-level rule added later names no page, so `evidenceRoles` gives it
	 * no subject. If identity stopped there it would be the type alone, and every
	 * finding the new rule ever produced would be treated as one — the merging
	 * direction, which never reports the second problem at all.
	 */
	it("separates two subject-less findings of the same unmapped type", () => {
		expect(
			findingIdentity({ type: "future_corpus_rule", detail: { count: 3 } }),
		).not.toBe(
			findingIdentity({ type: "future_corpus_rule", detail: { count: 9 } }),
		);
	});
});
