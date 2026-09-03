import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Fixture, startFixtureSite } from "../../../test/fixtures/site";
import { emptyContent } from "./content";
import { type CrawledPage, crawl } from "./crawler";
import { detectMissingVariants, FINDING_TYPES } from "./findings";
import { emptyMetadata } from "./metadata";
import { groupVariants, localeFromUrl } from "./variants";

let site: Fixture;

beforeAll(async () => {
	site = await startFixtureSite();
});

afterAll(async () => {
	await site.close();
});

/** Minimal page record, for grouping tests that need no HTTP. */
const page = (
	url: string,
	hreflangTargets: Record<string, string> = {},
): CrawledPage => ({
	url,
	httpStatus: 200,
	hreflangTargets,
	links: [],
	content: emptyContent(true),
	/**
	 * A title and description by default, unique to the URL.
	 *
	 * Without them every page built here would also report a missing title, and
	 * the cases below — which are about grouping and about locales — would be
	 * asserting on a metadata rule they were never written for.
	 */
	metadata: { ...emptyMetadata(), title: url, description: `About ${url}` },
	xRobotsTag: null,
	securityHeaders: {},
	fetchError: null,
});

describe("localeFromUrl", () => {
	it("recognises locale segments", () => {
		expect(localeFromUrl("https://x.test/de/preise")).toBe("de");
		expect(localeFromUrl("https://x.test/fr-ca/tarifs")).toBe("fr-ca");
		expect(localeFromUrl("https://x.test/pt_BR/precos")).toBe("pt-br");
	});

	it("does not mistake ordinary path segments for locales", () => {
		// The narrowing depends on this: a loose pattern would manufacture
		// findings on monolingual sites.
		expect(localeFromUrl("https://x.test/design/system")).toBeNull();
		expect(localeFromUrl("https://x.test/blog/post")).toBeNull();
		expect(localeFromUrl("https://x.test/")).toBeNull();
	});
});

describe("groupVariants", () => {
	it("produces the same grouping regardless of page order", () => {
		const a = page("https://x.test/a", {
			en: "https://x.test/a",
			de: "https://x.test/b",
		});
		const b = page("https://x.test/b", {
			en: "https://x.test/a",
			de: "https://x.test/b",
		});
		const c = page("https://x.test/c");

		const forward = groupVariants([a, b, c]);
		const reversed = groupVariants([c, b, a]);

		expect(forward.get(a.url)?.groupKey).toBe(reversed.get(a.url)?.groupKey);
		expect(forward.get(b.url)?.groupKey).toBe(reversed.get(b.url)?.groupKey);
		expect(forward.get(a.url)?.groupKey).toBe(forward.get(b.url)?.groupKey);
	});

	it("treats a one-directional declaration as a relationship", () => {
		// Real sites frequently declare hreflang on only one side of a pair.
		const a = page("https://x.test/a", { de: "https://x.test/b" });
		const b = page("https://x.test/b");

		const groups = groupVariants([a, b]);

		expect(groups.get(a.url)?.groupKey).toBe(groups.get(b.url)?.groupKey);
	});

	it("does not group a declared sibling the crawl never reached", () => {
		// An unreachable URL must stay a finding, not silently satisfy a locale.
		const a = page("https://x.test/a", { de: "https://x.test/never-crawled" });

		const groups = groupVariants([a]);

		expect(groups.size).toBe(1);
		expect(groups.get(a.url)?.groupKey).toBe(a.url);
	});

	it("leaves an unrelated page in its own group", () => {
		const groups = groupVariants([page("https://x.test/solo")]);

		expect(groups.get("https://x.test/solo")?.groupKey).toBe(
			"https://x.test/solo",
		);
	});
});

