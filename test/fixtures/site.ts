import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A deliberately imperfect multilingual site, served from the test process.
 *
 * This fixture is the specification of what each finding means. Every page below
 * exists to make one rule fire — or, just as importantly, to make sure a rule
 * does *not* fire. When a detection rule changes, change this fixture first and
 * let the tests tell you what broke.
 *
 * Tests crawl real HTTP rather than a stubbed fetch because the behaviour most
 * worth protecting — concurrency ceiling, inter-request delay, abort on a
 * failure burst — only exists in the network path. A stub would leave exactly
 * the machinery that can damage a client's site untested.
 *
 * **Every page added here is paid for by every test that crawls this site.**
 * Most of them run with no request delay and hardly notice. One does not:
 * `run.test.ts`'s "never requests a path the project excluded" goes through
 * `project.create` and so inherits the real politeness defaults — two at a time,
 * 500ms apart — because that pacing is the thing it exists to prove. Adding six
 * pages in S-02 pushed it from 5017ms past its 5000ms limit, which is how this
 * note came to be written. Its budget is now 30s; if a future addition pushes it
 * again, raise the budget rather than removing the pacing.
 */

type Page = {
	/** locale → path, rendered as hreflang links. */
	alternates?: Record<string, string>;
	links?: string[];
	body?: string;
	/**
	 * Wraps the body in `<main>`, so the content extractor can isolate it.
	 *
	 * Both shapes need to exist. A page with `<main>` proves isolation works; a
	 * page without it proves the fallback is recorded rather than mistaken for
	 * the real thing — which is what stops a rule reporting on navigation.
	 */
	main?: boolean;
	status?: number;
	/**
	 * `<title>` text. Absent uses the path; `null` omits the tag entirely.
	 *
	 * A default rather than nothing, because every page here is crawled by the
	 * metadata rules too: if titles were absent by default, the missing-title
	 * rule would fire on thirty pages that exist to exercise something else, and
	 * the pages that *should* fire would be invisible among them.
	 */
	title?: string | null;
	/** Meta description. Absent derives one from the path; `null` omits it. */
	description?: string | null;
	/**
	 * Canonical hrefs. Absent declares one self-referential canonical; `null`
	 * declares none.
	 *
	 * Self-referential by default and written relative, which makes every
	 * ordinary page of this fixture proof that a relative canonical resolves
	 * against the URL it was served from.
	 */
	canonical?: string[] | null;
	/** `content` of a `<meta name="robots">` tag. */
	robots?: string;
	/**
	 * Extra response headers.
	 *
	 * The reason this exists is `X-Robots-Tag`: a `noindex` served at the CDN or
	 * framework layer is invisible in page source, and a fixture that could only
	 * express the markup channel would leave the more dangerous one untested.
	 */
	headers?: Record<string, string>;
};

/**
 * Bodies long enough to be compared.
 *
 * The content extractor refuses to digest anything under `MIN_COMPARABLE_CHARS`,
 * because two nearly-empty pages match each other by accident. Every existing
 * fixture body is one short sentence, so these are written at realistic length
 * on purpose — a shorter version would silently exercise the guard instead of
 * the rule.
 */
const HANDBOOK_EN = `<h2>Configuring a project</h2>
    <p>A project describes one site: where a crawl begins, which paths it may
    follow, and which languages the site is expected to publish. Every check the
    product performs is scoped to a single project, so the settings here decide
    what any later run is able to say about the site.</p>
    <ul><li>Start URL</li><li>Included paths</li><li>Expected locales</li></ul>`;

/**
 * One body published at two addresses, in one language.
 *
 * Deliberately not `HANDBOOK_EN`: that body belongs to the untranslated-sibling
 * family, and a third page carrying it would make the duplicate-content rule
 * report a set larger than the one rule 7 named. That interaction is worth
 * testing, but in `site-shapes.test.ts` where it can be stated in isolation —
 * here it would blur two rules' fixtures into each other.
 */
