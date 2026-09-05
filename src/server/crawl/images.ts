import { normaliseUrl } from "./url";

/**
 * What a page's images are, reduced to the smallest set of facts worth keeping.
 *
 * The same bargain `content.ts` struck: the crawl already fetches and parses
 * every page's HTML and then throws it away, so reading the images out of it
 * costs no additional request. What it costs is memory — this is held for every
 * page of a crawl that can reach two thousand — so nothing here grows with the
 * number of images on the page. Counts are unbounded; the URL lists that back
 * them are capped, and the cap is recorded so a reader is never shown a
 * truncated list as if it were whole.
 *
 * Deliberately not a parser, for the reason `content.ts` gives: a real DOM would
 * be more accurate and would also be a dependency, a startup cost, and a second
 * definition of "what this page contains" living beside the regex extractors
 * already in `crawler.ts`.
 *
 * Every fact here is the site's own markup. Whether an `img` declares its
 * dimensions, and what file it points at, are things the page asserted about
 * itself — not inferences of ours about how it renders.
 */

/** One image the page referenced, as the markup described it. */
export type ImageRef = {
	url: string;
	/** Whether the element declared both `width` and `height`. */
	dimensioned: boolean;
	/**
	 * Whether a modern format is on offer for this image.
	 *
	 * True when the file itself is one, and also when a `picture` wraps it and
	 * any `source` advertises one: the site did provide a modern format, and
	 * reporting the fallback would be a finding about the fallback existing.
	 */
	modern: boolean;
};

export type ImageSummary = {
	/** Distinct image URLs the page referenced. */
	total: number;
	/** Of those, how many declared neither a width nor a height. */
	undimensioned: number;
	/** Of those, how many were offered in no modern format. */
	legacy: number;
	/** Up to {@link MAX_LISTED} undimensioned URLs, for the finding to cite. */
	undimensionedUrls: string[];
	/** Up to {@link MAX_LISTED} legacy-format URLs, for the finding to cite. */
	legacyUrls: string[];
	/** Every distinct URL, capped, for the weight sweep to ask about. */
	urls: string[];
};

/**
 * How many URLs a summary will carry per class.
 *
 * The counts are exact; these lists are evidence, and a page with four hundred
 * images needs the reader to see a handful and the number, not four hundred
 * strings multiplied by the page ceiling.
 */
export const MAX_LISTED = 10;

/** Formats a browser can be expected to decode more cheaply than the classics. */
const MODERN_EXTENSIONS = new Set(["webp", "avif"]);

/**
 * Formats this module has an opinion about at all.
 *
 * An `svg` is a vector and has no modern replacement; an `ico` is a favicon; a
 * data URI was never fetched over the network. None of them can be "served in a
 * legacy format", so none of them is judged — the alternative is a finding on
 * every site that publishes a logo.
 */
const RASTER_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "bmp", "tiff"]);

const IMG_TAG = /<img\b[^>]*>/gi;
const PICTURE_BLOCK = /<picture\b[^>]*>([\s\S]*?)<\/picture>/gi;
const SOURCE_TAG = /<source\b[^>]*>/gi;

const attribute = (tag: string, name: string): string | null => {
	const match = tag.match(
		new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
	);
	return match ? (match[2] ?? match[3] ?? match[4] ?? "").trim() : null;
};

/** The extension of a URL's path, lowercased, or null when it has none. */
const extensionOf = (url: string): string | null => {
	try {
		const path = new URL(url).pathname;
		const dot = path.lastIndexOf(".");
		if (dot === -1 || dot === path.length - 1) return null;
		return path.slice(dot + 1).toLowerCase();
	} catch {
		return null;
	}
};

/**
 * Whether this URL is one the "legacy format" question even applies to.
 *
 * A URL with no extension is not judged either: a CDN serving `/image/1234` may
 * well be negotiating a modern format by content type, and calling it legacy
 * would be a claim about our guess rather than about their delivery.
 */
const judgeable = (url: string): boolean => {
	const extension = extensionOf(url);
	return extension !== null && RASTER_EXTENSIONS.has(extension);
};

