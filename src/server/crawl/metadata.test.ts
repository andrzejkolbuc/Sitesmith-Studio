import { describe, expect, it } from "vitest";

import {
	extractMetadata,
	MAX_METADATA_CHARS,
	parseRobotsDirectives,
} from "./metadata";

/**
 * The metadata extractor, tested as a pure function.
 *
 * Same reasoning as `content.test.ts`: what we measure is the part of this
 * slice most expensive to get wrong. Every metadata finding is only as
 * trustworthy as the facts underneath it, and a mistake here surfaces as a
 * confidently wrong claim about a client's site — "this page has no title",
 * "this canonical points somewhere else" — rather than as a crash.
 *
 * Expectations come from what the three requirements need to ask, never from
 * running the extractor and recording its output.
 */

const PAGE_URL = "https://shop.test/pricing";

const page = (head: string, body = "") =>
	`<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe("title", () => {
	it("reads the title a page published", () => {
		expect(
			extractMetadata(page("<title>Pricing</title>"), PAGE_URL).title,
		).toBe("Pricing");
	});

	it("collapses the whitespace a template wrapped it in", () => {
		/**
		 * HTML collapses whitespace when rendering, so a title split across three
		 * indented source lines is one line to everyone who sees it. Two pages
		 * whose templates indent differently have not published different titles —
		 * and the duplicate rule compares these strings exactly.
		 */
		expect(
			extractMetadata(
				page("<title>\n      Pricing\n      and plans\n    </title>"),
				PAGE_URL,
			).title,
		).toBe("Pricing and plans");
	});

	it("decodes the entities a title was written with", () => {
		expect(
			extractMetadata(
				page("<title>Bits &amp; Pieces &#8212; Yazaki</title>"),
				PAGE_URL,
			).title,
		).toBe("Bits & Pieces — Yazaki");
	});

	it("leaves an entity it does not know exactly as written", () => {
		/**
		 * Unlike the digest normaliser next door, this string is read by a human in
		 * a finding. Turning an unrecognised entity into a space would quietly
		 * rewrite the evidence the finding is quoting.
		 */
		expect(
			extractMetadata(page("<title>A &notanentity; B</title>"), PAGE_URL).title,
		).toBe("A &notanentity; B");
	});

	it("reports an absent title as absent", () => {
		expect(extractMetadata(page(""), PAGE_URL).title).toBeNull();
	});

	it("reports an empty title as absent", () => {
		/**
		 * `<title></title>` and no title at all are the same fact to a search
		 * engine, so they must be the same fact to the rule. Two shapes for one
		 * defect would mean the rule needs to know about both.
		 */
		expect(extractMetadata(page("<title></title>"), PAGE_URL).title).toBeNull();
		expect(
			extractMetadata(page("<title>   </title>"), PAGE_URL).title,
		).toBeNull();
	});

	it("does not read a decoration in the body as the page's title", () => {
		/**
		 * An inline `<svg><title>` is an accessible label for an icon, not the
		 * page's title. Reading it would be worse than merely wrong: it would hide
		 * a genuinely missing title behind an icon's name, and the missing-title
		 * rule would report the page as fine.
		 */
		expect(
			extractMetadata(
				page("", "<svg><title>Search icon</title></svg>"),
				PAGE_URL,
			).title,
		).toBeNull();
	});

	it("still finds a title on a page whose head is never closed", () => {
		expect(
			extractMetadata(
				"<html><head><title>Pricing</title><body><p>hello</p></body></html>",
				PAGE_URL,
			).title,
		).toBe("Pricing");
	});
});

describe("description", () => {
	it("reads the description a page published", () => {
		expect(
			extractMetadata(
				page('<meta name="description" content="What this page is for.">'),
				PAGE_URL,
			).description,
		).toBe("What this page is for.");
	});

	it("does not depend on the order the attributes were written in", () => {
		expect(
			extractMetadata(
				page(
					'<meta content="Attributes the other way round." name="description">',
				),
				PAGE_URL,
			).description,
		).toBe("Attributes the other way round.");
	});

	it("reports an empty description as absent", () => {
		expect(
			extractMetadata(page('<meta name="description" content="">'), PAGE_URL)
				.description,
		).toBeNull();
	});

	it("reports an absent description as absent", () => {
		expect(
			extractMetadata(page("<title>Pricing</title>"), PAGE_URL).description,
		).toBeNull();
	});

	it("takes the first of two descriptions rather than choosing between them", () => {
		/**
		 * A page repeating the tag has published one description and a mistake.
		 * The first is what its template meant; picking the longest or the last
		 * would be us choosing on the site's behalf.
		 */
		expect(
			extractMetadata(
				page(
					'<meta name="description" content="First."><meta name="description" content="Second.">',
				),
				PAGE_URL,
			).description,
		).toBe("First.");
	});

	it("does not read an attribute merely ending in name", () => {
		expect(
			extractMetadata(
				page('<meta data-name="description" content="Not a description.">'),
				PAGE_URL,
			).description,
		).toBeNull();
	});
});

describe("length capping", () => {
	it("caps a hostile title and description at capture", () => {
		/**
		 * A bound on memory, not a judgement about length — this slice ships no
		 * length checks. A `CrawledPage` is held for every page against a
		 * two-thousand-page ceiling, so one site serving megabyte titles is the
		 * whole budget.
		 */
		const enormous = "a".repeat(MAX_METADATA_CHARS * 3);
		const metadata = extractMetadata(
			page(
				`<title>${enormous}</title><meta name="description" content="${enormous}">`,
			),
			PAGE_URL,
		);

		expect(metadata.title).toHaveLength(MAX_METADATA_CHARS);
		expect(metadata.description).toHaveLength(MAX_METADATA_CHARS);
	});
});

describe("canonical", () => {
	it("resolves a relative canonical against the page's own URL", () => {
		/**
		 * The href is relative and the page lives two segments deep, so a canonical
		 * resolved against anything else — the origin, the requested URL before a
		 * redirect — lands on a URL the site never named.
		 */
		expect(
			extractMetadata(
				page('<link rel="canonical" href="plans">'),
				"https://shop.test/pricing/monthly",
			).canonicals,
		).toEqual(["https://shop.test/pricing/plans"]);
	});

	it("normalises the canonical the same way the crawl normalised the page", () => {
		/**
		 * `normaliseUrl` strips the query string and a trailing slash, and the
		 * crawler has already applied it to the URL it recorded. A canonical
		 * differing only in those respects is not a defect — comparing raw strings
		 * would report our own normalisation as the client's.
		 */
		expect(
			extractMetadata(
				page(
					'<link rel="canonical" href="https://shop.test/pricing/?ref=nav">',
				),
				PAGE_URL,
			).canonicals,
		).toEqual([PAGE_URL]);
	});

	it("keeps two canonicals that name different URLs", () => {
		/**
		 * The evidence for "this page disagrees with itself". A field holding one
		 * URL would silently discard exactly the fact FR-022 asks about.
		 */
		expect(
			extractMetadata(
				page(
					'<link rel="canonical" href="/pricing"><link rel="canonical" href="/plans">',
				),
				PAGE_URL,
			).canonicals,
		).toEqual(["https://shop.test/pricing", "https://shop.test/plans"]);
	});

	it("collapses two spellings of one canonical into one", () => {
		// Repeating the same URL is not a disagreement, and reporting it as one
		// would be a finding about punctuation.
		expect(
			extractMetadata(
				page(
					'<link rel="canonical" href="/pricing"><link rel="canonical" href="/pricing/">',
				),
				PAGE_URL,
			).canonicals,
		).toEqual(["https://shop.test/pricing"]);
	});

	it("ignores link tags that are not canonical", () => {
		expect(
			extractMetadata(
				page(
					'<link rel="alternate" hreflang="de" href="/de/preise"><link rel="stylesheet" href="/app.css">',
				),
				PAGE_URL,
			).canonicals,
		).toEqual([]);
	});

	it("ignores a canonical outside the head", () => {
		// Search engines ignore it there, so recording it would be recording a
		// declaration the site never effectively made.
		expect(
			extractMetadata(
				page("", '<link rel="canonical" href="/elsewhere">'),
				PAGE_URL,
			).canonicals,
		).toEqual([]);
	});

	it("drops a canonical that is not a usable http URL", () => {
		expect(
			extractMetadata(
				page('<link rel="canonical" href="javascript:void(0)">'),
				PAGE_URL,
			).canonicals,
		).toEqual([]);
	});
});

describe("robots directives", () => {
	it("parses the generic directive into tokens", () => {
		expect(
			extractMetadata(
				page('<meta name="robots" content="NoIndex,  Nofollow">'),
				PAGE_URL,
			).robots,
		).toEqual([{ crawler: null, directives: ["noindex", "nofollow"] }]);
	});

	it("keeps none as the word the page published", () => {
		/**
		 * `none` is defined as equivalent to `noindex, nofollow`, but applying that
		 * equivalence is a rule's job. A finding quoting `noindex` on a page whose
		 * source says `none` sends its reader looking for a word that is not there.
		 */
		expect(
			extractMetadata(page('<meta name="robots" content="none">'), PAGE_URL)
				.robots,
		).toEqual([{ crawler: null, directives: ["none"] }]);
	});

	it("records which crawler a scoped directive was addressed to", () => {
		expect(
			extractMetadata(
				page('<meta name="googlebot" content="noindex">'),
				PAGE_URL,
			).robots,
		).toEqual([{ crawler: "googlebot", directives: ["noindex"] }]);
	});

	it("keeps a generic and a scoped directive apart", () => {
		expect(
			extractMetadata(
				page(
					'<meta name="robots" content="index, follow"><meta name="googlebot" content="noindex">',
				),
				PAGE_URL,
			).robots,
		).toEqual([
			{ crawler: null, directives: ["index", "follow"] },
			{ crawler: "googlebot", directives: ["noindex"] },
		]);
	});

	it("does not read an ordinary meta tag as a robots directive", () => {
		/**
		 * The name list is closed on purpose. Missing an exotic crawler's directive
		 * is a false negative; guessing would let `viewport` and `generator` into a
		 * rule about whether an entire site is indexed.
		 */
		expect(
			extractMetadata(
				page(
					'<meta name="viewport" content="width=device-width"><meta name="generator" content="noindex">',
				),
				PAGE_URL,
			).robots,
		).toEqual([]);
	});

	it("records nothing for an empty directive list", () => {
		expect(
			extractMetadata(page('<meta name="robots" content="">'), PAGE_URL).robots,
		).toEqual([]);
	});

	it("parses a header's vocabulary with the same parser", () => {
		/**
		 * `X-Robots-Tag` carries the same comma-separated tokens as the meta tag's
		 * content. Two parsers would eventually disagree about the channel the
		 * whole rule exists to read.
		 */
		expect(parseRobotsDirectives("noindex, NOFOLLOW, noindex")).toEqual([
			"noindex",
			"nofollow",
		]);
	});
});

describe("pages with nothing to read", () => {
	it("reports nothing for an empty response", () => {
		expect(extractMetadata("", PAGE_URL)).toEqual({
			title: null,
			description: null,
			canonicals: [],
			robots: [],
		});
	});

	it("reports nothing for a page that declares nothing", () => {
		expect(extractMetadata(page(""), PAGE_URL)).toEqual({
			title: null,
			description: null,
			canonicals: [],
			robots: [],
		});
	});
});