describe("detectMissingVariants against the fixture site", () => {
	async function detect() {
		const result = await crawl({
			startUrl: site.baseUrl,
			includePaths: [],
			excludePaths: ["/private", "/flaky"],
			maxConcurrency: 2,
			requestDelayMs: 0,
			maxPages: 50,
		});

		const inScope = (url: string) => {
			const path = new URL(url).pathname;
			return !path.startsWith("/private") && !path.startsWith("/flaky");
		};

		return {
			pages: result.pages,
			findings: detectMissingVariants({
				pages: result.pages,
				expectedLocales: ["en", "de", "fr"],
				inScope,
				// The fixture is small enough that every crawl here reaches the end.
				crawlComplete: true,
				reverified: result.reverified,
				certificate: result.certificate,
				/**
				 * Taken from the crawl rather than stubbed to null, so the sitemap and
				 * robots rules are exercised against the file the fixture actually
				 * served. Stubbing them would leave the two channels tested only at
				 * the parser level, with nothing proving they reach a rule.
				 */
				robots: result.robots,
				sitemap: result.sitemap,
				entryUrl: result.entryUrl,
				requested: result.requested,
				external: result.external,
			}),
		};
	}

	it("reports families that publish only two of three expected locales", async () => {
		const { findings } = await detect();
		const missing = findings.filter(
			(f) => f.type === FINDING_TYPES.MISSING_LOCALE,
		);

		/**
		 * Two families qualify, both missing French:
		 *   /pricing + /de/preise  — en and de both healthy
		 *   /contact + /de/kontakt — de present but broken, which rule 2 reports
		 *
		 * The single-page families (/about, /de/blog-post) are deliberately absent:
		 * one page is not evidence the site translates that content.
		 */
		expect(missing).toHaveLength(2);
		expect(missing.every((f) => f.detail.missingLocale === "fr")).toBe(true);
	});

	it("does not report a lone locale-shaped page as missing its siblings", async () => {
		const { findings } = await detect();

		// /de/blog-post has no family. It should produce a no-hreflang finding
		// and nothing about absent English or French versions.
		const aboutBlogPost = findings.filter(
			(f) => f.detail.groupKey === `${site.baseUrl}/de/blog-post`,
		);

		expect(aboutBlogPost).toHaveLength(0);
	});

	it("reports a declared sibling that returned an error", async () => {
		const { findings } = await detect();
		const failed = findings.filter(
			(f) => f.type === FINDING_TYPES.HREFLANG_TARGET_FAILED,
		);

		// /contact declares /de/kontakt, which 404s.
		expect(failed).toHaveLength(1);
		expect(failed[0]?.detail.target).toBe(`${site.baseUrl}/de/kontakt`);
		expect(failed[0]?.detail.httpStatus).toBe(404);
	});

	it("does not report a declared sibling that is out of scope", async () => {
		const { findings } = await detect();
		const unreached = findings.filter(
			(f) => f.type === FINDING_TYPES.HREFLANG_TARGET_UNREACHED,
		);

		// /about declares /private/ueber-uns, which the scope excludes.
		expect(unreached).toHaveLength(0);
	});

	it("reports a locale-shaped URL that declares nothing", async () => {
		const { findings } = await detect();
		const silent = findings.filter((f) => f.type === FINDING_TYPES.NO_HREFLANG);

		expect(silent).toHaveLength(1);
		expect(silent[0]?.url).toBe(`${site.baseUrl}/de/blog-post`);
		expect(silent[0]?.detail.impliedLocale).toBe("de");
	});

	/**
	 * The single most important assertion in this change.
	 *
	 * Rule 4 was narrowed specifically so an ordinary monolingual page stays
	 * silent. If this ever fails, the narrowing has regressed and the first run
	 * anyone looks at will be mostly noise.
	 */
	it("says nothing about a monolingual page with no hreflang", async () => {
		const { findings } = await detect();
		const monolingual = `${site.baseUrl}/blog/monolingual`;

		expect(findings.filter((f) => f.url === monolingual)).toHaveLength(0);
	});

	it("produces identical output across two runs of the same site", async () => {
		const first = await detect();
		const second = await detect();

		expect(JSON.stringify(second.findings)).toBe(
			JSON.stringify(first.findings),
		);
	});

	it("reports the page whose template never rendered", async () => {
		const { findings } = await detect();
		const markers = findings.filter(
			(f) =>
				f.type === FINDING_TYPES.CONTENT_UNTRANSLATED &&
				f.detail.kind === "placeholder_markers",
		);

		expect(markers).toHaveLength(1);
		expect(markers[0]?.url).toBe(`${site.baseUrl}/blog/draft`);
		expect(markers[0]?.detail.markers).toEqual(["unrendered_expression"]);
	});

	it("reports the German page that serves the English body, once", async () => {
		/**
		 * End to end from real HTML: the fixture serves `/de/handbuch` the same body
		 * as `/handbook`, and nothing else on the site shares content with anything.
		 * One finding naming both pages — not one finding per page.
		 */
		const { findings } = await detect();
		const identical = findings.filter(
			(f) =>
				f.type === FINDING_TYPES.CONTENT_UNTRANSLATED &&
				f.detail.kind === "identical_to_siblings",
		);

		expect(identical).toHaveLength(1);
		expect(identical[0]?.detail.urls).toEqual([
			`${site.baseUrl}/de/handbuch`,
			`${site.baseUrl}/handbook`,
		]);
		expect(identical[0]?.detail.locales).toEqual(["de", "en"]);
	});

	it("says nothing about three honest translations of different lengths", async () => {
		/**
		 * The assertion this whole slice rests on, and the direct answer to the PRD's
		 * unresolved objection that content drift is noise by default.
		 *
		 * `/story`, `/de/geschichte` and `/fr/histoire` run to 212, 414 and 243
		 * characters — materially different, as honest translations are. If this ever
		 * fails, the rule has started reporting translation for being translation.
		 */
		const { findings } = await detect();
		const family = [
			`${site.baseUrl}/story`,
			`${site.baseUrl}/de/geschichte`,
			`${site.baseUrl}/fr/histoire`,
		];

		const about = findings.filter((f) => {
			if (f.type !== FINDING_TYPES.CONTENT_UNTRANSLATED) return false;
			const urls = Array.isArray(f.detail.urls)
				? (f.detail.urls as string[])
				: [];
			return (
				family.includes(f.url ?? "") || urls.some((url) => family.includes(url))
			);
		});

		expect(about).toEqual([]);
	});

	it("reports the English page carrying a form its translations lack", async () => {
		const { findings } = await detect();
		const differs = findings.filter(
			(f) => f.type === FINDING_TYPES.CONTENT_STRUCTURE_DIFFERS,
		);

		expect(differs).toHaveLength(1);
		expect(differs[0]?.detail.differences).toEqual([
			{
				block: "form",
				present: [`${site.baseUrl}/quote`],
				absent: [`${site.baseUrl}/de/angebot`, `${site.baseUrl}/fr/devis`],
			},
		]);
	});

	it("says nothing about a family whose headings merely differ in number", async () => {
		/**
		 * The counterpart to the length objection, and the reason rule 8 compares
		 * presence rather than counts. `/de/geschichte` carries an extra `<h3>` its
		 * siblings do not — translators split and merge sections routinely — while
		 * every member still contains headings and a list.
		 *
		 * A rule counting headings would report this family. A reader would not.
		 */
		const { findings } = await detect();
		const family = [
			`${site.baseUrl}/story`,
			`${site.baseUrl}/de/geschichte`,
			`${site.baseUrl}/fr/histoire`,
		];

		/**
		 * Matched on membership, not on `groupKey`. The key is the lexicographically
		 * smallest member URL — `/de/geschichte` here, not `/story` — so filtering
		 * by the name a human would use silently matches nothing and asserts
		 * nothing. Found by mutation: making headings count-sensitive left this case
		 * green while breaking three others.
		 */
		const about = findings.filter((f) => {
			if (f.type !== FINDING_TYPES.CONTENT_STRUCTURE_DIFFERS) return false;
			const members = Array.isArray(f.detail.memberUrls)
				? (f.detail.memberUrls as string[])
				: [];
			return members.some((url) => family.includes(url));
		});

		expect(about).toEqual([]);
	});

	it("reports the one page that published no title and no description", async () => {
		const { findings } = await detect();
		const missing = findings.filter(
			(f) => f.type === FINDING_TYPES.METADATA_MISSING,
		);

		/**
		 * Every other fixture page carries a title and a description, so this is
		 * also the assertion that the rule stays quiet about the thirty pages that
		 * exist to exercise something else.
		 */
		expect(missing).toHaveLength(1);
		expect(missing[0]?.url).toBe(`${site.baseUrl}/meta/bare`);
		expect(missing[0]?.detail.fields).toEqual(["title", "description"]);
	});

	it("reports the two English pages sharing a title, once", async () => {
		/**
		 * End to end from real HTML: the fixture serves `/meta/twin-a` and
		 * `/meta/twin-b` one title between them, which is the defect confirmed on
		 * the client site in miniature. One finding naming both pages — not one
		 * finding per page.
		 */
		const { findings } = await detect();
		const duplicated = findings.filter(
			(f) =>
				f.type === FINDING_TYPES.METADATA_DUPLICATED &&
				f.detail.language === "en",
		);

		expect(duplicated).toHaveLength(1);
		expect(duplicated[0]?.detail).toMatchObject({
			field: "title",
			language: "en",
			value: "Legal information",
			urls: [`${site.baseUrl}/meta/twin-a`, `${site.baseUrl}/meta/twin-b`],
		});
	});

	it("reports the two pages sharing a title in no established language", async () => {
		/**
		 * `/legal/imprint` and `/legal/privacy`: no hreflang, no locale segment,
		 * one title between them. Every page of a monolingual site looks like this,
		 * and the rule skipped them entirely until FR-020 asked about duplicates
		 * across URLs rather than within a language.
		 */
		const { findings } = await detect();
		const duplicated = findings.filter(
			(f) =>
				f.type === FINDING_TYPES.METADATA_DUPLICATED &&
				f.detail.language === null,
		);

		expect(duplicated).toHaveLength(1);
		expect(duplicated[0]?.detail).toMatchObject({
			field: "title",
			language: null,
			value: "Company information",
			urls: [`${site.baseUrl}/legal/imprint`, `${site.baseUrl}/legal/privacy`],
		});
	});

	it("reports one body served at two addresses, and not the translated pair", async () => {
		/**
		 * `/library/guide` and `/library/guide-archived` serve one body in one
		 * language — the case rule 7 declines by design.
		 *
		 * The second assertion is the one that matters most: `/handbook` and
		 * `/de/handbuch` also serve identical bodies, and rule 7 already reports
		 * them as untranslated. They must not appear here as well, or the fixture's
		 * clearest defect arrives twice under two headings.
		 */
		const { findings } = await detect();
		const duplicated = findings.filter(
			(f) => f.type === FINDING_TYPES.CONTENT_DUPLICATED,
		);

		expect(duplicated).toHaveLength(1);
		expect(duplicated[0]?.url).toBeNull();
		expect(duplicated[0]?.detail.urls).toEqual([
			`${site.baseUrl}/library/guide`,
			`${site.baseUrl}/library/guide-archived`,
		]);
	});

	it("reports the sitemap URL that does not load", async () => {
		/**
		 * `/library/removed` is listed in the sitemap and 404s.
		 *
		 * The count is the assertion. The sitemap also lists `/private/secret`,
		 * which the crawl was configured not to visit — and that must *not* appear
		 * here, because its absence from the crawl is our configuration rather than
		 * the site failing.
		 */
		const { findings } = await detect();
		const failed = findings.filter(
			(f) => f.type === FINDING_TYPES.SITEMAP_URL_FAILED,
		);

		expect(failed).toHaveLength(1);
		expect(failed[0]?.detail.entries).toEqual([
			{
				raw: `${site.baseUrl}/library/removed`,
				normalised: `${site.baseUrl}/library/removed`,
				httpStatus: 404,
				fetchError: null,
			},
		]);
	});

	it("reports the one live page the sitemap leaves out", async () => {
		/**
		 * The fixture's sitemap is deliberately near-complete, omitting exactly
		 * `/library/guide-archived` — because a sparse sitemap makes this rule name
		 * most of the site at once, which is the volume failure the slice is most
		 * at risk of and which broke two unrelated assertions here on the first
		 * attempt.
		 *
		 * The corpus-level count travels with the finding, so a reader can see how
		 * long the list was that this page is missing from.
		 */
		const { findings } = await detect();
		const missing = findings.filter(
			(f) => f.type === FINDING_TYPES.PAGE_MISSING_FROM_SITEMAP,
		);

		expect(missing).toHaveLength(1);
		expect(missing[0]?.url).toBeNull();
		expect(missing[0]?.detail.urls).toEqual([
			`${site.baseUrl}/library/guide-archived`,
		]);
		expect(missing[0]?.detail.discovery).toBe("robots");
	});

	it("reports the sitemap page nothing on the site links to", async () => {
		/**
		 * `/archive/unlinked` is served, is in the sitemap, and appears in no page's
		 * link list — so the crawl never requests it at all.
		 *
		 * That is the whole point of the case. An orphan is by definition not
		 * linked, so a link-following crawl can only ever see one by its absence,
		 * and a rule inspecting recorded pages for a missing inbound link could
		 * never fire on the common shape.
		 */
		const { pages, findings } = await detect();
		const orphaned = findings.filter(
			(f) => f.type === FINDING_TYPES.PAGE_ORPHANED,
		);

		expect(
			pages.some((p) => p.url === `${site.baseUrl}/archive/unlinked`),
		).toBe(false);

		expect(orphaned).toHaveLength(1);
		expect(orphaned[0]?.url).toBeNull();
		expect(orphaned[0]?.detail.urls).toEqual([
			`${site.baseUrl}/archive/unlinked`,
		]);
	});

	it("reports the robots.txt rule blocking a URL the sitemap submits", async () => {
		/**
		 * The fixture disallows `/private` and its sitemap submits
		 * `/private/secret`. Two opposing assertions by the same site, in two files,
		 * and the finding is stated entirely in quotation.
		 *
		 * This is also the case that proves the rule ignores the crawl's configured
		 * scope: `/private` is excluded here, so the page was never fetched and the
		 * finding rests on nothing we observed.
		 */
		const { findings } = await detect();
		const blocked = findings.filter(
			(f) => f.type === FINDING_TYPES.ROBOTS_BLOCKS_INDEXABLE,
		);

		expect(blocked).toHaveLength(1);
		expect(blocked[0]?.url).toBeNull();
		expect(blocked[0]?.detail).toMatchObject({
			rule: "/private",
			ruleLine: "Disallow: /private",
			urls: [`${site.baseUrl}/private/secret`],
		});
	});

	it("evaluates robots.txt as googlebot rather than as the wildcard group", async () => {
		/**
		 * The fixture publishes a `googlebot` group alongside `*`, and Googlebot
		 * ignores the wildcard entirely once a group names it. The finding must
		 * therefore say which audience the blocking rule addressed — a site whose
		 * wildcard group is permissive and whose googlebot group blocks everything
		 * is catastrophically blocked in the way that counts.
		 */
		const { findings } = await detect();
		const blocked = findings.filter(
			(f) => f.type === FINDING_TYPES.ROBOTS_BLOCKS_INDEXABLE,
		);

		expect(blocked[0]?.detail.userAgentGroup).toBe("googlebot");
	});
	it("reports the one dead link no other rule speaks for", async () => {
		/**
		 * `/library/removed` is linked from `/library/guide` and never served.
		 *
		 * The count is the assertion that matters. `/de/kontakt`, the French careers
		 * variant and `/meta/nowhere` are all dead too, and all three are already
		 * named by rules 2, 6 and 13 respectively — so exactly one finding here is
		 * what proves the deferral works over real HTTP rather than only against
		 * hand-built page records.
		 */
		const { findings } = await detect();
		const broken = findings.filter((f) => f.type === FINDING_TYPES.LINK_BROKEN);

		expect(broken).toHaveLength(1);
		expect(broken[0]?.url).toBeNull();
		expect(broken[0]?.detail).toMatchObject({
			target: `${site.baseUrl}/library/removed`,
			httpStatus: 404,
			confirmed: false,
			linkedFrom: [`${site.baseUrl}/library/guide`],
		});
	});

	it("says nothing about two languages sharing one title", async () => {
		/**
		 * `/meta/cross-en` and `/meta/cross-de` both publish "Yazaki". A brand name
		 * is the same word in every locale, and rule 7 already reports a page whose
		 * German copy really is the English one — so this pair must stay silent, or
		 * the rule reports honest translations as defective.
		 */
		const { findings } = await detect();
		const pair = [
			`${site.baseUrl}/meta/cross-en`,
			`${site.baseUrl}/meta/cross-de`,
		];

		const about = findings.filter((f) => {
			const urls = Array.isArray(f.detail.urls)
				? (f.detail.urls as string[])
				: [];
			return pair.includes(f.url ?? "") || urls.some((u) => pair.includes(u));
		});

		expect(about).toEqual([]);
	});

	it("says nothing about the page whose metadata is complete", async () => {
		/**
		 * The negative assertion for the whole slice. `/meta/complete` publishes a
		 * unique title, a unique description, a self-referential canonical and
		 * directives asking to be indexed. If it ever appears in a finding, a rule
		 * has started reporting a correctly configured page.
		 */
		const { findings } = await detect();
		const complete = `${site.baseUrl}/meta/complete`;

		const about = findings.filter((f) => {
			const urls = Array.isArray(f.detail.urls)
				? (f.detail.urls as string[])
				: [];
			return f.url === complete || urls.includes(complete);
		});

		expect(about).toEqual([]);
	});

	it("reports the one page declaring two different canonicals", async () => {
		const { findings } = await detect();
		const conflicting = findings.filter(
			(f) => f.type === FINDING_TYPES.CANONICAL_CONFLICTING,
		);

		expect(conflicting).toHaveLength(1);
		expect(conflicting[0]?.url).toBe(`${site.baseUrl}/meta/two-canonicals`);
		expect(conflicting[0]?.detail).toMatchObject({
			kind: "multiple",
			canonicals: [
				`${site.baseUrl}/meta/two-canonicals`,
				`${site.baseUrl}/meta/complete`,
			],
		});
	});

	it("reports the one canonical pointing at a page that 404s", async () => {
		const { findings } = await detect();
		const broken = findings.filter(
			(f) => f.type === FINDING_TYPES.CANONICAL_TARGET_BROKEN,
		);

		expect(broken).toHaveLength(1);
		expect(broken[0]?.url).toBe(`${site.baseUrl}/meta/canonical-gone`);
		expect(broken[0]?.detail).toMatchObject({
			kind: "failed",
			canonical: `${site.baseUrl}/meta/nowhere`,
			httpStatus: 404,
		});
	});

	it("reports the one page declaring no canonical", async () => {
		/**
		 * End to end, this is also the assertion that every *other* fixture page's
		 * relative, self-referential canonical resolved against the URL it was
		 * served from. Thirty pages write `href="/some/path"`; if any of them
		 * resolved somewhere else, it would arrive here as a chain, a broken target
		 * or a second missing canonical.
		 */
		const { findings } = await detect();
		const missing = findings.filter(
			(f) => f.type === FINDING_TYPES.CANONICAL_MISSING,
		);

		expect(missing).toHaveLength(1);
		expect(missing[0]?.url).toBe(`${site.baseUrl}/meta/no-canonical`);
	});

	it("reports each page carrying a noindex, from whichever channel", async () => {
		/**
		 * Three fixture pages and no others. `/meta/complete` asks to be indexed on
		 * both channels, so it is also the assertion that a page saying `index` is
		 * not swept up by a rule reading the same two places.
		 */
		const { findings } = await detect();
		const noindex = findings.filter(
			(f) => f.type === FINDING_TYPES.NOINDEX_PRESENT,
		);

		expect(noindex.map((f) => f.url).sort()).toEqual([
			`${site.baseUrl}/meta/noindex-header`,
			`${site.baseUrl}/meta/noindex-markup`,
			`${site.baseUrl}/meta/noindex-mixed`,
		]);
	});

	it("names the channel that carried the directive, end to end", async () => {
		const { findings } = await detect();
		const at = (path: string) =>
			findings.find(
				(f) =>
					f.type === FINDING_TYPES.NOINDEX_PRESENT &&
					f.url === `${site.baseUrl}${path}`,
			)?.detail;

		expect(at("/meta/noindex-markup")).toMatchObject({
			channels: ["markup"],
			indexingChannels: [],
		});

		/**
		 * Read from a real response header, which is the half of this requirement
		 * that could not exist before the crawler kept one.
		 */
		expect(at("/meta/noindex-header")).toMatchObject({
			channels: ["header"],
			indexingChannels: [],
		});

		/**
		 * The dangerous shape, whole: the header deindexes the page while the
		 * markup everyone reads says `index`.
		 */
		expect(at("/meta/noindex-mixed")).toMatchObject({
			channels: ["header"],
			indexingChannels: ["markup"],
		});
	});
});

