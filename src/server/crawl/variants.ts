import type { CrawledPage } from "./crawler";

/**
 * Deciding which crawled pages are translations of one another.
 *
 * The grouping comes from the site's own hreflang declarations rather than from
 * configuration, because asking an operator to map 200 pages across 4 locales by
 * hand is the setup cost that stops a tool being used at all.
 *
 * Two properties matter and are both tested:
 *
 * 1. **Order independence.** The group a page lands in must not depend on which
 *    page the crawl happened to reach first, or the same site would produce
 *    different findings on different runs.
 * 2. **Symmetry.** If either page declares the other, they are siblings. Real
 *    sites frequently declare hreflang in only one direction, and treating that
 *    as "not related" would report the healthy half of a pair as an orphan.
 */

export type PageVariant = {
	url: string;
	/** BCP-47-ish tag, lowercased. Null when nothing indicated one. */
	locale: string | null;
	/** Stable across runs and independent of crawl order. */
	groupKey: string;
};

/**
 * Locale segment at the start of a path: `/de/…`, `/fr-ca/…`, `/pt_BR/…`.
 *
 * Deliberately conservative. It is used both to detect a page's locale and — in
 * the finding rules — to decide whether a page *claims* to be localised at all,
 * so a loose pattern here would turn `/design/` or `/media/` into a locale and
 * manufacture findings on monolingual sites.
 */
const LOCALE_SEGMENT = /^\/([a-z]{2}(?:[-_][a-z]{2,4})?)(?:\/|$)/i;

/** The locale a URL's own path implies, if any. */
export function localeFromUrl(url: string): string | null {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		return null;
	}

	const match = LOCALE_SEGMENT.exec(pathname);
	if (!match?.[1]) return null;
	return match[1].toLowerCase().replace("_", "-");
}

/**
 * Groups crawled pages into variant families.
 *
 * Union-find over the hreflang graph. The group key is the lexicographically
 * smallest URL in the family, which is what makes it stable: it depends only on
 * the set of members, never on the order they arrived.
 */
export function groupVariants(pages: CrawledPage[]): Map<string, PageVariant> {
	const parent = new Map<string, string>();

	const find = (url: string): string => {
		const seen = parent.get(url);
		if (seen === undefined || seen === url) {
			parent.set(url, url);
			return url;
		}
		const root = find(seen);
		parent.set(url, root);
		return root;
	};

	const union = (a: string, b: string): void => {
		const rootA = find(a);
		const rootB = find(b);
		if (rootA === rootB) return;
		// Attach the larger to the smaller so the root is always the smallest URL.
		if (rootA < rootB) parent.set(rootB, rootA);
		else parent.set(rootA, rootB);
	};

	const crawled = new Set(pages.map((page) => page.url));
	for (const page of pages) find(page.url);

	for (const page of pages) {
		for (const target of Object.values(page.hreflangTargets)) {
			/**
			 * Only union with pages the crawl actually saw. A declared sibling that
			 * was never reached is a *finding*, not a group member — folding it in
			 * would let an unreachable URL silently satisfy a locale expectation.
			 */
			if (crawled.has(target)) union(page.url, target);
		}
	}

	/**
	 * What every page says about every *other* page.
	 *
	 * This is what lets a broken variant still be recognised as the variant it was
	 * meant to be. A page that 404s carries no hreflang of its own and may have no
	 * locale in its URL, so without this it has no locale at all — and a family
	 * containing it would be reported as missing that locale entirely, on top of
	 * the separate finding that the variant is broken. One problem, reported twice
	 * under two different names.
	 *
	 * The declaration is evidence about the target regardless of whether the
	 * target loaded.
	 */
	const declaredBySiblings = new Map<string, string>();
	for (const page of pages) {
		for (const [locale, target] of Object.entries(page.hreflangTargets)) {
			if (target === page.url) continue;
			if (!declaredBySiblings.has(target)) {
				declaredBySiblings.set(target, locale.toLowerCase());
			}
		}
	}

	const variants = new Map<string, PageVariant>();

	for (const page of pages) {
		/**
		 * Precedence, strongest evidence first:
		 *
		 * 1. The page's own declaration — the site naming its own language.
		 * 2. What a sibling declared it as — still the site speaking, just about
		 *    this page rather than by it.
		 * 3. The URL's shape — our inference, used only when the site said nothing.
		 */
		const selfDeclared = Object.entries(page.hreflangTargets).find(
			([, url]) => url === page.url,
		)?.[0];

		variants.set(page.url, {
			url: page.url,
			locale:
				selfDeclared?.toLowerCase() ??
				declaredBySiblings.get(page.url) ??
				localeFromUrl(page.url),
			groupKey: find(page.url),
		});
	}

	return variants;
}