const ARCHIVE_NOTE = `<h2>Retention and archiving</h2>
    <p>Runs are kept for as long as the project exists, so that a comparison
    against a previous run always has something to compare against. Deleting a
    project deletes its runs, its pages and every finding recorded against
    them, and that deletion is immediate rather than deferred to a batch.</p>
    <ul><li>Runs</li><li>Pages</li><li>Findings</li></ul>`;

const HANDBOOK_FR = `<h2>Configurer un projet</h2>
    <p>Un projet décrit un seul site : le point de départ d'une exploration, les
    chemins qu'elle peut suivre, et les langues que le site est censé publier.
    Chaque vérification effectuée par le produit est limitée à un seul projet.</p>
    <ul><li>URL de départ</li><li>Chemins inclus</li><li>Langues attendues</li></ul>`;

/**
 * The site map. Read this as the test's expectations.
 *
 * - `/` and `/de/`, `/fr/` — a healthy group: three locales, reciprocal hreflang.
 * - `/pricing`, `/de/preise` — declares an `fr` sibling the project expects but
 *   the site does not publish. Fires rule 1 (declared locale absent).
 * - `/contact` — declares a `de` sibling that 404s. Fires rule 2.
 * - `/about` — declares a `de` sibling outside the crawl scope. Fires rule 3.
 * - `/de/blog-post` — locale-shaped URL, no hreflang at all. Fires rule 4.
 * - `/blog/monolingual` — no hreflang, no locale in the URL. Must fire NOTHING;
 *   this is the negative assertion that guards the rule-4 narrowing.
 * - `/support`, `/de/hilfe`, `/fr/aide` — a family whose members disagree about
 *   each other. Fires rule 5 (declarations not returned).
 * - `/careers`, `/de/karriere` — two healthy siblings both declaring a French
 *   variant that 404s. Fires rule 6 (one variant failing while siblings are fine).
 * - `/handbook`, `/de/handbuch`, `/fr/manuel` — the German page serves the
 *   English body unchanged. Fires rule 7 (untranslated), sibling half.
 * - `/blog/draft` — an unrendered `{{ headline }}` reached the reader. Fires
 *   rule 7, marker half, and nothing else.
 * - `/quote`, `/de/angebot`, `/fr/devis` — the English page has a form its
 *   translations lack. Fires rule 8 (structure differs).
 * - `/story`, `/de/geschichte`, `/fr/histoire` — honest translations of
 *   materially different lengths. Must fire NOTHING; this is the negative
 *   assertion answering the PRD's objection that content drift is noise by
 *   default.
 * - `/redirect-hub` → `/moved/page` and `/final/page` — two routes to one
 *   page, the alias listed first. `/redirect-hub-reversed` lists them the other
 *   way round; only reachable as a start URL, so ordinary crawls stay small.
 * - `/final/page` — carries a **relative** link, so a redirected page proves
 *   which URL its hrefs resolve against. None of these paths is locale-shaped,
 *   so no detection rule speaks about them.
 * - `/library/guide`, `/library/guide-archived` — one body at two addresses, one
 *   language, no family between them. Fires rule 15 (duplicate content).
 * - `/legal/imprint`, `/legal/privacy` — one title, and no established language
 *   on either page. Fires rule 10 through its unlocalised bucket.
 * - `/private/secret` — only reachable if excludePaths is ignored.
 * - `/slow`, `/flaky` — timing and abort behaviour.
 */
