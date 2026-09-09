import { describe, expect, it } from "vitest";

import { FINDING_TYPES } from "~/server/crawl/findings";
import { CLIENT_LABEL, clientSentence } from "./client-vocabulary";
import { clientCoverageSentences, runCoverage } from "./coverage";
import { FINDING_LABEL } from "./finding-labels";

const TYPES = Object.values(FINDING_TYPES);

/**
 * Enough payload for every branch to take its detailed path.
 *
 * Deliberately one object rather than a fixture per type: a sentence that reads
 * a field it was not given must still be a sentence, and sharing the payload is
 * how that stays true as branches are added.
 */
const DETAIL: Record<string, unknown> = {
	presentLocales: ["en", "de"],
	missingLocale: "fr",
	locale: "de",
	fields: ["title", "description"],
	urls: ["/a", "/b", "/c"],
	linkedFrom: ["/x", "/y"],
	entries: [{ normalised: "/a" }, { normalised: "/b" }],
	hops: [{ url: "/a" }, { url: "/b" }, { url: "/c" }],
	count: 4,
	of: 9,
	daysRemaining: 12,
	changedPixels: 1_200,
	comparedPixels: 10_000,
	kind: "chain",
};

const sentenceFor = (type: string) => clientSentence({ type, detail: DETAIL });

describe("CLIENT_LABEL", () => {
	/**
	 * The guard that makes two vocabularies safe to keep apart.
	 *
	 * A shared renderer was considered and declined, to leave the operator view
	 * untouched. The cost of that choice is drift, and this is what stops it: a
	 * detection rule shipped without a client wording fails the build here rather
	 * than reaching a client contact as a raw type string.
	 */
	it("names every finding type the product can produce", () => {
		const missing = TYPES.filter((type) => !CLIENT_LABEL[type]);

		expect(missing).toEqual([]);
	});

	it("names nothing the product cannot produce", () => {
		const orphaned = Object.keys(CLIENT_LABEL).filter(
			(type) => !TYPES.includes(type as (typeof TYPES)[number]),
		);

		expect(orphaned).toEqual([]);
	});

	/**
	 * Types whose operator label was already right for a client contact.
	 *
	 * Named rather than inferred. Some of the existing labels are plain English
	 * about a consequence — "Images heavy enough to slow the page" needs no second
	 * version, and writing one only to make it differ would make it worse. Listing
	 * them keeps the overlap a decision somebody made instead of a copy nobody
	 * noticed, which is the only difference between the two that matters.
	 */
	const SHARED_WORDING = new Set([
		"content_untranslated",
		"link_external_broken",
		"image_oversized",
	]);

	it("re-thinks every label the operator's wording does not already serve", () => {
		const copied = TYPES.filter(
			(type) =>
				CLIENT_LABEL[type] === FINDING_LABEL[type] && !SHARED_WORDING.has(type),
		);

		expect(copied).toEqual([]);
	});

	it("keeps the shared list honest about what it claims", () => {
		/*
		 * A type listed as deliberately shared, whose wordings have since diverged,
		 * is a stale exemption rather than a decision.
		 */
		const diverged = [...SHARED_WORDING].filter(
			(type) => CLIENT_LABEL[type] !== FINDING_LABEL[type],
		);

		expect(diverged).toEqual([]);
	});
});

describe("clientSentence", () => {
	it("produces a sentence for every finding type", () => {
		for (const type of TYPES) {
			const sentence = sentenceFor(type);

			expect(sentence.length).toBeGreaterThan(0);
			expect(sentence.trim()).toBe(sentence);
			expect(sentence.endsWith(".")).toBe(true);
		}
	});

	/**
	 * The operator view can afford a default case that prints the payload — its
	 * reader can decode it, and the raw shape is how an unhandled type gets
	 * noticed. A client contact can do neither.
	 */
	it("never prints raw payload data for a type it has no words for", () => {
		const sentence = clientSentence({
			type: "some_rule_shipped_tomorrow",
			detail: { httpStatus: 404, target: "https://example.test/x" },
		});

		expect(sentence).not.toContain("404");
		expect(sentence).not.toContain("example.test");
		expect(sentence).not.toContain("{");
		expect(sentence).toContain("developer");
	});

	it("still reads as a sentence when the payload is empty", () => {
		for (const type of TYPES) {
			const sentence = clientSentence({ type, detail: {} });

			expect(sentence.length).toBeGreaterThan(0);
			expect(sentence).not.toContain("undefined");
			expect(sentence).not.toContain("null");
			expect(sentence).not.toContain("NaN");
		}
	});
});

