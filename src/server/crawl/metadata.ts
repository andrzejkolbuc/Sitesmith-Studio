import { normaliseUrl } from "./url";

/**
 * What a page says about itself to a search engine.
 *
 * The crawl already fetches and parses every page's HTML and then throws it
 * away, so reading four more facts out of it costs no additional request — the
 * same reason the content summary beside this one is affordable at all.
 *
 * What it costs is memory: a `CrawledPage` is held for the whole crawl and
 * multiplied by a two-thousand-page ceiling, so nothing here grows with the
 * size of the document. Title and description are capped at capture, the
 * canonical list is deduplicated, and the robots directives are parsed tokens
 * rather than the strings they came from.
 *
 * Shaped like `extractHreflang` rather than like `extractContent`: a canonical
 * href can be relative, so this extractor needs to know where the page lives.
 *
 * Deliberately not a parser, for the reasons `content.ts` sets out at length —
 * a real DOM would be a dependency, a startup cost, and a second definition of
 * "what this page says" living beside the regex extractors already in
 * `crawler.ts`. The one place that costs us is an unencoded `>` inside an
 * attribute value, which truncates the tag; it is rare, and it is the same
 * limitation the two extractors next door already carry.
 */

/**
 * One robots instruction, and who it was addressed to.
 *
 * `crawler` is null for the generic `<meta name="robots">`, which speaks to
 * everyone. A named crawler is kept rather than flattened away because a
 * `googlebot`-scoped `noindex` and a generic one have different blast radii,
 * and a finding that cannot say which it saw is asking the reader to go and
 * look.
 *
 * Directives are the tokens the page listed, lowercased and deduplicated — not
 * a decision about what they mean. `none` is left as `none` on purpose: it is
 * defined as equivalent to `noindex, nofollow`, but that equivalence is
 * vocabulary a *rule* applies, and the evidence a finding quotes should be the
 * word the site actually published.
 */
export type RobotsDirective = {
	crawler: string | null;
	directives: string[];
};

export type PageMetadata = {
	/** Trimmed, entity-decoded, length-capped. Null when absent or empty. */
	title: string | null;
	/** Same treatment as the title. Null when absent or empty. */
	description: string | null;
	/**
	 * Every canonical the page declared, normalised and deduplicated, in
	 * document order.
	 *
	 * A list rather than a single value because "this page declares two
	 * different canonicals" is itself one of the defects FR-022 asks about, and
	 * a field holding one URL would silently discard the evidence for it.
	 */
	canonicals: string[];
	/** Robots directives found in markup. The header travels separately. */
	robots: RobotsDirective[];
};

/**
 * How much of a title or description is kept.
 *
 * A bound on memory, not a judgement about length — this slice ships no length
 * checks, and nothing here should be read as one. A page can serve a megabyte
 * title, and two thousand of those is the crawl's whole budget spent on one
 * hostile site.
 *
 * Generous enough that truncation cannot change what the duplicate rule
 * concludes: two pages agreeing for a thousand characters and diverging after
 * are the same template defect that rule exists to name.
 */
export const MAX_METADATA_CHARS = 1000;

/**
 * The meta names that carry robots directives.
 *
 * A closed list rather than "any meta tag whose content parses". The generic
 * `robots` is the one that matters; the crawler-specific names are the ones
 * whose operators publish the syntax. A name we do not recognise is simply not
 * read as a directive — missing an exotic crawler's `noindex` is a false
 * negative, while guessing would let ordinary meta tags into a rule about
 * deindexing an entire site.
 */
const ROBOTS_META_NAMES = new Set([
	"robots",
	"googlebot",
	"googlebot-news",
	"bingbot",
]);

const HEAD_REGION = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i;
const BODY_START = /<body\b/i;
const TITLE_TAG = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
const META_TAG = /<meta\b[^>]*>/gi;
const LINK_TAG = /<link\b[^>]*>/gi;

/**
 * Attribute readers.
 *
 * Anchored on the whitespace that separates attributes rather than on a word
 * boundary, so `data-name=` is not read as `name=`. Quoted forms first,
 * unquoted last.
 */
const NAME_ATTR = /\sname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i;
const CONTENT_ATTR = /\scontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i;
const REL_ATTR = /\srel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i;
const HREF_ATTR = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i;

