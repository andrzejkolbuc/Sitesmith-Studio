import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration.
 *
 * The application under test runs on its own port against its own database, so
 * a suite that truncates tables can never reach the developer's data and a
 * manually-running dev server on 3000 is not disturbed. `e2e/global-setup.ts`
 * refuses to run if that database name is wrong, which makes the isolation
 * structural rather than a convention.
 */

try {
	process.loadEnvFile(".env");
} catch {
	// Absent .env is fine when the values already come from the environment.
}

const PORT = 3210;
/**
 * Addressed as `localhost`, deliberately.
 *
 * `next dev` serves its build chunks only to origins it trusts, and `127.0.0.1`
 * is not one of them by default — the pages render, every chunk 403s, and React
 * never hydrates. The symptom is a page that looks correct and ignores clicks.
 * The alternative, adding `allowedDevOrigins` to `next.config`, would put a
 * test-only allowance in shipped configuration.
 */
const baseURL = `http://localhost:${PORT}`;

const devUrl = process.env.DATABASE_URL ?? "";
const e2eUrl = devUrl.replace(/\/[^/?]+(\?|$)/, "/sitesmith-studio-e2e$1");

// Reaches globalSetup, which runs in this process.
process.env.DATABASE_URL = e2eUrl;

export default defineConfig({
	testDir: "./e2e",
	globalSetup: "./e2e/global-setup.ts",

	/**
	 * Long enough for a journey to sit through a real crawl.
	 *
	 * Every crawl journey runs the product's own pacing — two requests at a time,
	 * five hundred milliseconds apart — over the shared fixture site, and that
	 * fixture grows by a few pages with each rule slice. The waits inside the
	 * journeys already allow sixty seconds; the default per-test cap of thirty cut
	 * them off before their own timeout could be reached, so the suite began
	 * failing on duration rather than on behaviour.
	 *
	 * The pacing is not shortened for tests: it is the guarantee the crawler
	 * exists to make, and a suite that ran without it would prove nothing about
	 * the load a client's site actually sees.
	 */
	timeout: 120_000,

	/**
	 * Serial by default. The journeys share one database and one seeded owner;
	 * running them in parallel would make them race on the project list. Speed is
	 * not the constraint at this suite size — a flaky suite that nobody trusts is.
	 */
	fullyParallel: false,
	workers: 1,

	// A retry locally hides flakiness rather than surfacing it.
	retries: 0,
	reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],

	use: {
		baseURL,
		// Kept on first retry and on failure — the trace is what makes a failed
		// journey diagnosable without re-running it by hand.
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},

	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],

	webServer: {
		/**
		 * `next dev` rather than a production build: the journeys assert on
		 * behaviour, not on bundle output, and dev starts in seconds instead of
		 * minutes.
		 */
		command: `npm run dev -- --port ${PORT}`,
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
		env: {
			...process.env,
			DATABASE_URL: e2eUrl,
			PORT: String(PORT),
		},
	},
});