const SITE: Record<string, Page> = {
	"/": {
		alternates: { en: "/", de: "/de/", fr: "/fr/" },
		links: [
			"/pricing",
			"/contact",
			"/about",
			"/blog/monolingual",
			"/de/",
			"/fr/",
			"/de/blog-post",
			"/support",
			"/careers",
			"/handbook",
			"/quote",
			"/story",
			"/blog/draft",
			"/redirect-hub",
			"/private/secret",
			"/?utm_source=nav",
			"/meta/bare",
			"/meta/twin-a",
			"/meta/twin-b",
			"/meta/cross-en",
			"/meta/cross-de",
			"/meta/two-canonicals",
			"/meta/no-canonical",
			"/meta/canonical-gone",
			"/meta/noindex-markup",
			"/meta/noindex-header",
			"/meta/noindex-mixed",
			"/meta/complete",
			"/library/guide",
			"/library/guide-archived",
			"/legal/imprint",
			"/legal/privacy",
		],
	},
	"/de/": {
		alternates: { en: "/", de: "/de/", fr: "/fr/" },
		links: ["/de/preise"],
	},
	"/fr/": { alternates: { en: "/", de: "/de/", fr: "/fr/" } },

	// Rule 1: the project expects en/de/fr; this group publishes only en and de.
	"/pricing": { alternates: { en: "/pricing", de: "/de/preise" } },
	"/de/preise": { alternates: { en: "/pricing", de: "/de/preise" } },

	// Rule 2: the declared German sibling does not exist.
	"/contact": { alternates: { en: "/contact", de: "/de/kontakt" } },

	// Rule 3: the declared sibling is outside the crawl scope.
	"/about": { alternates: { en: "/about", de: "/private/ueber-uns" } },

	/**
	 * Rule 5: declarations that are not returned.
	 *
	 * `/support` names all three members. `/de/hilfe` names French but not
	 * English, and `/fr/aide` names English but not German — so each is declared
	 * by a sibling it does not declare back, which is the non-reciprocal shape
	 * FR-025 names.
	 *
	 * Every member still declares one non-self alternate, deliberately: a member
	 * whose only alternate was itself would fire rule 4 as well, and this family
	 * exists to exercise one rule at a time.
	 */
	"/support": {
		alternates: { en: "/support", de: "/de/hilfe", fr: "/fr/aide" },
	},
	"/de/hilfe": { alternates: { de: "/de/hilfe", fr: "/fr/aide" } },
	"/fr/aide": { alternates: { fr: "/fr/aide", en: "/support" } },

	/**
	 * Rule 6: one variant failing while its siblings are fine.
	 *
	 * Both healthy members declare `/fr/carrieres`, which is absent and so 404s.
	 * Two declarers is exactly the threshold at which the per-URL reports collapse
	 * into a single divergence finding — with one declarer the existing per-URL
	 * finding is left alone, which is what `/contact` covers.
	 */
	"/careers": {
		alternates: { en: "/careers", de: "/de/karriere", fr: "/fr/carrieres" },
	},
	"/de/karriere": {
		alternates: { en: "/careers", de: "/de/karriere", fr: "/fr/carrieres" },
	},

	/**
	 * Rule 7, sibling half: content that was never sent to a translator.
	 *
	 * `/de/handbuch` serves the English body byte for byte. That is the realistic
	 * shape — a page duplicated from the source language and never translated,
	 * carrying no marker of any kind and looking perfectly healthy to every other
	 * rule in the product.
	 *
	 * The French member is genuinely translated, so this family is also the
	 * evidence that the rule reports one member rather than the whole set. All
	 * three locales are published deliberately: an en/de-only family would fire
	 * rule 1 as well, and this family exists to exercise one rule at a time.
	 */
	"/handbook": {
		alternates: { en: "/handbook", de: "/de/handbuch", fr: "/fr/manuel" },
		body: HANDBOOK_EN,
		main: true,
	},
	"/de/handbuch": {
		alternates: { en: "/handbook", de: "/de/handbuch", fr: "/fr/manuel" },
		body: HANDBOOK_EN,
		main: true,
	},
	"/fr/manuel": {
		alternates: { en: "/handbook", de: "/de/handbuch", fr: "/fr/manuel" },
		body: HANDBOOK_FR,
		main: true,
	},

	/**
	 * Rule 8: variants that disagree about what their content contains.
	 *
	 * The English page carries a quote form; neither translation does. This is the
	 * shape a human recognises instantly — the German visitor cannot request a
	 * quote — and it is invisible to every hreflang rule, because the declarations
	 * are perfect.
	 *
	 * Every member is wrapped in `<main>`, without which the rule declines to
	 * speak: comparing block presence across whole-body extractions would be
	 * comparing navigation.
	 */
	"/quote": {
		alternates: { en: "/quote", de: "/de/angebot", fr: "/fr/devis" },
		body: `<h2>Request a quote</h2>
    <p>Tell us about the site you would like checked and we will come back to you
    with a price. Most projects are quoted within two working days, and larger
    multilingual estates sometimes take a little longer to scope properly.</p>
    <form><label>Email<input name="email"></label></form>`,
		main: true,
	},
	"/de/angebot": {
		alternates: { en: "/quote", de: "/de/angebot", fr: "/fr/devis" },
		body: `<h2>Angebot anfordern</h2>
    <p>Beschreiben Sie uns die Website, die geprüft werden soll, und wir melden
    uns mit einem Preis zurück. Die meisten Projekte werden innerhalb von zwei
    Werktagen kalkuliert, größere mehrsprachige Bestände dauern etwas länger.</p>`,
		main: true,
	},
	"/fr/devis": {
		alternates: { en: "/quote", de: "/de/angebot", fr: "/fr/devis" },
		body: `<h2>Demander un devis</h2>
    <p>Décrivez-nous le site que vous souhaitez faire vérifier et nous vous
    répondrons avec un prix. La plupart des projets sont chiffrés en deux jours
    ouvrés, les ensembles multilingues plus vastes demandent un peu plus.</p>`,
		main: true,
	},

	/**
	 * The negative assertion this whole slice rests on.
	 *
	 * Three honest translations. The German runs materially longer than the
	 * English and the French shorter, which is exactly the objection the PRD
	 * raised against content drift and never resolved: languages legitimately
	 * differ in length. The German also carries an extra `<h3>` the others do not,
	 * because translators genuinely merge and split sections — so heading *counts*
	 * differ here while heading *presence* does not, which is the whole reason
	 * rule 8 compares presence. All three carry the same block types and none
	 * shares text with another, so **both content rules must stay completely
	 * silent here.**
	 *
	 * If this family ever produces a finding, the noise failure the PRD called
	 * fatal has arrived, and the rules are wrong rather than the fixture.
	 */
	"/story": {
		alternates: { en: "/story", de: "/de/geschichte", fr: "/fr/histoire" },
		body: `<h2>Our story</h2>
    <p>We began as a two-person studio taking on whatever work came through the
    door, and gradually found that the projects we enjoyed most were the ones
    nobody else wanted to touch.</p>
    <ul><li>Founded 2019</li><li>Eleven people</li></ul>`,
		main: true,
	},
	"/de/geschichte": {
		alternates: { en: "/story", de: "/de/geschichte", fr: "/fr/histoire" },
		body: `<h2>Unsere Geschichte</h2>
    <p>Wir haben als Studio mit zwei Personen angefangen und jede Arbeit
    angenommen, die zu uns kam. Mit der Zeit stellten wir fest, dass uns
    ausgerechnet jene Projekte am meisten Freude bereiteten, die sonst niemand
    anfassen wollte — die alten, die verworrenen, die in vier Sprachen
    gewachsenen, bei denen niemand mehr genau wusste, welche Seite eigentlich
    das Original war.</p>
    <h3>Wie wir arbeiten</h3>
    <p>Langsam, und mit sehr viel Geduld für alte Systeme.</p>
    <ul><li>Gegründet 2019</li><li>Elf Personen</li></ul>`,
		main: true,
	},
	"/fr/histoire": {
		alternates: { en: "/story", de: "/de/geschichte", fr: "/fr/histoire" },
		body: `<h2>Notre histoire</h2>
    <p>Nous avons commencé à deux, en acceptant tout ce qui se présentait. Peu à
    peu, nous avons constaté que les projets qui nous plaisaient le plus étaient
    ceux dont personne d'autre ne voulait s'occuper.</p>
    <ul><li>Fondé en 2019</li><li>Onze personnes</li></ul>`,
		main: true,
	},

	/**
	 * Rule 7, marker half: a template that reached the reader.
	 *
	 * No locale segment and no hreflang, so every other rule stays silent — the
	 * same isolation `/blog/monolingual` provides for rule 4. Deliberately without
	 * `<main>`, which makes it the fixture's one page proving markers are found on
	 * a fallback extraction too: an unrendered expression is a defect wherever it
	 * appears, unlike a block comparison.
	 */
	"/blog/draft": {
		body: `<h1>{{ headline }}</h1>
    <p>An article whose template never finished rendering. The heading above is
    the giveaway, and it is the kind of thing that reaches production precisely
    because it looks fine to everyone who already knows what it should say.</p>`,
	},

	/**
	 * Redirect aliases. `/moved/page` is not in this map at all — it is served by
	 * REDIRECTS below, which is the point: it exists only as a route.
	 */
	"/redirect-hub": { links: ["/moved/page", "/final/page"] },
	"/redirect-hub-reversed": { links: ["/final/page", "/moved/page"] },
	"/final/page": {
		// Deliberately relative. Resolved against the requested URL this lands on
		// /moved/sibling, which does not exist; against the served URL it lands on
		// /final/sibling, which does.
		links: ["sibling"],
	},
	"/final/sibling": { body: "<p>Reached only by a relative link.</p>" },

	// Rule 4: locale-shaped URL with no hreflang.
	"/de/blog-post": { body: "<p>Ein Beitrag ohne hreflang.</p>" },

	// The negative case. No hreflang, no locale in the URL — must stay silent.
	"/blog/monolingual": { body: "<p>A post that is only ever in English.</p>" },

	// Should never be fetched when /private is excluded.
	"/private/secret": { body: "<p>Should not be crawled.</p>" },

	/**
	 * The metadata shapes, for FR-021, FR-022 and FR-023.
	 *
	 * Every one of them sits under `/meta/`, which is deliberately not
	 * locale-shaped: a `/de/`-style path with no hreflang would fire rule 4 as
	 * well, and the count of rule-4 findings is pinned at one by the suite.
	 *
	 * Where a rule needs to know a page's language — duplicate titles are
	 * language-scoped, or they collide with rule 7 — the page declares it with a
	 * self-referential hreflang rather than by moving into a locale path. That is
	 * how real sites without locale prefixes state a language, and it leaves each
	 * page in a family of one, which is what keeps rules 1 and 5 silent about it.
	 */

	// No title and no description: the missing case, on a page nothing else
	// speaks about.
	"/meta/bare": { title: null, description: null },

	/**
	 * Two English pages publishing the same title. The defect confirmed on the
	 * client site, in miniature: a template fallback that was never filled in.
	 * Their descriptions still differ, so exactly one duplicate is on offer.
	 */
	"/meta/twin-a": {
		alternates: { en: "/meta/twin-a" },
		title: "Legal information",
	},
	"/meta/twin-b": {
		alternates: { en: "/meta/twin-b" },
		title: "Legal information",
	},

	/**
	 * The negative assertion the duplicate rule rests on: one title, two
	 * languages. Two locale variants legitimately share a title — a brand name,
	 * a product name — and rule 7 already reports content that stayed in the
	 * source language. **This pair must stay silent.**
	 */
	"/meta/cross-en": {
		alternates: { en: "/meta/cross-en" },
		title: "Yazaki",
	},
	"/meta/cross-de": {
		alternates: { de: "/meta/cross-de" },
		title: "Yazaki",
	},

	// Two canonical tags naming different URLs: the page disagrees with itself.
	"/meta/two-canonicals": {
		canonical: ["/meta/two-canonicals", "/meta/complete"],
	},

	/**
	 * The only page of this fixture declaring no canonical at all.
	 *
	 * Its being the only one is the point. A canonical tag is optional, so a page
	 * without one is a defect only next to a site that publishes them elsewhere —
	 * and every other page here does, which is exactly the inconsistency the rule
	 * narrows itself to.
	 */
	"/meta/no-canonical": { canonical: null },

	/**
	 * A canonical pointing at a page that 404s. Linked as well as declared,
	 * because the crawler follows anchors and hreflang but not canonicals — and
	 * a target the crawl never requested cannot be known to be broken.
	 */
	"/meta/canonical-gone": {
		canonical: ["/meta/nowhere"],
		links: ["/meta/nowhere"],
	},

	// The two channels a noindex travels on, separately and together.
	"/meta/noindex-markup": { robots: "noindex, nofollow" },
	"/meta/noindex-header": { headers: { "x-robots-tag": "noindex" } },
	/**
	 * The channels disagree. The header wins in practice, which is what makes
	 * this the dangerous shape: everyone reading the page source sees `index`.
	 */
	"/meta/noindex-mixed": {
		robots: "index, follow",
		headers: { "x-robots-tag": "noindex" },
	},

	/**
	 * One body at two addresses, in one language and with no family between them.
	 *
	 * The case rule 7 declines by design — it asks whether a translation was made,
	 * and there is no second language here — and the one FR-020 asks about. Both
	 * declare their own self-referential canonical, so the site has *not* said
	 * which address counts, which is what leaves it a defect.
	 */
	"/library/guide": { body: ARCHIVE_NOTE, main: true },
	"/library/guide-archived": { body: ARCHIVE_NOTE, main: true },

	/**
	 * Two pages sharing a title, in no established language: no hreflang, and no
	 * locale segment in either path. Every page of a monolingual site looks like
	 * this, and until S-04 the duplicate rule skipped them entirely.
	 *
	 * Descriptions are left to default, so exactly one field duplicates and the
	 * finding count is unambiguous.
	 */
	"/legal/imprint": { title: "Company information" },
	"/legal/privacy": { title: "Company information" },

	/**
	 * Complete, correct and unique on every axis. **This page must produce
	 * nothing.** It is the negative assertion for all six metadata rules at once.
	 */
	"/meta/complete": {
		title: "Everything a page should say about itself",
		description:
			"A unique description, a self-referential canonical, and robots directives that ask to be indexed.",
		robots: "index, follow",
		headers: { "x-robots-tag": "index, follow" },
	},

	/**
	 * A page linking to several always-failing URLs, so a crawl can accumulate a
	 * *burst* of failures. A single failing URL cannot: it returns one error, has
	 * no links, and the crawl ends before any threshold is reached.
	 */
	"/flaky-hub": {
		links: ["/flaky/1", "/flaky/2", "/flaky/3", "/flaky/4", "/flaky/5"],
	},
};

