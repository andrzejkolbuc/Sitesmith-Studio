import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import {
	compareSnapshots,
	diffOverlay,
	MAX_REGIONS,
	REGION_CELL_PX,
	type SnapshotImage,
} from "./visual";

/**
 * The comparison, on pictures made here rather than photographed.
 *
 * Synthetic PNGs on purpose: what these cases fix is the arithmetic and the
 * refusals, and a real screenshot would make every one of them depend on a
 * browser's font rendering. The browser's half is exercised in
 * `render.integration.test.ts`, where it belongs.
 */

/** A solid canvas, optionally with one rectangle painted a different colour. */
function image(
	width: number,
	height: number,
	patch?: { x: number; y: number; width: number; height: number },
): Buffer {
	const png = new PNG({ width, height });

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const at = (y * width + x) * 4;
			const inside =
				patch !== undefined &&
				x >= patch.x &&
				x < patch.x + patch.width &&
				y >= patch.y &&
				y < patch.y + patch.height;

			png.data[at] = inside ? 0 : 255;
			png.data[at + 1] = inside ? 0 : 255;
			png.data[at + 2] = inside ? 0 : 255;
			png.data[at + 3] = 255;
		}
	}

	return PNG.sync.write(png);
}

function snapshot(
	png: Buffer,
	overrides: Partial<Omit<SnapshotImage, "image">> = {},
): SnapshotImage {
	return {
		image: png,
		viewportWidth: 1280,
		viewportHeight: 800,
		maskSelectors: [],
		...overrides,
	};
}

