import { createHash } from "node:crypto";

/**
 * What a page's content is, reduced to the smallest set of facts worth keeping.
 *
 * The crawl already fetches and parses every page's HTML and then throws it
 * away. Reading it costs no additional request, which is the only reason
 * content checks are affordable at all under NFR-1.
 *
 * What it does cost is memory: a `CrawledPage` is held for the whole crawl and
 * multiplied by a two-thousand-page ceiling. So nothing here grows with the size
 * of the document. The text that produced the digest is never returned, and the
 * marker list is a set of kinds — at most four entries — rather than the strings
 * that matched.
 *
 * Deliberately not a parser. A real DOM would be more accurate and would also be
 * a dependency, a startup cost, and a second definition of "what this page says"
 * living next to the regex-based extractors already in `crawler.ts`. The
 * questions asked here are coarse enough — is there a form, is this text
 * identical to its sibling's — that markup-shaped answers are sufficient.
 */

export type ContentBlocks = {
	heading: boolean;
	form: boolean;
	table: boolean;
	media: boolean;
	list: boolean;
};

export type ContentSummary = {
	/**
	 * Whether the response was HTML at all.
	 *
	 * A PDF or a feed produces no text, no blocks and no markers — which is
	 * indistinguishable from an empty HTML page unless something records the
	 * difference. Without this a non-HTML URL inside a variant family would read
	 * as the most extreme drift on the site.
	 */
	isHtml: boolean;
	/**
	 * Whether a main-content region was actually found, or we fell back to the
	 * whole body.
	 *
	 * Recorded rather than silently assumed, because a rule that compares block
	 * presence across a fallback summary is comparing navigation: a search box in
	 * a header would make every page on the site appear to carry a form. A rule
	 * can decline when this is false, which is the honest response to evidence
	 * that is ours rather than the site's.
	 */
	isolated: boolean;
	/**
	 * Digest of the normalised main-content text; null when there is too little
	 * text for a match to mean anything.
	 *
	 * A digest rather than the text itself. Equality of digests is equality of
	 * normalised text and nothing weaker, which is exactly the comparison the
	 * untranslated-content rule makes — and it keeps this type fixed-size.
	 */
	textDigest: string | null;
	/** Length of that normalised text. Feeds the too-little-to-compare guard. */
	textLength: number;
	/** Kinds of placeholder marker found, deduplicated and sorted. */
	markers: MarkerKind[];
	/** Which block types the main content contains. Presence only, never counts. */
	blocks: ContentBlocks;
};

/**
 * The kinds of "this was never finished" evidence worth reporting.
 *
 * Every entry is a false-positive decision about somebody's language, so the set
 * is deliberately short and each addition needs a real observation behind it.
 *
 * `TODO` is the one that is conspicuously absent, and its absence is the point:
 * `todo` is an ordinary Spanish word meaning "all". Including it would report a
 * finding on close to every page of a Spanish-language client site — a claim
 * about our word list rather than about their content.
 */
export type MarkerKind = "lorem_ipsum" | "unrendered_expression";

/**
 * How much text a page needs before its digest is worth comparing.
 *
 * Two nearly-empty variant pages — a heading and a nav, say — match each other
 * by accident rather than because anything went untranslated. A finding resting
 * on that is a claim about the threshold, not about the site.
 *
 * This is a floor on evidence, not a tuning knob: raising or lowering it changes
 * which pages are judged at all, never how similar two pages must be to be
 * called identical. That comparison stays exact.
 */
export const MIN_COMPARABLE_CHARS = 200;

/**
 * Where a page says its own content lives, in order of preference.
 *
 * `<main>` first and separately, rather than as one alternation with
 * `<article>`. Written as `<(main|article)…>` the winner is whichever appears
 * first in the document, so a sidebar `<article>` placed above the content
 * became the content — the digest then described the sidebar, and every claim
 * built on it described the wrong region.
 */
const MAIN_REGION = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i;
const ARTICLE_REGION = /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i;
/** Counting opening tags, to tell a single article from a listing of them. */
const ARTICLE_OPENING = /<article\b[^>]*>/gi;
const BODY_REGION = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i;

/** Content that is markup or code rather than prose the reader sees. */
const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/**
 * Code samples, excluded before markers are looked for.
 *
 * A page documenting a template language legitimately displays `${value}` and
 * `{{ name }}` as its subject matter. Reporting that as an unrendered expression
 * would fire hardest on exactly the technical sites most able to notice we were
 * wrong.
 */
const CODE_SAMPLE = /<(code|pre)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const TAG = /<[^>]*>/g;

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&apos;": "'",
	"&nbsp;": " ",
};

