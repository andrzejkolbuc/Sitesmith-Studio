import { describe, expect, it } from "vitest";

import { FINDING_TYPES } from "~/server/crawl/findings";
import {
	countPages,
	evidenceRoles,
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

	it("counts every page a duplicate finding names when it has no language", () => {
		/**
		 * The unlocalised bucket. A null `language` changes how the finding reads,
		 * not how much of the site it touches — so the count must be the same as for
		 * a language-scoped duplicate rather than falling through to the default.
		 */
		expect(
			pagesInvolved({
				type: "metadata_duplicated",
				url: null,
				detail: {
					field: "title",
					language: null,
					value: "Legal information",
					urls: [`${B}/imprint`, `${B}/privacy`],
				},
			}),
		).toHaveLength(2);
	});

	it("counts the dead target and every page linking to it", () => {
		/**
		 * The linking pages are where the fix happens — the dead URL may be gone on
		 * purpose — so a count naming only the target would understate how much of
		 * the site has to be edited.
		 */
		expect(
			pagesInvolved({
				type: "link_broken",
				url: null,
				detail: {
					target: `${B}/gone`,
					httpStatus: 404,
					confirmed: false,
					linkedFrom: [`${B}/`, `${B}/about`],
				},
			}),
		).toHaveLength(3);
	});

	it("counts the pages a security-header contradiction names", () => {
		expect(
			pagesInvolved({
				type: "security_header_contradiction",
				url: null,
				detail: {
					kind: "inconsistent",
					header: "strict-transport-security",
					pagesPublishing: 12,
					affectedUrls: [`${B}/legacy`, `${B}/old`],
				},
			}),
		).toHaveLength(2);
	});

	it("counts the pages a sitemap reconciliation names", () => {
		expect(
			pagesInvolved({
				type: "page_missing_from_sitemap",
				url: null,
				detail: {
					sitemapSource: `${B}/sitemap.xml`,
					sitemapEntryCount: 40,
					urls: [`${B}/a`, `${B}/b`],
				},
			}),
		).toHaveLength(2);
	});

	it("counts the normalised URL of each failing sitemap entry", () => {
		/**
		 * The raw loc travels beside it as evidence, but it is the normalised form
		 * that names a page — and reading the wrong one would count a URL the crawl
		 * never had under that spelling.
		 */
		expect(
			pagesInvolved({
				type: "sitemap_url_failed",
				url: null,
				detail: {
					sitemapSource: `${B}/sitemap.xml`,
					entries: [
						{ raw: `${B}/gone?x=1`, normalised: `${B}/gone`, httpStatus: 404 },
					],
				},
			}),
		).toEqual([`${B}/gone`]);
	});

	it("counts the URLs a robots.txt rule blocks", () => {
		expect(
			pagesInvolved({
				type: "robots_blocks_indexable",
				url: null,
				detail: {
					rule: "/admin",
					ruleLine: "Disallow: /admin",
					userAgentGroup: "googlebot",
					urls: [`${B}/admin/a`, `${B}/admin/b`, `${B}/admin/c`],
				},
			}),
		).toHaveLength(3);
	});

	it("counts no pages for a certificate problem", () => {
		/**
		 * Deliberately zero, and pinned so it cannot be mistaken for a type somebody
		 * forgot to map. A certificate belongs to the origin rather than to any
		 * page, so "how many pages does this touch" has no honest answer — and the
		 * tempting answer, all of them, would put the entire site behind one finding
		 * and drown every other row in the list.
		 */
		expect(
			pagesInvolved({
				type: "certificate_problem",
				url: null,
				detail: {
					kind: "expired",
					origin: B,
					validTo: "2026-01-01T00:00:00.000Z",
					daysRemaining: -30,
				},
			}),
		).toEqual([]);
	});

	it("counts every URL serving duplicated content", () => {
		/**
		 * Filed against no page, like every duplicate finding. Without a case here
		 * the default would read `finding.url`, find null, and report a problem
		 * spanning three URLs as affecting nothing.
		 */
		expect(
			pagesInvolved({
				type: "content_duplicated",
				url: null,
				detail: {
					digest: "abc123",
					textLength: 800,
					urls: [`${B}/guide`, `${B}/guide-copy`, `${B}/archive/guide`],
				},
			}),
		).toHaveLength(3);
	});
});

