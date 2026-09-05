/**
 * Which pages get rendered in a browser.
 *
 * This is the decision the whole render half rests on. A browser costs seconds
 * per page where the crawl costs fractions of one, so everything the product can
 * say about performance is bounded by what this function chose — and a sample
 * chosen badly does not produce a slow run, it produces a confident claim about
 * a site most of which was never looked at.
 *
 * **Why not one page per template per language.** That is what FR-028 asks for,
 * and a page template is not a thing this product can observe. The obvious proxy
 * — the first path segment — fails hardest on exactly the sites this product
 * exists for, because a multilingual site translates its URLs: measured on a
 * real client, `products` / `produkte` / `produits` / `capabilitati` produced
 * **113 distinct sections for roughly ten real ones**, and one page per section
 * per discovered locale came to **143 renders on a 533-page site**. Any formula
 * of the shape *templates x locales* multiplies, and the multiplier is whatever
 * the site happens to publish.
 *
 * **So the sample is capped absolutely and chosen on the site's own evidence.**
 * The entry page, because the crawl entered there. Then the most-linked pages in
 * each locale the project declared — inbound links being the site's own
 * statement about which of its pages matter, rather than our guess about which
 * are representative. Round-robin across locales, so a cap never starves one.
 *
 * What it is not is template coverage, and it must never be described as such.
 * The view names what was sampled; this function records the rule it applied so
 * the view can.
 */

export type SamplePage = {
	url: string;
	locale: string | null;
	httpStatus: number | null;
	fetchError: string | null;
	/** Whether the response was HTML. A PDF has nothing to render. */
	isHtml: boolean;
	/** How many crawled pages link to this one. */
	inboundLinks: number;
};

export type RenderSample = {
	/** The chosen URLs, in the order they should be rendered. */
	urls: string[];
	/** The cap in force, so the view can say what bounded the sample. */
	cap: number;
	/** Locales the sample drew from — the project's, not the site's. */
	locales: string[];
};

/**
 * How many pages a run will render.
 *
 * Small, absolute, and the entire cost control. The measured crawl baseline is
 * ~320s for 533 pages; a render is 5-15s and is bound by the page rather than by
 * our pacer, so twelve renders is a bounded few minutes on top of a run and
 * twelve is a number an operator can be told in advance. The alternative — a
 * formula — is a number nobody can state before the crawl finishes.
 */
export const MAX_RENDERS = 12;

/**
 * Whether a page's locale answers a declared one.
 *
 * The parity grid's rule, and the same one, so a project declaring `en` is
 * served by a page in `en-GB`. Two definitions of "this page is in that
 * language" on one screen would eventually disagree.
 */
const answers = (present: string, declared: string): boolean =>
	present === declared || present.startsWith(`${declared}-`);

const renderable = (page: SamplePage): boolean =>
	page.fetchError === null &&
	page.httpStatus !== null &&
	page.httpStatus < 400 &&
	page.isHtml;

export function chooseRenderSample(
	pages: SamplePage[],
	declaredLocales: string[],
	entryUrl: string | null,
	cap: number = MAX_RENDERS,
): RenderSample {
	const locales = declaredLocales.map((l) => l.toLowerCase());
	/**
	 * Zero means none. Clamping it up to one, as a defensive `Math.max` would,
	 * turns "render nothing" into "render something" — a caller that asked for no
	 * measurement must not receive one.
	 */
	const limit = Math.max(0, cap);
	const candidates = pages.filter(renderable);

	const chosen: string[] = [];
	const taken = new Set<string>();

	const take = (url: string) => {
		if (taken.has(url)) return;
		taken.add(url);
		chosen.push(url);
	};

	/**
	 * The entry page first, always.
	 *
	 * It is the one page the operator certainly meant — they typed its URL into
	 * the project — and on most sites it is the page a visitor sees first, which
	 * makes it the page whose vitals anyone would ask about first.
	 */
	if (limit > 0 && entryUrl && candidates.some((p) => p.url === entryUrl)) {
		take(entryUrl);
	}

	/**
	 * Per declared locale, that locale's pages ranked by how much the site links
	 * to them. Ties broken by URL so two runs of an unchanged site choose the
	 * same pages — a sample that wandered would make every comparison between
	 * runs a comparison of different pages.
	 */
	const byLocale = locales.map((declared) =>
		candidates
			.filter((p) => p.locale !== null && answers(p.locale, declared))
			.sort(
				(a, b) => b.inboundLinks - a.inboundLinks || a.url.localeCompare(b.url),
			),
	);

	/**
	 * Round-robin rather than locale by locale. A cap consumed entirely by the
	 * first language would leave the others unmeasured while reporting a sample
	 * that looks complete, which is the failure this whole slice is trying not to
	 * commit.
	 */
	let depth = 0;
	while (chosen.length < limit) {
		let placed = false;
		for (const ranked of byLocale) {
			if (chosen.length >= limit) break;
			const page = ranked[depth];
			if (!page) continue;
			take(page.url);
			placed = true;
		}
		if (!placed) break;
		depth += 1;
	}

	/**
	 * A project that declared no locales, or whose pages carry none the crawl
	 * could read, still deserves a measurement. Falling back to the site's
	 * most-linked pages keeps the sample on the same evidence rather than
	 * returning nothing and calling it a policy.
	 */
	if (chosen.length < limit) {
		const rest = [...candidates].sort(
			(a, b) => b.inboundLinks - a.inboundLinks || a.url.localeCompare(b.url),
		);
		for (const page of rest) {
			if (chosen.length >= limit) break;
			take(page.url);
		}
	}

	return { urls: chosen, cap: limit, locales };
}

/**
 * How many crawled pages link to each page, from the links the crawl recorded.
 *
 * Inbound rather than outbound, because the question is which pages the site
 * points *at*. A page's own link count says how big its navigation is; the
 * number of pages pointing at it is the site saying it matters.
 *
 * Self-links are not counted: a page linking to itself — a canonical nav item
 * highlighting the current page — is not the site recommending it.
 */
export function countInboundLinks(
	pages: Array<{ url: string; links: string[] }>,
): Map<string, number> {
	const known = new Set(pages.map((p) => p.url));
	const counts = new Map<string, number>();

	for (const page of pages) {
		for (const link of new Set(page.links)) {
			if (link === page.url) continue;
			if (!known.has(link)) continue;
			counts.set(link, (counts.get(link) ?? 0) + 1);
		}
	}

	return counts;
}