/**
 * Visible text, in a form two pages can be compared in.
 *
 * Lowercased and whitespace-collapsed so that a difference in indentation, line
 * wrapping or casing between two templates does not read as a difference in
 * content. Those are the ways one CMS renders the same words twice.
 */
function visibleText(markup: string): string {
	return markup
		.replace(SCRIPT_OR_STYLE, " ")
		.replace(TAG, " ")
		.replace(
			/&[a-z]+;|&#\d+;/gi,
			(entity) => ENTITIES[entity.toLowerCase()] ?? " ",
		)
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

const BLOCK_PATTERNS: Array<[keyof ContentBlocks, RegExp]> = [
	["heading", /<h[1-6]\b/i],
	["form", /<form\b/i],
	["table", /<table\b/i],
	["media", /<(img|video|audio|picture|iframe|figure)\b/i],
	["list", /<(ul|ol|dl)\b/i],
];

/**
 * The block types, in a fixed order.
 *
 * Derived from the patterns rather than written out again, so a block added
 * above is automatically one the comparison rule considers. Two lists that had
 * to be kept in step by hand would eventually stop being.
 */
export const BLOCK_NAMES: Array<keyof ContentBlocks> = BLOCK_PATTERNS.map(
	([name]) => name,
);

const MARKER_PATTERNS: Array<[MarkerKind, RegExp]> = [
	["lorem_ipsum", /lorem ipsum/i],
	/**
	 * A template delimiter that reached the reader. Bounded lengths so a stray
	 * brace cannot match across half the document and call it a placeholder.
	 */
	[
		"unrendered_expression",
		/\{\{[^{}]{1,120}\}\}|\$\{[^{}]{1,120}\}|\[\[[^[\]]{1,120}\]\]/,
	],
];

/**
 * The summary of a page that has no content to summarise.
 *
 * Used by the crawl's error path — a request that never produced a response has
 * nothing to read — and by tests building pages that are about something else.
 */
export function emptyContent(isHtml: boolean): ContentSummary {
	return {
		isHtml,
		isolated: false,
		textDigest: null,
		textLength: 0,
		markers: [],
		blocks: {
			heading: false,
			form: false,
			table: false,
			media: false,
			list: false,
		},
	};
}

/**
 * Reduces a page's HTML to its content summary.
 *
 * Pure, and takes no URL — unlike the two extractors beside it in the crawl,
 * nothing here depends on where the page lives. That makes it testable with a
 * string and no server, which matters because what we measure is the part of
 * this slice most expensive to get wrong.
 */
export function extractContent(html: string, isHtml: boolean): ContentSummary {
	if (!isHtml || html.trim() === "") return emptyContent(isHtml);

	/**
	 * Prefer a region the page itself marked as its content. Falling back to the
	 * whole body is honest but weaker evidence, and `isolated` is what lets a rule
	 * tell the two apart rather than quietly treating them alike.
	 */
	const main = MAIN_REGION.exec(html)?.[1];

	/**
	 * A lone `<article>` is a page's content. Several of them is a listing, and
	 * the region match would return only the first — so a two-article listing
	 * digests identically to its first article alone, and a family of listings
	 * whose leading item happens to be shared would be reported as untranslated
	 * content on the strength of one entry.
	 *
	 * Declining is the honest answer, and the same one `isolated` exists to give.
	 */
	const article =
		main === undefined && (html.match(ARTICLE_OPENING) ?? []).length === 1
			? ARTICLE_REGION.exec(html)?.[1]
			: undefined;

	const found = main ?? article;
	const isolated = found !== undefined;
	const region = found ?? BODY_REGION.exec(html)?.[1] ?? html;

	const blocks = {} as ContentBlocks;
	for (const [name, pattern] of BLOCK_PATTERNS) {
		blocks[name] = pattern.test(region);
	}

	/**
	 * Markers are looked for across the whole page rather than the main region.
	 * An unrendered expression in a footer is still a template that did not
	 * finish, and it is still visible to everyone who loads the page.
	 */
	const scannable = visibleText(html.replace(CODE_SAMPLE, " "));
	const markers = MARKER_PATTERNS.filter(([, pattern]) =>
		pattern.test(scannable),
	).map(([kind]) => kind);

	const text = visibleText(region);
	const textLength = text.length;

	return {
		isHtml: true,
		isolated,
		textDigest:
			textLength >= MIN_COMPARABLE_CHARS
				? createHash("sha256").update(text).digest("hex")
				: null,
		textLength,
		markers,
		blocks,
	};
}