describe("pagesInvolved for canonical findings", () => {
	const B = "https://shop.test";

	it("counts the single page a missing-canonical finding names", () => {
		expect(
			pagesInvolved({
				type: "canonical_missing",
				url: `${B}/en/pricing`,
				detail: { url: `${B}/en/pricing`, pagesDeclaringCanonical: 12 },
			}),
		).toEqual([`${B}/en/pricing`]);
	});

	it("counts every URL a page declaring several canonicals named", () => {
		expect(
			pagesInvolved({
				type: "canonical_conflicting",
				url: `${B}/en/pricing`,
				detail: {
					kind: "multiple",
					url: `${B}/en/pricing`,
					canonicals: [`${B}/en/pricing`, `${B}/en/plans`],
				},
			}),
		).toEqual([`${B}/en/pricing`, `${B}/en/pricing`, `${B}/en/plans`]);
	});

	it("counts both ends of a chain", () => {
		expect(
			new Set(
				pagesInvolved({
					type: "canonical_conflicting",
					url: `${B}/en/a`,
					detail: {
						kind: "chain",
						url: `${B}/en/a`,
						canonical: `${B}/en/b`,
						targetCanonical: `${B}/en/c`,
					},
				}),
			),
		).toEqual(new Set([`${B}/en/a`, `${B}/en/b`]));
	});

	it("counts the page and the target a broken canonical names", () => {
		/**
		 * Both, the way rules 2 and 3 already count a declared sibling. A canonical
		 * defect is a relationship between two URLs, and counting only the page
		 * that declared it describes half of what the reader has to open.
		 */
		expect(
			pagesInvolved({
				type: "canonical_target_broken",
				url: `${B}/en/pricing`,
				detail: {
					kind: "failed",
					url: `${B}/en/pricing`,
					canonical: `${B}/en/gone`,
					httpStatus: 404,
				},
			}),
		).toEqual([`${B}/en/pricing`, `${B}/en/gone`]);
	});

	it("counts the single page a noindex finding names", () => {
		expect(
			pagesInvolved({
				type: "noindex_present",
				url: `${B}/en/staging`,
				detail: {
					url: `${B}/en/staging`,
					channels: ["header"],
					sources: [{ channel: "header", crawler: null, directive: "noindex" }],
					indexingChannels: ["markup"],
				},
			}),
		).toEqual([`${B}/en/staging`]);
	});

	it("counts the pages still linking into a redirect chain", () => {
		/**
		 * The hops are routes, not pages, and the chain's own entry is a URL that
		 * redirects rather than one that renders. What a reader edits is every page
		 * still pointing at the stale URL.
		 */
		expect(
			pagesInvolved({
				type: "redirect_chain",
				url: null,
				detail: {
					kind: "chain",
					from: `${B}/old`,
					to: `${B}/new`,
					hops: [],
					linkedFrom: [`${B}/`, `${B}/about`],
				},
			}),
		).toEqual([`${B}/`, `${B}/about`]);
	});

	it("falls back to the chain's entry when nothing links to it", () => {
		/**
		 * A chain reached from the sitemap, or from where the run started. Reporting
		 * zero pages would read as a problem affecting nothing.
		 */
		expect(
			pagesInvolved({
				type: "redirect_chain",
				url: null,
				detail: {
					kind: "loop",
					from: `${B}/circle`,
					to: null,
					hops: [],
					linkedFrom: [],
				},
			}),
		).toEqual([`${B}/circle`]);
	});
});

/**
 * The role split, type by type.
 *
 * Two properties are worth more than the individual cases. The first is
 * exhaustiveness: the table below is asserted to cover `FINDING_TYPES` exactly,
 * so a rule added later cannot quietly fall through to the default and arrive at
 * correlation with no origin. The second is that `origin` is empty for exactly
 * the five types that speak about the corpus rather than about a page — that
 * emptiness is what keeps them out of correlation structurally, so it is
 * asserted rather than assumed.
 */

const R = "https://roles.example";

type RoleCase = {
	url?: string | null;
	detail: Record<string, unknown>;
	subject: string[];
	origin: string[];
};