describe("detectMissingVariants edge cases", () => {
	const allInScope = () => true;

	it("does not report missing locales for a family with no locale evidence", async () => {
		// Two unrelated pages, neither declaring anything. Expecting three locales
		// must not turn each into three findings.
		const findings = detectMissingVariants({
			pages: [page("https://x.test/a"), page("https://x.test/b")],
			expectedLocales: ["en", "de", "fr"],
			crawlComplete: true,
			reverified: [],
			certificate: null,
			robots: null,
			sitemap: null,
			entryUrl: null,
			requested: [],
			external: { checked: [], complete: false },
			inScope: allInScope,
		});

		expect(findings).toHaveLength(0);
	});

	/**
	 * Regression guard, found by running the real interface rather than by a test.
	 *
	 * A page whose declared German variant 404s was reported twice: once as
	 * "declared variant is broken", once as "no German version". One problem
	 * wearing two names, on the very screen a user judges the product by.
	 */
	it("does not also report a locale as missing when its page merely failed", () => {
		const healthy: CrawledPage = {
			url: "https://x.test/about",
			httpStatus: 200,
			hreflangTargets: {
				en: "https://x.test/about",
				de: "https://x.test/ueber-uns",
			},
			links: [],
			content: emptyContent(true),
			metadata: emptyMetadata(),
			xRobotsTag: null,
			securityHeaders: {},
			fetchError: null,
		};
		// The declared German page exists but is broken, and its URL carries no
		// locale — so only the sibling's declaration identifies it.
		const broken: CrawledPage = {
			url: "https://x.test/ueber-uns",
			httpStatus: 404,
			hreflangTargets: {},
			links: [],
			content: emptyContent(true),
			metadata: emptyMetadata(),
			xRobotsTag: null,
			securityHeaders: {},
			fetchError: null,
		};

		const findings = detectMissingVariants({
			pages: [healthy, broken],
			expectedLocales: ["en", "de"],
			crawlComplete: true,
			reverified: [],
			certificate: null,
			robots: null,
			sitemap: null,
			entryUrl: null,
			requested: [],
			external: { checked: [], complete: false },
			inScope: allInScope,
		});

		// The breakage is reported...
		expect(
			findings.filter((f) => f.type === FINDING_TYPES.HREFLANG_TARGET_FAILED),
		).toHaveLength(1);
		// ...and not a second time as an absence.
		expect(
			findings.filter((f) => f.type === FINDING_TYPES.MISSING_LOCALE),
		).toHaveLength(0);
	});

	it("still reports a locale no page claims at all", () => {
		// The correction above must not silence a genuine gap: French is expected
		// and nothing — working or broken — claims to be French.
		const en: CrawledPage = {
			url: "https://x.test/about",
			httpStatus: 200,
			hreflangTargets: {
				en: "https://x.test/about",
				de: "https://x.test/ueber-uns",
			},
			links: [],
			content: emptyContent(true),
			metadata: emptyMetadata(),
			xRobotsTag: null,
			securityHeaders: {},
			fetchError: null,
		};
		const de: CrawledPage = {
			url: "https://x.test/ueber-uns",
			httpStatus: 200,
			hreflangTargets: {
				en: "https://x.test/about",
				de: "https://x.test/ueber-uns",
			},
			links: [],
			content: emptyContent(true),
			metadata: emptyMetadata(),
			xRobotsTag: null,
			securityHeaders: {},
			fetchError: null,
		};

		const findings = detectMissingVariants({
			pages: [en, de],
			expectedLocales: ["en", "de", "fr"],
			crawlComplete: true,
			reverified: [],
			certificate: null,
			robots: null,
			sitemap: null,
			entryUrl: null,
			requested: [],
			external: { checked: [], complete: false },
			inScope: allInScope,
		});

		const missing = findings.filter(
			(f) => f.type === FINDING_TYPES.MISSING_LOCALE,
		);
		expect(missing).toHaveLength(1);
		expect(missing[0]?.detail.missingLocale).toBe("fr");
	});

	it("ignores a family in which every member errored", () => {
		const broken: CrawledPage = {
			url: "https://x.test/de/gone",
			httpStatus: 500,
			hreflangTargets: {},
			links: [],
			content: emptyContent(true),
			metadata: emptyMetadata(),
			xRobotsTag: null,
			securityHeaders: {},
			fetchError: null,
		};

		const findings = detectMissingVariants({
			pages: [broken],
			expectedLocales: ["en", "de"],
			crawlComplete: true,
			reverified: [],
			certificate: null,
			robots: null,
			sitemap: null,
			entryUrl: null,
			requested: [],
			external: { checked: [], complete: false },
			inScope: allInScope,
		});

		expect(
			findings.filter((f) => f.type === FINDING_TYPES.MISSING_LOCALE),
		).toHaveLength(0);
	});
});