/**
 * Routes that answer with a redirect rather than a page.
 *
 * The fixture had none until now, which is exactly why a whole class of defect
 * went unseen: every crawl the suite performed landed on the URL it asked for.
 */
const REDIRECTS: Record<string, string> = {
	"/moved/page": "/final/page",
};

/**
 * Canonical path for lookup.
 *
 * Mirrors the crawler's own normalisation: real servers overwhelmingly treat
 * `/de/` and `/de` as the same page, and a fixture that does not would make the
 * crawler look broken for behaving correctly.
 */
function canonicalPath(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith("/"))
		return pathname.slice(0, -1);
	return pathname;
}

/**
 * SITE keyed by canonical path, so a lookup for `/de` finds the page declared
 * as `/de/`. Without this the fixture 404s on exactly the URLs the crawler
 * correctly normalised.
 */
const INDEX: Record<string, Page> = Object.fromEntries(
	Object.entries(SITE).map(([path, page]) => [canonicalPath(path), page]),
);

export type Fixture = {
	baseUrl: string;
	/** Every path the server was asked for, in order. Reset with `reset()`. */
	requests: string[];
	/** Concurrent in-flight requests, high-water mark. */
	peakConcurrency: number;
	reset: () => void;
	close: () => Promise<void>;
};

function render(path: string, page: Page): string {
	const alternates = Object.entries(page.alternates ?? {})
		.map(
			([locale, href]) =>
				`<link rel="alternate" hreflang="${locale}" href="${href}">`,
		)
		.join("\n    ");

	const links = (page.links ?? [])
		.map((href) => `<a href="${href}">${href}</a>`)
		.join("\n    ");

	/**
	 * The head, assembled from the metadata fields.
	 *
	 * Each of the three has a sensible default and an explicit way to say "this
	 * page publishes none", because both halves are needed: the defaults keep
	 * the metadata rules quiet about the thirty pages that exist for other
	 * reasons, and the opt-outs are the defects themselves.
	 */
	const title =
		page.title === null ? "" : `<title>${page.title ?? path}</title>`;

	const description =
		page.description === null
			? ""
			: `<meta name="description" content="${
					page.description ?? `What ${path} is for, described exactly once.`
				}">`;

	const canonicals = (page.canonical === null ? [] : (page.canonical ?? [path]))
		.map((href) => `<link rel="canonical" href="${href}">`)
		.join("\n    ");

	const robots = page.robots
		? `<meta name="robots" content="${page.robots}">`
		: "";

	const content = page.body ?? `<h1>${path}</h1>`;
	/**
	 * Links stay outside `<main>` on purpose. They are this fixture's navigation,
	 * and a page whose content region included them would digest differently from
	 * its sibling for reasons that have nothing to do with translation — which is
	 * the whole problem main-content isolation exists to solve.
	 */
	const region = page.main ? `<main>\n    ${content}\n    </main>` : content;

	return `<!doctype html>
<html>
  <head>
    ${title}
    ${description}
    ${canonicals}
    ${robots}
    ${alternates}
  </head>
  <body>
    ${region}
    ${links}
  </body>
</html>`;
}