const TAG = /<[^>]*>/g;

const NAMED_ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
	"&nbsp;": " ",
};

const HEX_ENTITY = /^&#x([0-9a-f]+);$/i;
const DECIMAL_ENTITY = /^&#(\d+);$/;

/**
 * Entity decoding, kept separate from the one in `content.ts` on purpose.
 *
 * That one is normalising text for a digest, so an entity it does not know
 * becomes a space — a word separator, which is all a digest needs. This one
 * produces a string a human reads in a finding, so an unknown entity is left
 * exactly as the page wrote it rather than silently becoming whitespace.
 */
function decodeEntities(text: string): string {
	return text.replace(/&#x[0-9a-f]+;|&#\d+;|&[a-z]+;/gi, (entity) => {
		const named = NAMED_ENTITIES[entity.toLowerCase()];
		if (named !== undefined) return named;

		const hex = HEX_ENTITY.exec(entity);
		const decimal = DECIMAL_ENTITY.exec(entity);
		const code = hex?.[1]
			? Number.parseInt(hex[1], 16)
			: decimal?.[1]
				? Number.parseInt(decimal[1], 10)
				: Number.NaN;

		if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return entity;
		return String.fromCodePoint(code);
	});
}

/**
 * A metadata string in the form a reader would recognise.
 *
 * Whitespace is collapsed because HTML collapses it when rendering: a title
 * split across three indented source lines is one line to everyone who sees
 * it, and two pages whose templates indent differently have not published
 * different titles.
 *
 * Empty becomes null, which is what makes `content=""` and an absent tag the
 * same fact to every rule downstream — as they are to a search engine.
 */
function plainText(raw: string): string | null {
	const text = decodeEntities(raw.replace(TAG, " "))
		.replace(/\s+/g, " ")
		.trim();
	if (text === "") return null;
	return text.slice(0, MAX_METADATA_CHARS);
}

