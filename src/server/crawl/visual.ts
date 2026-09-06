import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/**
 * Whether two pictures of a page are pictures of the same thing, and where they
 * differ if they are not.
 *
 * The awkward fact about this check, and the one that shapes every decision
 * here: **our own rendering is part of the evidence.** Everywhere else in this
 * directory a finding traces back to something the site asserted — a header, a
 * tag, a status code. Here the product renders the page itself and then reports
 * on what it drew, so a difference can come from the site changing, from the
 * browser drawing text a pixel differently, or from us photographing at the
 * wrong moment. Only the first is a statement about the client.
 *
 * Three things keep the other two out:
 *
 * 1. **Anti-aliasing is excluded by pixelmatch's own published heuristic**, not
 *    by a threshold we invented. The distinction matters: a reader can look up
 *    what `includeAA: false` does, and disagreeing with it is disagreeing with a
 *    documented algorithm rather than with a number we chose.
 * 2. **Masked regions never enter the image at all** — they are painted over at
 *    capture, so there is nothing here to subtract.
 * 3. **A pair that cannot be compared refuses** rather than reporting a
 *    difference. A different viewport, a different mask list, a different width:
 *    each is us changing, and each would otherwise read as the whole site
 *    breaking on the day we changed our minds.
 *
 * What is deliberately absent is a similarity score. A 0-100 "how alike" grade
 * is a composite index the product would be asserting — refused for performance,
 * refused for the quality trend, refused again here. Changed pixels are a
 * measurement; a grade is an opinion of one.
 */

/** One stored picture, in the shape the comparison needs. */
export type SnapshotImage = {
	image: Buffer;
	viewportWidth: number;
	viewportHeight: number;
	maskSelectors: string[];
};

export type ComparisonRefusal =
	/** One side has no picture: never captured, capture failed, or expired. */
	| "missing"
	/** The two were photographed at different browser sizes. */
	| "viewport_differs"
	/** The project's masks changed, so the two hide different things. */
	| "masks_differ"
	/** Same viewport, different image width — a picture we cannot trust. */
	| "width_differs"
	/** One of the files would not decode. */
	| "unreadable";

/** A rectangle, in image pixels, containing part of what changed. */
export type Region = { x: number; y: number; width: number; height: number };

export type SnapshotComparison =
	| { comparable: false; reason: ComparisonRefusal }
	| {
			comparable: true;
			/** Pixels that differ, over the region both pictures cover. */
			changedPixels: number;
			/** How many pixels were compared, so the count has a denominator. */
			comparedPixels: number;
			/** Where the differences are. Empty when nothing changed. */
			regions: Region[];
			/** True when there were more regions than {@link MAX_REGIONS}. */
			regionsCapped: boolean;
			/**
			 * How much taller or shorter the current page is, in pixels.
			 *
			 * Reported rather than refused. A full-page picture's height is a
			 * property of the page, so a page that grew is a real observation about
			 * the site — and the comparison still has the overlapping region to say
			 * something about.
			 */
			heightDelta: number;
	  };

/**
 * How many rectangles a finding will cite.
 *
 * A cap, because "where did it change" stops being an answer somewhere around a
 * dozen boxes — past that the honest summary is that the page changed, and the
 * reader should look at it. Eight is enough to distinguish "the header moved"
 * from "everything moved".
 */
export const MAX_REGIONS = 8;

/**
 * The grid the regions are built on.
 *
 * Changed pixels are marked into cells and adjacent cells merged, rather than
 * reporting per-pixel runs. Sixteen pixels is small enough to separate two
 * genuinely distinct changes on a page and large enough that a single shifted
 * line of text is one box rather than forty.
 */
export const REGION_CELL_PX = 16;

/**
 * Per-pixel colour distance before two pixels count as different.
 *
 * pixelmatch's own default, kept rather than tuned. A number we picked would be
 * a number we would have to defend on every site; a documented default is one
 * anyone can look up.
 */
export const PIXEL_THRESHOLD = 0.1;

type Decoded = { data: Buffer; width: number; height: number };

function decode(png: Buffer): Decoded | null {
	try {
		const parsed = PNG.sync.read(png);
		return { data: parsed.data, width: parsed.width, height: parsed.height };
	} catch {
		return null;
	}
}

/** Set equality over two selector lists — order is not a difference. */
function sameMasks(a: string[], b: string[]): boolean {
	const left = new Set(a);
	const right = new Set(b);
	if (left.size !== right.size) return false;
	for (const value of left) if (!right.has(value)) return false;
	return true;
}

/**
 * Everything both comparisons need, done once.
 *
 * `compareSnapshots` wants the numbers and `diffOverlay` wants the picture, and
 * they must agree — two code paths deciding separately what counts as different
 * is how a reader ends up shown an overlay that contradicts the count beside it.
 */