/**
 * Starts the fixture server on an ephemeral port.
 *
 * `flakyFrom` makes `/flaky` return 500 after that many successful hits, so a
 * test can drive the abort-on-failure-burst path deterministically.
 */
export async function startFixtureSite(): Promise<Fixture> {
	const requests: string[] = [];
	let inFlight = 0;
	let peakConcurrency = 0;

	const server: Server = createServer(async (req, res) => {
		inFlight += 1;
		peakConcurrency = Math.max(peakConcurrency, inFlight);

		const path = req.url ?? "/";
		requests.push(path);

		const [pathname] = path.split("?");

		try {
			if (pathname === "/slow") {
				await new Promise((resolve) => setTimeout(resolve, 2_000));
				res.writeHead(200, { "content-type": "text/html" });
				res.end("<html><body>slow</body></html>");
				return;
			}

			// Always fails, for the abort-on-burst test. Note the trailing slash:
			// /flaky-hub must still serve, or it cannot link to the failing URLs.
			if (pathname?.startsWith("/flaky/")) {
				res.writeHead(500, { "content-type": "text/html" });
				res.end("<html><body>boom</body></html>");
				return;
			}

			const key = pathname ? canonicalPath(pathname) : "/";

			const destination = REDIRECTS[key];
			if (destination) {
				res.writeHead(301, { location: destination });
				res.end();
				return;
			}

			const page = INDEX[key];
			if (!page) {
				res.writeHead(404, { "content-type": "text/html" });
				res.end("<html><body>not found</body></html>");
				return;
			}

			res.writeHead(page.status ?? 200, {
				"content-type": "text/html",
				...page.headers,
			});
			res.end(render(key, page));
		} finally {
			inFlight -= 1;
		}
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requests,
		get peakConcurrency() {
			return peakConcurrency;
		},
		reset() {
			requests.length = 0;
			peakConcurrency = 0;
		},
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			),
	} as Fixture;
}