function attribute(tag: string, pattern: RegExp): string | null {
	const match = pattern.exec(tag);
	if (!match) return null;
	return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * The tokens of a robots instruction, from either channel.
 *
 * Exported because `X-Robots-Tag` carries the same comma-separated vocabulary
 * as the meta tag's `content`, and two parsers would eventually disagree about
 * the header the whole rule exists to read.
 */
export function parseRobotsDirectives(content: string): string[] {
	const seen = new Set<string>();
	for (const token of content.split(",")) {
		const directive = token.trim().toLowerCase();
		if (directive !== "") seen.add(directive);
	}
	return [...seen];
}

/**
 * Directive names the robots vocabulary defines.
 *
 * Closed around *directives* rather than around crawler names — the opposite
 * way round from `ROBOTS_META_NAMES` above, because the two lists are open at
 * opposite ends. Anyone may name a crawler; only the specification names a
 * directive. Read only by the header parser below, which needs to tell
 * `googlebot: noindex` (a crawler and its instruction) from
 * `unavailable_after: 25 Jun 2010` (one instruction that happens to contain a
 * colon).
 */
const ROBOTS_DIRECTIVE_NAMES = new Set([
	"all",
	"noindex",
	"index",
	"nofollow",
	"follow",
	"none",
	"noarchive",
	"nosnippet",
	"notranslate",
	"noimageindex",
	"nositelinkssearchbox",
	"indexifembedded",
	"max-snippet",
	"max-image-preview",
	"max-video-preview",
	"unavailable_after",
]);

/**
 * `X-Robots-Tag`, which carries the meta tag's vocabulary plus a scope.
 *
 * The header may name the crawler it speaks to — `googlebot: noindex` — and a
 * server joining several rules into one response line produces a value holding
 * more than one scope. A flat comma split reads `googlebot: noindex` as a
 * single unrecognised token and finds no `noindex` in it, which is the one
 * failure this whole requirement exists to prevent: a page reported clean while
 * it is deindexed.
 *
 * A scope applies from where it appears until the next one, which is how the
 * header reads when those rules are joined. Directives before any scope speak
 * to everyone, and arrive with a null crawler — the same shape the generic
 * `<meta name="robots">` produces, so a rule reading both channels compares
 * like with like.
 */
export function parseRobotsHeader(value: string): RobotsDirective[] {
	const scopes: RobotsDirective[] = [];
	let crawler: string | null = null;

	const record = (directive: string): void => {
		if (directive === "") return;
		let scope = scopes.find((entry) => entry.crawler === crawler);
		if (!scope) {
			scope = { crawler, directives: [] };
			scopes.push(scope);
		}
		if (!scope.directives.includes(directive)) scope.directives.push(directive);
	};

	for (const token of value.split(",")) {
		const trimmed = token.trim().toLowerCase();
		if (trimmed === "") continue;

		const colon = trimmed.indexOf(":");
		const prefix = colon > 0 ? trimmed.slice(0, colon).trim() : null;

		/**
		 * A colon after something that is not a directive name is a crawler
		 * saying who the rest is for. Guarding on the directive list rather than
		 * on a list of crawlers keeps an unfamiliar crawler working — its `noindex`
		 * still counts — while `max-snippet: 50` stays one directive.
		 */
		if (prefix !== null && !ROBOTS_DIRECTIVE_NAMES.has(prefix)) {
			crawler = prefix;
			record(trimmed.slice(colon + 1).trim());
			continue;
		}

		record(trimmed);
	}

	return scopes;
}

/** The metadata of a page that published none — and of one that never loaded. */
export function emptyMetadata(): PageMetadata {
	return { title: null, description: null, canonicals: [], robots: [] };
}

/**
 * Where a page's declarations about itself are allowed to live.
 *
 * Restricted to `<head>` deliberately. A canonical outside the head is ignored
 * by search engines, and an `<svg><title>` in the body is not the page's title
 * — reading either would record a fact the site never asserted, and on the
 * title it would do worse than that: it would hide a genuinely missing title
 * behind a decoration's label.
 *
 * Falls back to everything before `<body>` when the head is unterminated, and
 * to the whole document when there is no body either, so a malformed page is
 * still read rather than reported as bare.
 */
function headRegion(html: string): string {
	const head = HEAD_REGION.exec(html)?.[1];
	if (head !== undefined) return head;

	const body = BODY_START.exec(html);
	return body ? html.slice(0, body.index) : html;
}

/**
 * Reduces a page's markup to the SEO facts FR-021, FR-022 and FR-023 ask about.
 *
 * Pure, and testable with a string and no server — which matters because what
 * we measure is the part of this slice most expensive to get wrong. A mistake
 * here surfaces as a confidently wrong claim about a client's site rather than
 * as a crash.
 */
export function extractMetadata(html: string, pageUrl: string): PageMetadata {
	if (html.trim() === "") return emptyMetadata();

	const head = headRegion(html);

	const title = plainText(TITLE_TAG.exec(head)?.[1] ?? "");

	let description: string | null = null;
	let sawDescription = false;
	const robots: RobotsDirective[] = [];

	for (const [tag] of head.matchAll(META_TAG)) {
		const name = attribute(tag, NAME_ATTR)?.trim().toLowerCase();
		if (!name) continue;

		const content = attribute(tag, CONTENT_ATTR);
		if (content === null) continue;

		/**
		 * The first description wins. A page repeating the tag has published one
		 * description and a mistake; the first is what its template meant, and
		 * choosing the longest or the last would be us picking on its behalf.
		 */
		if (name === "description") {
			if (!sawDescription) {
				sawDescription = true;
				description = plainText(content);
			}
			continue;
		}

		if (ROBOTS_META_NAMES.has(name)) {
			const directives = parseRobotsDirectives(content);
			if (directives.length > 0) {
				robots.push({ crawler: name === "robots" ? null : name, directives });
			}
		}
	}

	const canonicals = new Set<string>();
	for (const [tag] of head.matchAll(LINK_TAG)) {
		const rel = attribute(tag, REL_ATTR)?.trim().toLowerCase();
		if (!rel?.split(/\s+/).includes("canonical")) continue;

		const href = attribute(tag, HREF_ATTR);
		if (!href) continue;

		/**
		 * Normalised against the page's own URL, both because a canonical may be
		 * relative and because every later comparison is against a URL the crawl
		 * already normalised. Comparing raw strings would report our own trailing
		 * slash and query-string handling as the client's defect.
		 */
		const resolved = normaliseUrl(href, pageUrl);
		if (resolved) canonicals.add(resolved);
	}

	return { title, description, canonicals: [...canonicals], robots };
}
