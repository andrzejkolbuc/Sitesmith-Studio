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
	status?: number;
};

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
			"/private/secret",
			"/?utm_source=nav",
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

	// Rule 4: locale-shaped URL with no hreflang.
	"/de/blog-post": { body: "<p>Ein Beitrag ohne hreflang.</p>" },

	// The negative case. No hreflang, no locale in the URL — must stay silent.
	"/blog/monolingual": { body: "<p>A post that is only ever in English.</p>" },

	// Should never be fetched when /private is excluded.
	"/private/secret": { body: "<p>Should not be crawled.</p>" },

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

	return `<!doctype html>
<html>
  <head>
    <title>${path}</title>
    ${alternates}
  </head>
  <body>
    ${page.body ?? `<h1>${path}</h1>`}
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
			const page = INDEX[key];
			if (!page) {
				res.writeHead(404, { "content-type": "text/html" });
				res.end("<html><body>not found</body></html>");
				return;
			}

			res.writeHead(page.status ?? 200, { "content-type": "text/html" });
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
