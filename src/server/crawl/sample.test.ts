import { describe, expect, it } from "vitest";

import {
	chooseRenderSample,
	countInboundLinks,
	MAX_RENDERS,
	type SamplePage,
} from "./sample";

const BASE = "https://shop.test";

const page = (
	path: string,
	options: Partial<Omit<SamplePage, "url">> = {},
): SamplePage => ({
	url: `${BASE}${path}`,
	locale: options.locale ?? "en",
	httpStatus: options.httpStatus ?? 200,
	fetchError: options.fetchError ?? null,
	isHtml: options.isHtml ?? true,
	inboundLinks: options.inboundLinks ?? 0,
});

const paths = (urls: string[]) => urls.map((u) => new URL(u).pathname);

describe("chooseRenderSample", () => {
	/**
	 * The cap is the whole cost control. A site is free to publish ten languages
	 * and a hundred sections; a run's cost must not be a function of how generous
	 * the site was feeling.
	 */
	it("never exceeds the cap, whatever the locale count", () => {
		const locales = ["en", "de", "fr", "es", "it", "pt", "nl", "pl"];
		const pages = locales.flatMap((locale) =>
			Array.from({ length: 20 }, (_, i) =>
				page(`/${locale}/page-${i}`, { locale, inboundLinks: 20 - i }),
			),
		);

		const sample = chooseRenderSample(pages, locales, null);

		expect(sample.urls).toHaveLength(MAX_RENDERS);
		expect(sample.cap).toBe(MAX_RENDERS);
	});

	/**
	 * Round-robin, not locale by locale. A cap consumed entirely by the first
	 * language leaves the rest unmeasured while presenting a sample that looks
	 * complete — the exact claim this slice exists not to make.
	 */
	it("gives every declared locale a page before any locale gets a second", () => {
		const pages = [
			page("/en/a", { locale: "en", inboundLinks: 90 }),
			page("/en/b", { locale: "en", inboundLinks: 80 }),
			page("/de/a", { locale: "de", inboundLinks: 5 }),
			page("/fr/a", { locale: "fr", inboundLinks: 1 }),
		];

		const sample = chooseRenderSample(pages, ["en", "de", "fr"], null, 3);

		expect(paths(sample.urls).sort()).toEqual(["/de/a", "/en/a", "/fr/a"]);
	});

	/**
	 * Declared locales, not discovered ones. A real client project declares two
	 * while its site publishes ten; sampling the ten multiplies the run by five
	 * for languages the operator never asked us to report on.
	 */
	it("samples only the locales the project declared", () => {
		const pages = [
			page("/en/a", { locale: "en", inboundLinks: 10 }),
			page("/de/a", { locale: "de", inboundLinks: 10 }),
			page("/pt/a", { locale: "pt", inboundLinks: 99 }),
			page("/hr/a", { locale: "hr", inboundLinks: 99 }),
		];

		const sample = chooseRenderSample(pages, ["en", "de"], null, 2);

		expect(paths(sample.urls).sort()).toEqual(["/de/a", "/en/a"]);
		expect(sample.locales).toEqual(["en", "de"]);
	});

	it("ranks by inbound links, the site's own statement of what matters", () => {
		const pages = [
			page("/en/rarely", { inboundLinks: 1 }),
			page("/en/often", { inboundLinks: 40 }),
			page("/en/sometimes", { inboundLinks: 9 }),
		];

		const sample = chooseRenderSample(pages, ["en"], null, 2);

		expect(paths(sample.urls)).toEqual(["/en/often", "/en/sometimes"]);
	});

	/**
	 * A sample that wandered between runs would make every comparison a
	 * comparison of different pages, which is the same defect the run comparison
	 * refuses when the scope changes.
	 */
	it("breaks ties by URL so an unchanged site samples the same pages twice", () => {
		const pages = [
			page("/en/b", { inboundLinks: 5 }),
			page("/en/a", { inboundLinks: 5 }),
			page("/en/c", { inboundLinks: 5 }),
		];

		const first = chooseRenderSample(pages, ["en"], null, 2);
		const second = chooseRenderSample([...pages].reverse(), ["en"], null, 2);

		expect(paths(first.urls)).toEqual(["/en/a", "/en/b"]);
		expect(first.urls).toEqual(second.urls);
	});

	it("always includes the entry page", () => {
		const pages = [
			page("/", { inboundLinks: 0 }),
			page("/en/popular", { inboundLinks: 99 }),
		];

		const sample = chooseRenderSample(pages, ["en"], `${BASE}/`, 1);

		expect(paths(sample.urls)).toEqual(["/"]);
	});

	it("does not count the entry page twice when it also ranks", () => {
		const pages = [
			page("/", { inboundLinks: 99 }),
			page("/en/other", { inboundLinks: 5 }),
		];

		const sample = chooseRenderSample(pages, ["en"], `${BASE}/`, 2);

		expect(paths(sample.urls)).toEqual(["/", "/en/other"]);
	});

	/**
	 * A PDF has nothing to render and a 404 has nothing to measure. Including
	 * either would spend one of twelve slots learning that.
	 */
	it("never chooses a page that failed or was not HTML", () => {
		const pages = [
			page("/en/gone", { httpStatus: 404, inboundLinks: 99 }),
			page("/en/broken", { fetchError: "timeout", inboundLinks: 99 }),
			page("/brochure.pdf", { isHtml: false, inboundLinks: 99 }),
			page("/en/fine", { inboundLinks: 1 }),
		];

		const sample = chooseRenderSample(pages, ["en"], null);

		expect(paths(sample.urls)).toEqual(["/en/fine"]);
	});

	it("samples everything on a site smaller than the cap", () => {
		const pages = [page("/en/a"), page("/en/b")];

		const sample = chooseRenderSample(pages, ["en"], null);

		expect(sample.urls).toHaveLength(2);
	});

	/**
	 * A project that declared no locales, or a site whose pages carry none we
	 * could read, still deserves a measurement. Returning nothing would be a
	 * policy dressed up as an answer.
	 */
	it("falls back to the most-linked pages when no locale matches", () => {
		const pages = [
			page("/a", { locale: null, inboundLinks: 3 }),
			page("/b", { locale: null, inboundLinks: 30 }),
		];

		const sample = chooseRenderSample(pages, ["en"], null, 1);

		expect(paths(sample.urls)).toEqual(["/b"]);
	});

	/**
	 * A caller asking for no measurement must receive none. The entry page is
	 * taken unconditionally otherwise, which quietly turned "render nothing" into
	 * "render one page" — and a run that rendered when it was told not to is a
	 * run whose cost nobody agreed to.
	 */
	it("chooses nothing when the cap is zero, entry page included", () => {
		const pages = [page("/"), page("/en/popular", { inboundLinks: 99 })];

		expect(chooseRenderSample(pages, ["en"], `${BASE}/`, 0).urls).toEqual([]);
	});

	it("returns an empty sample rather than throwing on empty input", () => {
		expect(chooseRenderSample([], ["en"], null)).toEqual({
			urls: [],
			cap: MAX_RENDERS,
			locales: ["en"],
		});
	});

	it("treats a regional page as answering the declared language", () => {
		const pages = [page("/en-gb/a", { locale: "en-GB", inboundLinks: 4 })];

		const sample = chooseRenderSample(pages, ["en"], null, 1);

		expect(paths(sample.urls)).toEqual(["/en-gb/a"]);
	});
});