/**
 * The register guard.
 *
 * Each pattern is something the operator vocabulary says today and a client
 * contact cannot act on. Matching one here means the second vocabulary has
 * drifted back into the first.
 */
const BANNED: Array<[string, RegExp]> = [
	/*
	 * A status code reported *to the reader*, not any three-digit number. The
	 * coverage statement legitimately says "11 of 533 pages", and a pattern that
	 * cannot tell a page count from a response code would either fail on honest
	 * sentences or be switched off — and a guard nobody can keep green stops being
	 * a guard.
	 */
	[
		"an HTTP status code",
		/\b(?:status|code)\b[^.]{0,20}\b\d{3}\b|\breturns?\s+\d{3}\b|\bHTTP\s*\d{3}\b/i,
	],
	["hreflang", /hreflang/i],
	["canonical", /canonical/i],
	["robots.txt", /robots\.txt/i],
	["a response header name", /x-robots-tag|strict-transport-security|hsts/i],
	["a Core Web Vitals acronym", /\b(ttfb|lcp|cls)\b/i],
	["pixels", /\bpixels?\b/i],
	["a locale-jargon word", /\blocales?\b/i],
	["a crawl-internals word", /\bcrawl(ed|er|ing)?\b|\bviewport\b|\bDOM\b/i],
];

describe("register", () => {
	it("keeps every client label clear of operator jargon", () => {
		for (const type of TYPES) {
			const label = CLIENT_LABEL[type] as string;

			for (const [name, pattern] of BANNED) {
				expect(
					pattern.test(label),
					`${type} label uses ${name}: "${label}"`,
				).toBe(false);
			}
		}
	});

	it("keeps every client sentence clear of operator jargon", () => {
		for (const type of TYPES) {
			const sentence = sentenceFor(type);

			for (const [name, pattern] of BANNED) {
				expect(
					pattern.test(sentence),
					`${type} sentence uses ${name}: "${sentence}"`,
				).toBe(false);
			}
		}
	});

	it("keeps the client coverage statement clear of operator jargon", () => {
		/*
		 * The coverage statement leads the report, so it is the first place a
		 * reader meets the register — and it is derived from the same columns the
		 * operator sentences use, which is exactly how jargon travels.
		 */
		const coverage = runCoverage({
			status: "done",
			pagesCrawled: 533,
			crawlComplete: false,
			reachedPageLimit: true,
			scope: { includePaths: ["/docs"], excludePaths: [], locales: ["en"] },
			ruleSet: null,
			renderSummary: { chosen: 12, measured: 11, cap: 12, complete: true },
			visualSummary: {
				baselineRunId: "r0",
				watched: 10,
				captured: 10,
				compared: 9,
				differing: 2,
				complete: true,
			},
		});

		const sentences = clientCoverageSentences(coverage);
		expect(sentences.length).toBeGreaterThan(0);

		for (const sentence of sentences) {
			for (const [name, pattern] of BANNED) {
				expect(pattern.test(sentence), `coverage uses ${name}`).toBe(false);
			}
		}
	});
});

describe("clientCoverageSentences", () => {
	/**
	 * Unlike the operator block, this one always says something. A report read on
	 * paper has lost the co-location that lets a section's coverage line stand in
	 * for a statement about the whole check, and a reader who skims may never
	 * reach it at all.
	 */
	it("states coverage even for a run that covered everything", () => {
		const sentences = clientCoverageSentences(
			runCoverage({
				status: "done",
				pagesCrawled: 120,
				crawlComplete: true,
				reachedPageLimit: false,
				scope: { includePaths: [], excludePaths: [], locales: ["en"] },
				ruleSet: ["link_broken"],
				renderSummary: { chosen: 12, measured: 12, cap: 12, complete: true },
				visualSummary: {
					baselineRunId: "r0",
					watched: 10,
					captured: 10,
					compared: 10,
					differing: 0,
					complete: true,
				},
			}),
		);

		expect(sentences[0]).toContain("every page it could reach");
		expect(sentences.join(" ")).toContain("a sample, not the whole site");
	});

	it("warns that a partial pass may show fewer problems, not fewer faults", () => {
		const sentences = clientCoverageSentences(
			runCoverage({
				status: "done",
				pagesCrawled: 2000,
				crawlComplete: false,
				reachedPageLimit: true,
				scope: null,
				ruleSet: ["link_broken"],
				renderSummary: null,
				visualSummary: null,
			}),
		);

		expect(sentences[0]).toContain("larger than what is described here");
		expect(sentences[0]).toContain("fewer problems");
	});
});