const ROLE_CASES: Record<string, RoleCase> = {
	missing_locale: {
		url: `${R}/a`,
		detail: {
			groupKey: `${R}/a`,
			missingLocale: "fr",
			presentLocales: ["en", "de"],
			memberUrls: [`${R}/a`, `${R}/de/a`],
		},
		subject: [`${R}/a`, `${R}/de/a`],
		origin: [`${R}/a`, `${R}/de/a`],
	},
	hreflang_target_failed: {
		url: `${R}/en`,
		detail: {
			declaredBy: `${R}/en`,
			locale: "de",
			target: `${R}/de`,
			httpStatus: 500,
			fetchError: null,
		},
		subject: [`${R}/de`],
		origin: [`${R}/en`],
	},
	hreflang_target_unreached: {
		url: `${R}/en`,
		detail: { declaredBy: `${R}/en`, locale: "de", target: `${R}/de` },
		subject: [`${R}/de`],
		origin: [`${R}/en`],
	},
	no_hreflang: {
		url: `${R}/en/solo`,
		detail: { url: `${R}/en/solo`, impliedLocale: "en" },
		subject: [`${R}/en/solo`],
		origin: [`${R}/en/solo`],
	},
	hreflang_family_inconsistent: {
		url: null,
		detail: {
			groupKey: `${R}/a`,
			memberUrls: [`${R}/a`, `${R}/de/a`],
			defects: [],
		},
		subject: [`${R}/a`, `${R}/de/a`],
		origin: [`${R}/a`, `${R}/de/a`],
	},
	variant_diverged: {
		url: null,
		detail: {
			locale: "fr",
			groupKey: `${R}/a`,
			brokenUrl: `${R}/fr/a`,
			declaredBy: [`${R}/en/a`, `${R}/de/a`],
			healthyUrls: [`${R}/en/a`, `${R}/de/a`],
		},
		subject: [`${R}/fr/a`],
		origin: [`${R}/en/a`, `${R}/de/a`],
	},
	content_untranslated: {
		url: `${R}/en/draft`,
		detail: {
			kind: "placeholder_markers",
			url: `${R}/en/draft`,
			locale: "en",
			markers: ["lorem ipsum"],
		},
		subject: [`${R}/en/draft`],
		origin: [`${R}/en/draft`],
	},
	content_structure_differs: {
		url: null,
		detail: {
			groupKey: `${R}/a`,
			memberUrls: [`${R}/en/a`, `${R}/de/a`],
			differences: [],
		},
		subject: [`${R}/en/a`, `${R}/de/a`],
		origin: [`${R}/en/a`, `${R}/de/a`],
	},
	metadata_missing: {
		url: `${R}/en/bare`,
		detail: { url: `${R}/en/bare`, fields: ["title"] },
		subject: [`${R}/en/bare`],
		origin: [`${R}/en/bare`],
	},
	metadata_duplicated: {
		url: null,
		detail: {
			field: "title",
			language: "en",
			value: "Home",
			urls: [`${R}/en/a`, `${R}/en/b`],
		},
		subject: [`${R}/en/a`, `${R}/en/b`],
		origin: [`${R}/en/a`, `${R}/en/b`],
	},
	canonical_missing: {
		url: `${R}/en/pricing`,
		detail: { url: `${R}/en/pricing`, pagesDeclaringCanonical: 12 },
		subject: [`${R}/en/pricing`],
		origin: [`${R}/en/pricing`],
	},
	canonical_conflicting: {
		url: `${R}/en/pricing`,
		detail: {
			kind: "multiple",
			url: `${R}/en/pricing`,
			canonicals: [`${R}/en/pricing`, `${R}/en/plans`],
		},
		subject: [`${R}/en/pricing`, `${R}/en/plans`],
		origin: [`${R}/en/pricing`],
	},
	canonical_target_broken: {
		url: `${R}/en/pricing`,
		detail: {
			kind: "failed",
			url: `${R}/en/pricing`,
			canonical: `${R}/en/gone`,
			httpStatus: 404,
			fetchError: null,
		},
		subject: [`${R}/en/gone`],
		origin: [`${R}/en/pricing`],
	},
	noindex_present: {
		url: `${R}/en/staging`,
		detail: {
			url: `${R}/en/staging`,
			sources: [],
			channels: ["meta"],
			indexingChannels: ["meta"],
		},
		subject: [`${R}/en/staging`],
		origin: [`${R}/en/staging`],
	},
	content_duplicated: {
		url: null,
		detail: {
			digest: "abc",
			textLength: 900,
			urls: [`${R}/en/a`, `${R}/en/b`],
		},
		subject: [`${R}/en/a`, `${R}/en/b`],
		origin: [`${R}/en/a`, `${R}/en/b`],
	},
	link_broken: {
		url: null,
		detail: {
			target: `${R}/gone`,
			httpStatus: 404,
			fetchError: null,
			confirmed: false,
			linkedFrom: [`${R}/`, `${R}/about`],
		},
		subject: [`${R}/gone`],
		origin: [`${R}/`, `${R}/about`],
	},
	certificate_problem: {
		url: null,
		detail: {
			kind: "expiring",
			origin: R,
			validTo: "2026-10-01T00:00:00Z",
			daysRemaining: 5,
			issuer: "Test CA",
			subject: R,
			authorizationError: null,
		},
		subject: [],
		origin: [],
	},
	security_header_contradiction: {
		url: null,
		detail: {
			kind: "inconsistent",
			header: "strict-transport-security",
			pagesPublishing: 40,
			affectedUrls: [`${R}/en/a`, `${R}/en/b`],
		},
		subject: [`${R}/en/a`, `${R}/en/b`],
		origin: [`${R}/en/a`, `${R}/en/b`],
	},
	sitemap_url_failed: {
		url: null,
		detail: {
			sitemapSource: `${R}/sitemap.xml`,
			discovery: "robots",
			entries: [{ loc: `${R}/gone/`, normalised: `${R}/gone` }],
		},
		subject: [`${R}/gone`],
		origin: [],
	},
	page_missing_from_sitemap: {
		url: null,
		detail: {
			sitemapSource: `${R}/sitemap.xml`,
			discovery: "robots",
			sitemapEntryCount: 120,
			urls: [`${R}/en/a`, `${R}/en/b`],
		},
		subject: [`${R}/en/a`, `${R}/en/b`],
		origin: [],
	},
	robots_blocks_indexable: {
		url: null,
		detail: {
			rule: "/private",
			ruleLine: "Disallow: /private",
			ruleLineNumber: 4,
			userAgentGroup: "*",
			sitemapSource: `${R}/sitemap.xml`,
			discovery: "robots",
			urls: [`${R}/private/a`],
		},
		subject: [`${R}/private/a`],
		origin: [],
	},
	page_orphaned: {
		url: null,
		detail: {
			sitemapSource: `${R}/sitemap.xml`,
			discovery: "robots",
			urls: [`${R}/en/lonely`],
		},
		subject: [`${R}/en/lonely`],
		origin: [],
	},
	link_external_broken: {
		url: null,
		detail: {
			target: "https://partner.example/gone",
			httpStatus: 410,
			fetchError: null,
			confirmed: true,
			linkedFrom: [`${R}/`, `${R}/about`],
		},
		subject: ["https://partner.example/gone"],
		origin: [`${R}/`, `${R}/about`],
	},
	redirect_chain: {
		url: null,
		detail: {
			kind: "chain",
			from: `${R}/old`,
			to: `${R}/new`,
			hops: [],
			linkedFrom: [`${R}/`],
		},
		subject: [],
		origin: [`${R}/`],
	},
};

