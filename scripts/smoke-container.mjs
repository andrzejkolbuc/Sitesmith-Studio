/**
 * Assert that the containerised application's own render path produces a real
 * page measurement.
 *
 * Runs inside the running app container, against a URL the composition itself
 * serves — the app's own sign-in page, which needs no authentication, no project
 * record and no fixture site.
 *
 * This is a different depth from `check-browser.mjs` and both are kept.
 * `check-browser.mjs` proves a browser and its system libraries exist in the
 * final image; it fails when the Dockerfile or the base image is wrong. This
 * proves the code at `src/server/crawl/render.ts:289` reaches them; it failing
 * while the other passes means the application or its wiring is wrong, not the
 * image.
 *
 * **Absence of errors is explicitly not the assertion.** `render.ts:289-297`
 * catches a failed launch and returns a successful-looking
 * `{ observations: [], complete: false }`, so a check written around thrown
 * errors passes on a broken image — which is the failure this exists to catch.
 * What is asserted is positive: `complete` is true, and at least one observation
 * came back carrying a measurement rather than a `renderError`.
 *
 *   docker compose --profile app exec app node scripts/smoke-container.mjs
 *
 * It imports `render.ts` directly rather than driving the UI, so the check has
 * exactly one reason to fail. The HTTP path is already covered by the e2e suite
 * on the host; what nothing else covers is whether this code, in this image, can
 * open a browser. `render.ts` imports nothing but `playwright`, so Node's own
 * type stripping runs it unmodified — no wrapper, no second copy of the logic.
 */

import { renderSample } from "../src/server/crawl/render.ts";

/** The container serves on 3000 regardless of what the composition publishes. */
const TARGET = process.env.SMOKE_URL ?? "http://localhost:3000/signin";
const origin = new URL(TARGET).origin;

console.log(`smoke: rendering ${TARGET}`);

const result = await renderSample({ urls: [TARGET], origin });

if (!result.complete) {
	console.error("smoke: the browser was not usable.");
	console.error(
		"    `renderSample` returned complete: false, which it does when",
	);
	console.error(
		"    `chromium.launch()` throws — a missing browser binary, a missing",
	);
	console.error("    system library, or a sandbox refusing to start.");
	console.error(
		"    The image can still boot, serve and crawl in this state; it just",
	);
	console.error(
		"    measures nothing. That is the failure this check exists for.",
	);
	process.exit(1);
}

const [observation] = result.observations;

if (!observation) {
	console.error("smoke: the browser was usable but measured no page.");
	console.error(`    Asked for ${TARGET} and got an empty observation list.`);
	process.exit(1);
}

if (observation.renderError !== null) {
	console.error("smoke: the page could not be rendered.");
	console.error(`    ${observation.url}: ${observation.renderError}`);
	process.exit(1);
}

const { ttfbMs, lcpMs, cls } = observation.vitals;

/**
 * A measurement, not merely a row. TTFB comes from the browser's own navigation
 * timing, so a null here means the page never actually navigated — the shape of
 * result a browser that started but could not reach the server produces.
 */
if (ttfbMs === null) {
	console.error("smoke: the page rendered but reported no navigation timing.");
	console.error(`    ${observation.url} returned vitals with a null TTFB.`);
	process.exit(1);
}

console.log(
	`smoke: measured ${observation.url} — TTFB ${ttfbMs}ms, LCP ${lcpMs ?? "n/a"}ms, CLS ${cls ?? "n/a"}`,
);
console.log(
	`smoke: ${observation.firstPartyErrors} first-party and ${observation.thirdPartyErrors} third-party console errors.`,
);