const isModernFile = (url: string): boolean => {
	const extension = extensionOf(url);
	return extension !== null && MODERN_EXTENSIONS.has(extension);
};

/** The first candidate in a `srcset`, which is enough to name the format. */
const firstOfSrcset = (value: string): string | null => {
	const first = value.split(",")[0]?.trim().split(/\s+/)[0];
	return first && first.length > 0 ? first : null;
};

export function emptyImages(): ImageSummary {
	return {
		total: 0,
		undimensioned: 0,
		legacy: 0,
		undimensionedUrls: [],
		legacyUrls: [],
		urls: [],
	};
}

/**
 * Reads a page's images out of its markup.
 *
 * `isHtml` is honoured for the reason `extractContent` honours it: a PDF or a
 * feed contains no images in this sense, and a summary claiming otherwise would
 * make the format the URL serves look like a defect.
 */
export function extractImages(
	html: string,
	pageUrl: string,
	isHtml: boolean,
): ImageSummary {
	if (!isHtml) return emptyImages();

	/**
	 * Which `img` elements sit inside a `picture` that offers a modern format.
	 *
	 * Collected first, because the `img` inside such a block is the *fallback* —
	 * the site's answer for browsers that cannot take the modern one — and
	 * reporting it would be reporting the site for being careful.
	 */
	const coveredByPicture = new Set<string>();
	for (const block of html.matchAll(PICTURE_BLOCK)) {
		const inner = block[1] ?? "";
		let offersModern = false;
		for (const source of inner.matchAll(SOURCE_TAG)) {
			const tag = source[0];
			const type = attribute(tag, "type");
			if (type && /image\/(webp|avif)/i.test(type)) {
				offersModern = true;
				break;
			}
			const srcset = attribute(tag, "srcset");
			const candidate = srcset ? firstOfSrcset(srcset) : null;
			const resolved = candidate ? normaliseUrl(candidate, pageUrl) : null;
			if (resolved && isModernFile(resolved)) {
				offersModern = true;
				break;
			}
		}
		if (!offersModern) continue;

		for (const img of inner.matchAll(IMG_TAG)) {
			const src = attribute(img[0], "src");
			const resolved = src ? normaliseUrl(src, pageUrl) : null;
			if (resolved) coveredByPicture.add(resolved);
		}
	}

	/** Deduplicated per page: one URL used four times is one image. */
	const seen = new Map<string, ImageRef>();

	for (const match of html.matchAll(IMG_TAG)) {
		const tag = match[0];
		const src =
			attribute(tag, "src") ??
			(attribute(tag, "srcset")
				? firstOfSrcset(attribute(tag, "srcset") as string)
				: null);
		if (!src || src.startsWith("data:")) continue;

		const url = normaliseUrl(src, pageUrl);
		if (!url) continue;

		/**
		 * Both, not either. A width without a height reserves no space, so the
		 * layout still shifts when the image arrives — which is the whole reason
		 * the attributes are worth reporting.
		 */
		const dimensioned =
			attribute(tag, "width") !== null && attribute(tag, "height") !== null;

		const modern =
			!judgeable(url) || isModernFile(url) || coveredByPicture.has(url);

		const existing = seen.get(url);
		if (existing) {
			// The most generous reading of the same URL wins: a site that declared
			// dimensions somewhere did declare them.
			existing.dimensioned = existing.dimensioned || dimensioned;
			existing.modern = existing.modern || modern;
			continue;
		}

		seen.set(url, { url, dimensioned, modern });
	}

	const refs = [...seen.values()].sort((a, b) => a.url.localeCompare(b.url));
	const undimensioned = refs.filter((r) => !r.dimensioned);
	const legacy = refs.filter((r) => !r.modern);

	return {
		total: refs.length,
		undimensioned: undimensioned.length,
		legacy: legacy.length,
		undimensionedUrls: undimensioned.slice(0, MAX_LISTED).map((r) => r.url),
		legacyUrls: legacy.slice(0, MAX_LISTED).map((r) => r.url),
		urls: refs.slice(0, MAX_LISTED * 4).map((r) => r.url),
	};
}