function diff(
	baseline: SnapshotImage | null,
	current: SnapshotImage | null,
):
	| { ok: false; reason: ComparisonRefusal }
	| {
			ok: true;
			changed: number;
			width: number;
			height: number;
			heightDelta: number;
			output: PNG;
	  } {
	if (!baseline || !current) return { ok: false, reason: "missing" };

	if (
		baseline.viewportWidth !== current.viewportWidth ||
		baseline.viewportHeight !== current.viewportHeight
	) {
		return { ok: false, reason: "viewport_differs" };
	}

	if (!sameMasks(baseline.maskSelectors, current.maskSelectors)) {
		return { ok: false, reason: "masks_differ" };
	}

	const before = decode(baseline.image);
	const after = decode(current.image);
	if (!before || !after) return { ok: false, reason: "unreadable" };

	/**
	 * At a pinned viewport two pictures of the same site cannot legitimately
	 * differ in width, so a mismatch means something about the capture rather
	 * than about the page — and comparing across it would report the whole image
	 * as changed.
	 */
	if (before.width !== after.width)
		return { ok: false, reason: "width_differs" };

	/**
	 * Heights differ whenever the page's own length changed, which is ordinary.
	 * The overlap is what both pictures actually cover, and it is what gets
	 * compared; the delta travels alongside as its own piece of evidence.
	 */
	const width = before.width;
	const height = Math.min(before.height, after.height);
	const bytes = width * height * 4;

	const output = new PNG({ width, height });
	const changed = pixelmatch(
		before.data.subarray(0, bytes),
		after.data.subarray(0, bytes),
		output.data,
		width,
		height,
		{ threshold: PIXEL_THRESHOLD, includeAA: false },
	);

	return {
		ok: true,
		changed,
		width,
		height,
		heightDelta: after.height - before.height,
		output,
	};
}

/**
 * Groups changed pixels into a handful of rectangles.
 *
 * Cells first, then connected components over the cells, then a bounding box per
 * component. Deterministic by construction — the grid is fixed, the scan order
 * is fixed, and the cap takes the largest — so two runs over the same pair of
 * pictures produce the same boxes. A comparison whose "where" wandered between
 * identical inputs would be unreadable.
 */
function regionsOf(
	output: PNG,
	width: number,
	height: number,
): { regions: Region[]; capped: boolean } {
	const cols = Math.ceil(width / REGION_CELL_PX);
	const rows = Math.ceil(height / REGION_CELL_PX);
	const marked = new Uint8Array(cols * rows);

	/**
	 * pixelmatch paints differing pixels red and leaves the rest a dimmed grey,
	 * so a fully-opaque strong red is the marker. Read from the output rather
	 * than re-derived from the inputs, so the boxes describe exactly the pixels
	 * the count counted.
	 */
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const at = (y * width + x) * 4;
			const red = output.data[at] ?? 0;
			const green = output.data[at + 1] ?? 0;
			const blue = output.data[at + 2] ?? 0;
			if (red < 200 || green > 120 || blue > 120) continue;

			marked[
				Math.floor(y / REGION_CELL_PX) * cols + Math.floor(x / REGION_CELL_PX)
			] = 1;
		}
	}

	const seen = new Uint8Array(cols * rows);
	const boxes: Region[] = [];

	for (let row = 0; row < rows; row += 1) {
		for (let col = 0; col < cols; col += 1) {
			const start = row * cols + col;
			if (!marked[start] || seen[start]) continue;

			let minCol = col;
			let maxCol = col;
			let minRow = row;
			let maxRow = row;

			/** Iterative flood fill; a recursive one would blow the stack on a
			 * full-page change. */
			const queue = [start];
			seen[start] = 1;

			while (queue.length > 0) {
				const cell = queue.pop() as number;
				const cellRow = Math.floor(cell / cols);
				const cellCol = cell % cols;

				if (cellCol < minCol) minCol = cellCol;
				if (cellCol > maxCol) maxCol = cellCol;
				if (cellRow < minRow) minRow = cellRow;
				if (cellRow > maxRow) maxRow = cellRow;

				const neighbours = [
					cellCol > 0 ? cell - 1 : -1,
					cellCol < cols - 1 ? cell + 1 : -1,
					cellRow > 0 ? cell - cols : -1,
					cellRow < rows - 1 ? cell + cols : -1,
				];

				for (const next of neighbours) {
					if (next < 0 || !marked[next] || seen[next]) continue;
					seen[next] = 1;
					queue.push(next);
				}
			}

			boxes.push({
				x: minCol * REGION_CELL_PX,
				y: minRow * REGION_CELL_PX,
				width:
					Math.min((maxCol + 1) * REGION_CELL_PX, width) -
					minCol * REGION_CELL_PX,
				height:
					Math.min((maxRow + 1) * REGION_CELL_PX, height) -
					minRow * REGION_CELL_PX,
			});
		}
	}

	/** Largest first, so a cap keeps what a reader would have looked at anyway. */
	boxes.sort((a, b) => b.width * b.height - a.width * a.height);

	return {
		regions: boxes.slice(0, MAX_REGIONS),
		capped: boxes.length > MAX_REGIONS,
	};
}

export function compareSnapshots(
	baseline: SnapshotImage | null,
	current: SnapshotImage | null,
): SnapshotComparison {
	const result = diff(baseline, current);
	if (!result.ok) return { comparable: false, reason: result.reason };

	const { regions, capped } = regionsOf(
		result.output,
		result.width,
		result.height,
	);

	return {
		comparable: true,
		changedPixels: result.changed,
		comparedPixels: result.width * result.height,
		regions,
		regionsCapped: capped,
		heightDelta: result.heightDelta,
	};
}

/**
 * The highlighted picture, made on demand rather than stored.
 *
 * A third image per compared page would be roughly half again as much of the
 * one line item the PRD singled out as most likely to force a hosting bill, and
 * both inputs are already held. Made from the same `diff` the count came from,
 * so the overlay and the number can never disagree.
 */
export function diffOverlay(
	baseline: SnapshotImage | null,
	current: SnapshotImage | null,
): Buffer | null {
	const result = diff(baseline, current);
	if (!result.ok) return null;
	return PNG.sync.write(result.output);
}
