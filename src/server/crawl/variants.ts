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

/**
 * The two-letter language codes of ISO 639-1, in full.
 *
 * The shape of a segment is not enough to know it names a language. `/us/` is a
 * market, `/go/` is a redirect path, `/ok/` is a status — all two letters, none
 * of them languages. Without this list every such segment became a locale, and
 * an ordinary English site reported one "no language variants declared" finding
 * per section.
 *
 * Written out rather than derived at runtime: `Intl` will happily accept `us` as
 * a well-formed tag, because well-formed and meaningful are different questions.
 * The list is a closed standard and has not changed since 2002.
 */
const ISO_639_1 = new Set(
	`aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co
	 cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl
	 gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg
	 ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk
	 ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps
	 pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta
	 te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za
	 zh zu`.split(/\s+/),
);

/**
 * The fallback pointer defined by the hreflang guidance, for users whose
 * language matches nothing on offer.
 *
 * It is not a language, and it usually points at the same URL as the site's
 * primary one. Read as a language it renames that page — so a site publishing
 * English at `/` was reported as missing English, with the finding pointing at
 * the English page.
 */
const NOT_A_LANGUAGE = "x-default";

/** Whether an hreflang value names a language at all. */
export function isLanguageTag(value: string): boolean {
	const tag = value.toLowerCase();
	if (tag === NOT_A_LANGUAGE) return false;

	const primary = tag.split(/[-_]/)[0] ?? "";
	return ISO_639_1.has(primary);
}

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

	const locale = match[1].toLowerCase().replace("_", "-");
	return isLanguageTag(locale) ? locale : null;
}

/** One member of a family, with the declarations it actually makes. */
export type FamilyMember = {
	url: string;
	locale: string | null;
	/**
	 * Sibling URLs this page declares under a language tag, excluding itself.
	 *
	 * Language tags only: a fallback pointer says where to send unmatched users,
	 * not that its target is a translation, so counting it as an edge would
	 * report a missing declaration on most real multilingual sites.
	 */
	declares: Set<string>;
	/** Whether the page declares itself under a language tag, as the spec asks. */
	declaresSelf: boolean;
};

export type VariantFamily = {
	/** Stable across runs; the lexicographically smallest member URL. */
	groupKey: string;
	members: FamilyMember[];
};

/**
 * The families a crawl found, with each member's outbound declarations.
 *
 * Exposes what `groupVariants` already traverses rather than walking the graph
 * a second time. The rules that read this ask questions the grouping does not:
 * whether a declaration is returned, and whether a member names everything its
 * family publishes. Grouping deliberately ignores both — it treats a
 * one-directional edge as a sibling relationship, which is right for deciding
 * *who is related* and is exactly what leaves the asymmetry unreported.
 *
 * Members and families are returned in URL order so that findings built from
 * them are stable between runs of the same site.
 */
export function groupFamilies(pages: CrawledPage[]): VariantFamily[] {
	const variants = groupVariants(pages);
	const byGroup = new Map<string, FamilyMember[]>();

	for (const page of [...pages].sort((a, b) => a.url.localeCompare(b.url))) {
		const variant = variants.get(page.url);
		if (!variant) continue;

		const declares = new Set<string>();
		let declaresSelf = false;

		for (const [locale, target] of Object.entries(page.hreflangTargets)) {
			if (!isLanguageTag(locale)) continue;
			if (target === page.url) declaresSelf = true;
			else declares.add(target);
		}

		const members = byGroup.get(variant.groupKey) ?? [];
		members.push({
			url: page.url,
			locale: variant.locale,
			declares,
			declaresSelf,
		});
		byGroup.set(variant.groupKey, members);
	}

	return [...byGroup.entries()]
		.map(([groupKey, members]) => ({ groupKey, members }))
		.sort((a, b) => a.groupKey.localeCompare(b.groupKey));
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
			// A fallback pointer says where to send unmatched users, not what
			// language the target is in.
			if (!isLanguageTag(locale)) continue;
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
			([locale, url]) => url === page.url && isLanguageTag(locale),
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
