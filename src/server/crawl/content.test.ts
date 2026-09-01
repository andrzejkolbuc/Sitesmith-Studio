import { describe, expect, it } from "vitest";

import { extractContent, MIN_COMPARABLE_CHARS } from "./content";

/**
 * The content extractor, tested as a pure function.
 *
 * What we measure is the part of this slice most expensive to get wrong: every
 * content finding is only as trustworthy as the summary underneath it, and a
 * mistake here surfaces as a confidently wrong claim about a client's site
 * rather than as a crash. Testing it with a string and no server is what makes
 * that affordable to check exhaustively.
 *
 * Expectations come from what the rules need to ask, never from running the
 * extractor and recording its output.
 */

/** Long enough to clear the comparable-length floor. */
const prose = (word: string) => `${word} `.repeat(60);

const page = (body: string, head = "") =>
	`<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe("what the response was", () => {
	it("reports nothing at all for a non-HTML response", () => {
		/**
		 * A PDF or a feed produces no text, no blocks and no markers — which is
		 * indistinguishable from an empty HTML page unless `isHtml` records the
		 * difference. Without it, a non-HTML URL inside a variant family would look
		 * like the most extreme drift on the site.
		 */
		const summary = extractContent("", false);

		expect(summary.isHtml).toBe(false);
		expect(summary.textDigest).toBeNull();
		expect(summary.blocks.heading).toBe(false);
	});

	it("treats an empty HTML response as having no content", () => {
		expect(extractContent("", true)).toMatchObject({
			isHtml: true,
			textLength: 0,
			textDigest: null,
		});
	});
});

describe("isolating the main content", () => {
	it("prefers a <main> region and digests only what is inside it", () => {
		/**
		 * Stated as an equality rather than a size comparison, because the property
		 * that matters is total exclusion: a page wrapped in navigation must digest
		 * to exactly what the same content digests to on its own. Anything weaker
		 * would still pass while leaking some of the chrome into the comparison.
		 */
		const withNav = extractContent(
			page(
				`<nav>home about pricing</nav><main><p>${prose("content")}</p></main>`,
			),
			true,
		);
		const alone = extractContent(
			page(`<main><p>${prose("content")}</p></main>`),
			true,
		);

		expect(withNav.isolated).toBe(true);
		expect(withNav.textDigest).toBe(alone.textDigest);
	});

	it("accepts <article> as a content region too", () => {
		expect(
			extractContent(page(`<article><p>${prose("x")}</p></article>`), true)
				.isolated,
		).toBe(true);
	});

	it("falls back to the whole body and says so", () => {
		/**
		 * The fallback must be *recorded*, not silently treated as equivalent. A
		 * summary that swept in navigation is weaker evidence, and only a rule that
		 * can see the difference is able to decline rather than report on it.
		 */
		const summary = extractContent(page(`<p>${prose("x")}</p>`), true);

		expect(summary.isolated).toBe(false);
		expect(summary.textLength).toBeGreaterThan(0);
	});

	it("keeps navigation out of the summary when a region was found", () => {
		/**
		 * The reason isolation exists. A search box in the header would otherwise
		 * make every page on the site appear to contain a form, and a rule
		 * comparing block presence across variants would report nothing — or,
		 * worse, everything.
		 */
		const summary = extractContent(
			page(
				`<header><form><input></form></header><main><p>${prose("x")}</p></main>`,
			),
			true,
		);

		expect(summary.blocks.form).toBe(false);
	});
});

describe("comparing one page's text with another's", () => {
	it("gives identical digests to text that differs only in markup whitespace", () => {
		/**
		 * A page duplicated from another language is rarely duplicated byte for
		 * byte — the same CMS re-renders it with different indentation and line
		 * wrapping. If those counted as differences the rule would miss the exact
		 * case it exists to catch.
		 */
		const words = "shared ".repeat(60).trim();
		/**
		 * The difference has to sit *between* the words, not around them. Leading
		 * and trailing whitespace is removed by trimming alone, so a test that only
		 * indented the markup would pass whether or not the collapsing step exists —
		 * which is exactly what an earlier version of this test did.
		 */
		const rewrapped = words.replace(/ /g, "\n     ");

		const a = extractContent(page(`<main><p>${words}</p></main>`), true);
		const b = extractContent(
			page(`<main>\n\n   <p>\n  ${rewrapped.toUpperCase()}\n</p>\n</main>`),
			true,
		);

		expect(a.textDigest).not.toBeNull();
		expect(b.textDigest).toBe(a.textDigest);
	});

	it("gives different digests to genuinely different text", () => {
		const a = extractContent(
			page(`<main><p>${prose("english")}</p></main>`),
			true,
		);
		const b = extractContent(
			page(`<main><p>${prose("deutsch")}</p></main>`),
			true,
		);

		expect(b.textDigest).not.toBe(a.textDigest);
	});

	it("refuses to digest a page with too little text to judge", () => {
		/**
		 * Two nearly-empty variant pages match each other by accident rather than
		 * because anything went untranslated. A finding resting on that would be a
		 * claim about our floor, not about the site.
		 */
		const summary = extractContent(page("<main><p>Hallo</p></main>"), true);

		expect(summary.textLength).toBeLessThan(MIN_COMPARABLE_CHARS);
		expect(summary.textDigest).toBeNull();
	});

	it("ignores script and style content", () => {
		/**
		 * Analytics snippets and inline styles differ between deployments of the
		 * same page. Counting them as content would make two identical pages look
		 * different for reasons no reader can see.
		 */
		const plain = extractContent(
			page(`<main><p>${prose("x")}</p></main>`),
			true,
		);
		const noisy = extractContent(
			page(
				`<main><script>var t=Date.now()</script><style>.a{color:red}</style><p>${prose("x")}</p></main>`,
			),
			true,
		);

		expect(noisy.textDigest).toBe(plain.textDigest);
	});
});

describe("finding markers of an unfinished page", () => {
	it("finds lorem ipsum", () => {
		expect(
			extractContent(page("<p>Lorem ipsum dolor sit amet</p>"), true).markers,
		).toContain("lorem_ipsum");
	});

	it.each([
		["handlebars", "<h1>{{ headline }}</h1>"],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: an unrendered placeholder in a plain string is precisely what this asserts
		["template literal", "<h1>${headline}</h1>"],
		["double bracket", "<h1>[[headline]]</h1>"],
	])("finds an unrendered %s expression", (_kind, body) => {
		expect(extractContent(page(body), true).markers).toContain(
			"unrendered_expression",
		);
	});

	it("finds markers outside the main region too", () => {
		/**
		 * Unlike a block comparison, an unrendered expression is a defect wherever
		 * it appears — a footer that never finished rendering is visible to
		 * everyone who loads the page.
		 */
		expect(
			extractContent(
				page(`<main><p>${prose("fine")}</p></main><footer>{{ year }}</footer>`),
				true,
			).markers,
		).toContain("unrendered_expression");
	});

	it("does NOT treat TODO as a marker", () => {
		/**
		 * The single most important assertion in this file.
		 *
		 * `todo` is an ordinary Spanish word meaning "all". A marker set containing
		 * it would report a finding on close to every page of a Spanish-language
		 * client site — a claim about our word list rather than about their
		 * content, which is precisely what `context/foundation/lessons.md` forbids.
		 */
		expect(
			extractContent(
				page("<p>Todo el contenido está disponible. TODO</p>"),
				true,
			).markers,
		).toEqual([]);
	});

	it("does not read a code sample as an unrendered expression", () => {
		/**
		 * A page documenting a template language displays `${value}` as its subject
		 * matter. Reporting that would fire hardest on exactly the technical sites
		 * most able to notice we were wrong.
		 */
		expect(
			extractContent(
				// biome-ignore lint/suspicious/noTemplateCurlyInString: a code sample containing a placeholder is the case under test
				page("<pre><code>const s = `${name}`</code></pre>"),
				true,
			).markers,
		).toEqual([]);
	});

	it("reports a clean page as having no markers", () => {
		expect(
			extractContent(page(`<p>${prose("clean")}</p>`), true).markers,
		).toEqual([]);
	});
});

describe("which block types the content contains", () => {
	it.each([
		["heading", "<h2>Title</h2>"],
		["form", "<form><input></form>"],
		["table", "<table><tr><td>1</td></tr></table>"],
		["media", '<img src="a.png">'],
		["list", "<ul><li>one</li></ul>"],
	] as const)("detects a %s", (block, markup) => {
		expect(
			extractContent(page(`<main>${markup}</main>`), true).blocks[block],
		).toBe(true);
	});

	it("reports presence rather than count", () => {
		/**
		 * Presence is the whole design. Translators legitimately merge and split
		 * headings, so a rule comparing counts would fire on honest work — the
		 * noise failure the PRD named. One heading and five headings must look the
		 * same to this summary.
		 */
		const one = extractContent(page("<main><h2>a</h2></main>"), true);
		const many = extractContent(
			page("<main><h2>a</h2><h2>b</h2><h3>c</h3><h3>d</h3><h4>e</h4></main>"),
			true,
		);

		expect(many.blocks).toEqual(one.blocks);
	});

	it("reports a plain page as containing no blocks", () => {
		expect(
			extractContent(page(`<main><p>${prose("x")}</p></main>`), true).blocks,
		).toEqual({
			heading: false,
			form: false,
			table: false,
			media: false,
			list: false,
		});
	});
});
