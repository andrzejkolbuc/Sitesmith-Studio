import { randomBytes } from "node:crypto";
import { defineConfig } from "vitest/config";

import { inlineDeps, resolve } from "./vitest.shared";

/**
 * Tests that need a real Postgres.
 *
 * Against a real database rather than a mock, because the properties under test
 * — that one tenant cannot read another's rows, that a run persists what it
 * found — live in the interaction between a query and a schema. A mock would
 * assert that the code calls what we told it to call, which is not the same
 * thing and would keep passing if the scoping were deleted.
 */

// Node's own .env reader — vitest/config does not re-export vite's loadEnv.
try {
	process.loadEnvFile(".env");
} catch {
	// Absent .env is fine when the values already come from the environment.
}

const devUrl = process.env.DATABASE_URL ?? "";
const testUrl = devUrl.replace(/\/[^/?]+(\?|$)/, "/sitesmith-studio-test$1");

/**
 * Redirect this process too, not just the test workers.
 *
 * `test.env` below reaches the workers; `globalSetup` runs here in the main
 * process and would otherwise still see the development database — which it
 * would create tables in, and which the suite's truncation would empty. The
 * guard in `test/global-setup.ts` catches that mistake; this line prevents it.
 */
process.env.DATABASE_URL = testUrl;

export default defineConfig({
	resolve,
	test: {
		environment: "node",
		include: [
			"src/server/api/**/*.test.ts",
			"src/server/crawl/run.test.ts",
			// Tests that live beside unit tests but need Postgres. See the exclude
			// in vitest.unit.config.ts.
			"src/server/**/*.integration.test.ts",
		],
		globalSetup: ["./test/global-setup.ts"],
		env: {
			...process.env,
			DATABASE_URL: testUrl,
			AUTH_SECRET: process.env.AUTH_SECRET || randomBytes(32).toString("hex"),
		},
		// These tests share one database; parallel files would race on truncation.
		fileParallelism: false,
		server: { deps: { inline: inlineDeps } },
	},
});