describe("countInboundLinks", () => {
	it("counts the pages pointing at a page, not the links it emits", () => {
		const counts = countInboundLinks([
			{ url: `${BASE}/`, links: [`${BASE}/a`, `${BASE}/b`] },
			{ url: `${BASE}/a`, links: [`${BASE}/b`] },
			{ url: `${BASE}/b`, links: [] },
		]);

		expect(counts.get(`${BASE}/b`)).toBe(2);
		expect(counts.get(`${BASE}/a`)).toBe(1);
		expect(counts.get(`${BASE}/`) ?? 0).toBe(0);
	});

	/**
	 * A nav item highlighting the page you are on is not the site recommending
	 * it. Counting self-links would rank every page in a shared template equally
	 * and tell us nothing.
	 */
	it("ignores a page linking to itself", () => {
		const counts = countInboundLinks([
			{ url: `${BASE}/a`, links: [`${BASE}/a`] },
		]);

		expect(counts.get(`${BASE}/a`) ?? 0).toBe(0);
	});

	it("counts one page linking twice as one", () => {
		const counts = countInboundLinks([
			{ url: `${BASE}/`, links: [`${BASE}/a`, `${BASE}/a`] },
			{ url: `${BASE}/a`, links: [] },
		]);

		expect(counts.get(`${BASE}/a`)).toBe(1);
	});

	/**
	 * A link off the site, or to a page the crawl never recorded, is not evidence
	 * about a page we could sample.
	 */
	it("ignores links to pages the crawl never recorded", () => {
		const counts = countInboundLinks([
			{ url: `${BASE}/`, links: ["https://elsewhere.test/x", `${BASE}/gone`] },
		]);

		expect(counts.size).toBe(0);
	});
});