describe("compareSnapshots", () => {
	it("finds nothing between two identical pictures", () => {
		const png = image(64, 64);
		const result = compareSnapshots(snapshot(png), snapshot(png));

		expect(result).toMatchObject({
			comparable: true,
			changedPixels: 0,
			comparedPixels: 64 * 64,
			regions: [],
			regionsCapped: false,
			heightDelta: 0,
		});
	});

	it("counts a changed block and says where it is", () => {
		const patch = { x: 16, y: 32, width: 16, height: 16 };
		const result = compareSnapshots(
			snapshot(image(64, 64)),
			snapshot(image(64, 64, patch)),
		);

		if (!result.comparable) throw new Error("expected a comparison");
		expect(result.changedPixels).toBe(patch.width * patch.height);
		expect(result.regions).toHaveLength(1);

		/** The box covers the change; the grid may make it no smaller than a cell. */
		const [region] = result.regions;
		expect(region?.x).toBeLessThanOrEqual(patch.x);
		expect(region?.y).toBeLessThanOrEqual(patch.y);
		expect((region?.x ?? 0) + (region?.width ?? 0)).toBeGreaterThanOrEqual(
			patch.x + patch.width,
		);
		expect((region?.y ?? 0) + (region?.height ?? 0)).toBeGreaterThanOrEqual(
			patch.y + patch.height,
		);
	});

	/**
	 * Two runs over the same pair must produce the same boxes. A "where" that
	 * wandered between identical inputs would be unreadable, and would make every
	 * comparison of two comparisons meaningless.
	 */
	it("produces identical regions for identical input", () => {
		const before = snapshot(image(64, 64));
		const after = snapshot(
			image(64, 64, { x: 0, y: 0, width: 20, height: 20 }),
		);

		const first = compareSnapshots(before, after);
		const second = compareSnapshots(before, after);

		expect(first).toEqual(second);
	});

	it("caps the regions it reports and says that it did", () => {
		/**
		 * More separated blocks than the cap allows, each its own component: a
		 * column of single cells with a blank cell between them.
		 */
		const size = REGION_CELL_PX * (MAX_REGIONS + 4) * 2;
		const png = new PNG({ width: REGION_CELL_PX, height: size });
		for (let y = 0; y < size; y += 1) {
			for (let x = 0; x < REGION_CELL_PX; x += 1) {
				const at = (y * REGION_CELL_PX + x) * 4;
				const band = Math.floor(y / REGION_CELL_PX);
				const on = band % 2 === 0;
				png.data[at] = on ? 0 : 255;
				png.data[at + 1] = on ? 0 : 255;
				png.data[at + 2] = on ? 0 : 255;
				png.data[at + 3] = 255;
			}
		}

		const result = compareSnapshots(
			snapshot(image(REGION_CELL_PX, size)),
			snapshot(PNG.sync.write(png)),
		);

		if (!result.comparable) throw new Error("expected a comparison");
		expect(result.regions).toHaveLength(MAX_REGIONS);
		expect(result.regionsCapped).toBe(true);
	});

	/**
	 * A page's own length is a property of the page, so a taller picture is an
	 * observation rather than a fault. The overlap is what both pictures cover,
	 * and it is what gets compared.
	 */
	it("compares the overlap when the page grew and reports the delta", () => {
		const result = compareSnapshots(
			snapshot(image(64, 64)),
			snapshot(image(64, 100)),
		);

		expect(result).toMatchObject({
			comparable: true,
			changedPixels: 0,
			comparedPixels: 64 * 64,
			heightDelta: 36,
		});
	});

	it("reports a shorter page as a negative delta", () => {
		const result = compareSnapshots(
			snapshot(image(64, 100)),
			snapshot(image(64, 64)),
		);

		expect(result).toMatchObject({ comparable: true, heightDelta: -36 });
	});

	describe("refusals", () => {
		it("refuses when either side has no picture", () => {
			const present = snapshot(image(16, 16));
			expect(compareSnapshots(null, present)).toEqual({
				comparable: false,
				reason: "missing",
			});
			expect(compareSnapshots(present, null)).toEqual({
				comparable: false,
				reason: "missing",
			});
		});

		it("refuses a pair photographed at different viewports", () => {
			const png = image(16, 16);
			expect(
				compareSnapshots(snapshot(png), snapshot(png, { viewportWidth: 1440 })),
			).toEqual({ comparable: false, reason: "viewport_differs" });
		});

		it("refuses a pair masked differently", () => {
			const png = image(16, 16);
			expect(
				compareSnapshots(
					snapshot(png, { maskSelectors: [".carousel"] }),
					snapshot(png, { maskSelectors: [".carousel", "#ads"] }),
				),
			).toEqual({ comparable: false, reason: "masks_differ" });
		});

		/** Order is not a difference: the same masks in another order still hide
		 * the same things. */
		it("accepts the same masks in a different order", () => {
			const png = image(16, 16);
			const result = compareSnapshots(
				snapshot(png, { maskSelectors: ["#ads", ".carousel"] }),
				snapshot(png, { maskSelectors: [".carousel", "#ads"] }),
			);

			expect(result.comparable).toBe(true);
		});

		it("refuses a pair of different widths", () => {
			expect(
				compareSnapshots(snapshot(image(64, 64)), snapshot(image(80, 64))),
			).toEqual({ comparable: false, reason: "width_differs" });
		});

		it("refuses a file it cannot read", () => {
			expect(
				compareSnapshots(
					snapshot(Buffer.from("not a png at all")),
					snapshot(image(16, 16)),
				),
			).toEqual({ comparable: false, reason: "unreadable" });
		});
	});
});

describe("diffOverlay", () => {
	it("returns a PNG of the same shape as the compared region", () => {
		const overlay = diffOverlay(
			snapshot(image(64, 100)),
			snapshot(image(64, 64, { x: 8, y: 8, width: 8, height: 8 })),
		);

		expect(overlay).not.toBeNull();
		const decoded = PNG.sync.read(overlay as Buffer);
		expect(decoded.width).toBe(64);
		/** The overlap, not either original — an overlay of pixels nobody compared
		 * would be showing a difference that was never measured. */
		expect(decoded.height).toBe(64);
	});

	it("returns nothing where the pair refused", () => {
		expect(diffOverlay(null, snapshot(image(16, 16)))).toBeNull();
	});
});