describe("evidenceRoles", () => {
	it("covers every finding type the crawl can produce", () => {
		/**
		 * The guard that makes the rest of this suite mean something. A type added
		 * to `FINDING_TYPES` and not described here would fall through to the
		 * default, arrive at correlation with no origin, and never be correlated —
		 * silently, and in the direction that looks like the rule working.
		 */
		expect(new Set(Object.keys(ROLE_CASES))).toEqual(
			new Set(Object.values(FINDING_TYPES)),
		);
	});

	for (const [type, expected] of Object.entries(ROLE_CASES)) {
		it(`splits ${type} into what is wrong and who emits it`, () => {
			expect(
				evidenceRoles({ type, url: expected.url, detail: expected.detail }),
			).toEqual({ subject: expected.subject, origin: expected.origin });
		});
	}

	it("gives the corpus-level types no origin, and only those", () => {
		/**
		 * Asserted as a set rather than one type at a time, because the property
		 * that matters is the boundary: exactly these five speak about the corpus
		 * rather than about a page, and correlation excludes exactly these five.
		 */
		const withoutOrigin = Object.entries(ROLE_CASES)
			.filter(([, c]) => c.origin.length === 0)
			.map(([type]) => type);

		expect(new Set(withoutOrigin)).toEqual(
			new Set([
				"certificate_problem",
				"sitemap_url_failed",
				"page_missing_from_sitemap",
				"robots_blocks_indexable",
				"page_orphaned",
			]),
		);
	});

	it("reads the identical-content shape of an untranslated finding", () => {
		/**
		 * The one type with two detail shapes under it. The table above carries the
		 * marker kind; this is the other.
		 */
		expect(
			evidenceRoles({
				type: "content_untranslated",
				url: null,
				detail: {
					kind: "identical_to_siblings",
					groupKey: `${R}/a`,
					urls: [`${R}/en/a`, `${R}/de/a`],
					locales: ["de", "en"],
				},
			}),
		).toEqual({
			subject: [`${R}/en/a`, `${R}/de/a`],
			origin: [`${R}/en/a`, `${R}/de/a`],
		});
	});

	it("makes the chain entry the subject only when nothing links to it", () => {
		expect(
			evidenceRoles({
				type: "redirect_chain",
				url: null,
				detail: { kind: "loop", from: `${R}/circle`, to: null, hops: [] },
			}),
		).toEqual({ subject: [`${R}/circle`], origin: [] });
	});

	it("gives an unmapped type a subject but never an origin", () => {
		/**
		 * A new rule still counts the page it names, and still cannot be correlated
		 * on evidence nobody has described yet. Failing safe in both directions.
		 */
		expect(
			evidenceRoles({ type: "something_new", url: `${R}/x`, detail: {} }),
		).toEqual({ subject: [`${R}/x`], origin: [] });
	});
});
