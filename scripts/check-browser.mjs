/**
 * Assert, from inside the image, that a browser launches and can open a page.
 *
 * This is the check that distinguishes a working image from the quiet broken
 * one. `src/server/crawl/render.ts:289-297` catches a failed `chromium.launch()`
 * and returns `{ observations: [], complete: false }` — by design, because
 * reporting a site as free of console errors when no browser opened is a claim
 * this codebase refuses to make. The consequence for deployment is that an image
 * with no working Chromium boots, serves every page and crawls; it just silently
 * measures nothing. Nothing in the application will ever announce that.
 *
 * So this asserts the positive fact and refuses to degrade: it launches exactly
 * as `render.ts:289` does, opens a page, reads a value back out of it, and exits
 * zero only if all of that happened. Any failure exits non-zero carrying the
 * underlying error, because degrading is the bug it exists to catch.
 *
 * Depth matters: this proves the browser binary and its system libraries are
 * present in the final layer. It says nothing about whether the application's
 * own code path reaches them — that is `smoke-container.mjs`. When this fails,
 * look at the Dockerfile or the base image.
 *
 *   docker run --rm sitesmith-studio node scripts/check-browser.mjs
 *
 * `.mjs` rather than `.ts`, and no import of anything under `src/`, so it runs
 * against the standalone output with no build step and no environment.
 */

import { chromium } from "playwright";

/**
 * A `data:` URL, so the check needs no network, no server and no fixture. The
 * marker is read back out of the rendered DOM rather than out of the URL, which
 * is what makes this evidence the page was actually executed.
 */
const MARKER = "browser-is-alive";
const PAGE = `data:text/html,<title>${MARKER}</title><p id="marker">${MARKER}</p>`;

let browser;

try {
	browser = await chromium.launch({ headless: true });
} catch (caught) {
	console.error("check-browser: chromium failed to launch.");
	console.error(
		"    The browser binary or its system libraries are missing from this image.",
	);
	console.error(
		"    The final stage must be the Playwright base image — Chromium is a binary",
	);
	console.error("    and is never traced into the standalone output.");
	console.error(caught);
	process.exit(1);
}

try {
	const page = await browser.newPage();
	await page.goto(PAGE);

	const read = await page.textContent("#marker");
	if (read !== MARKER) {
		console.error("check-browser: the browser launched but rendered nothing.");
		console.error(
			`    Expected "${MARKER}" in the page, read ${JSON.stringify(read)}.`,
		);
		process.exit(1);
	}

	const version = browser.version();
	console.log(
		`check-browser: chromium ${version} launched and rendered a page.`,
	);
} catch (caught) {
	console.error(
		"check-browser: the browser launched but could not open a page.",
	);
	console.error(caught);
	process.exit(1);
} finally {
	await browser.close().catch(() => {});
}
