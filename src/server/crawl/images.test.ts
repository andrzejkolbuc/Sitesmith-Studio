import { describe, expect, it } from "vitest";

import { emptyImages, extractImages, MAX_LISTED } from "./images";

const PAGE = "https://x.test/en/products";

const html = (body: string) => `<html><body>${body}</body></html>`;

describe("extractImages", () => {
	it("counts an image that declares both dimensions as dimensioned", () => {
		const summary = extractImages(
			html(`<img src="/a.jpg" width="800" height="600">`),
			PAGE,
			true,
		);

		expect(summary.total).toBe(1);
		expect(summary.undimensioned).toBe(0);
		expect(summary.undimensionedUrls).toEqual([]);
	});

	/**
	 * Both attributes, never either. A width alone reserves no space, because the
	 * height is what stops the rest of the document moving when the image lands —
	 * so a page declaring one is in the same position as a page declaring none.
	 */
	it("treats an image declaring only one dimension as undimensioned", () => {
		const summary = extractImages(
			html(`<img src="/a.jpg" width="800">`),
			PAGE,
			true,
		);

		expect(summary.undimensioned).toBe(1);
		expect(summary.undimensionedUrls).toEqual(["https://x.test/a.jpg"]);
	});

	it("counts an image declaring neither dimension", () => {
		const summary = extractImages(html(`<img src="/a.jpg">`), PAGE, true);

		expect(summary.undimensioned).toBe(1);
	});

	it("reports a jpeg as legacy and a webp as modern", () => {
		const summary = extractImages(
			html(`<img src="/old.jpg"><img src="/new.webp">`),
			PAGE,
			true,
		);

		expect(summary.total).toBe(2);
		expect(summary.legacy).toBe(1);
		expect(summary.legacyUrls).toEqual(["https://x.test/old.jpg"]);
	});

	/**
	 * The fallback inside a `picture` is the site being careful about old
	 * browsers. Reporting it would punish exactly the markup this rule wants to
	 * see, so a modern `source` exempts the `img` it protects.
	 */
	it("does not report a jpeg fallback when a picture offers a modern source", () => {
		const summary = extractImages(
			html(
				`<picture><source type="image/avif" srcset="/hero.avif"><img src="/hero.jpg"></picture>`,
			),
			PAGE,
			true,
		);

		expect(summary.legacy).toBe(0);
	});

	it("still reports a jpeg fallback when the picture offers nothing modern", () => {
		const summary = extractImages(
			html(
				`<picture><source srcset="/hero-wide.jpg"><img src="/hero.jpg"></picture>`,
			),
			PAGE,
			true,
		);

		expect(summary.legacy).toBeGreaterThan(0);
	});

	/**
	 * An `svg` is a vector with no modern replacement, and an extensionless CDN
	 * URL may well be negotiating a format by content type. Judging either would
	 * be a finding about our guess rather than about the site's delivery.
	 */
	it("judges neither svg nor extensionless URLs on format", () => {
		const summary = extractImages(
			html(`<img src="/logo.svg"><img src="/cdn/image/12345">`),
			PAGE,
			true,
		);

		expect(summary.total).toBe(2);
		expect(summary.legacy).toBe(0);
	});

	it("ignores data URIs, which were never fetched over the network", () => {
		const summary = extractImages(
			html(`<img src="data:image/gif;base64,R0lGOD"><img src="/a.jpg">`),
			PAGE,
			true,
		);

		expect(summary.total).toBe(1);
	});

	it("counts one URL used several times as one image", () => {
		const summary = extractImages(
			html(`<img src="/a.jpg"><img src="/a.jpg"><img src="/a.jpg">`),
			PAGE,
			true,
		);

		expect(summary.total).toBe(1);
	});

	/**
	 * The most generous reading of a repeated URL wins: a site that declared the
	 * dimensions somewhere did declare them, and reporting it for the one place
	 * it did not would be reporting the same image twice over.
	 */
	it("credits a repeated URL with dimensions declared anywhere", () => {
		const summary = extractImages(
			html(`<img src="/a.jpg"><img src="/a.jpg" width="8" height="6">`),
			PAGE,
			true,
		);

		expect(summary.undimensioned).toBe(0);
	});

	it("resolves relative sources against the page", () => {
		const summary = extractImages(html(`<img src="../a.jpg">`), PAGE, true);

		expect(summary.urls).toEqual(["https://x.test/a.jpg"]);
	});

	/**
	 * The counts are exact and the lists are evidence. A page with hundreds of
	 * images must not multiply hundreds of strings by the two-thousand-page
	 * ceiling this record lives under.
	 */
	it("caps the listed URLs while keeping the count exact", () => {
		const many = Array.from(
			{ length: MAX_LISTED + 15 },
			(_, i) => `<img src="/img-${i}.jpg">`,
		).join("");
		const summary = extractImages(html(many), PAGE, true);

		expect(summary.undimensioned).toBe(MAX_LISTED + 15);
		expect(summary.undimensionedUrls).toHaveLength(MAX_LISTED);
	});

	/**
	 * A PDF or a feed contains no images in this sense. Summarising its bytes as
	 * markup would make the format the URL serves look like a defect.
	 */
	it("summarises a non-HTML response to nothing", () => {
		expect(extractImages("%PDF-1.4 ...", PAGE, false)).toEqual(emptyImages());
	});

	it("returns an empty summary for a page with no images", () => {
		expect(extractImages(html("<p>hello</p>"), PAGE, true)).toEqual(
			emptyImages(),
		);
	});

	it("handles single-quoted and unquoted attributes", () => {
		const summary = extractImages(
			html(`<img src='/a.jpg' width=800 height=600>`),
			PAGE,
			true,
		);

		expect(summary.total).toBe(1);
		expect(summary.undimensioned).toBe(0);
	});
});
