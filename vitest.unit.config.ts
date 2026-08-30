import { randomBytes } from "node:crypto";
import { configDefaults, defineConfig } from "vitest/config";

import { inlineDeps, resolve } from "./vitest.shared";

/**
 * Tests that need nothing running.
 *
 * No database, no dev server, no browsers — `npm run test:unit` works on a clone
 * with only `npm install` behind it. That matters more than speed: a contributor
 * who cannot start Docker should still get a real signal rather than a wall of
 * connection errors.
 *
 * These tests do start a local HTTP fixture inside the test process, which is
 * not "unit" in the purist sense. The line drawn here is *what must already be
 * running*, and a server the test starts and stops itself needs nothing.
 *
 * Deliberately no `globalSetup`: the moment this config touches the database
 * setup, the guarantee above is gone.
 */
export default defineConfig({
	resolve,
	test: {
		environment: "node",
		include: [
			"src/server/crawl/crawler.test.ts",
			"src/server/crawl/findings.test.ts",
			"src/server/crawl/site-shapes.test.ts",
			"src/server/crawl/politeness.test.ts",
			"src/server/auth/**/*.test.ts",
			// The guard on the reset helper. Contacts no database: the connection is
			// lazy and every case is refused before a query is issued.
			"test/**/*.test.ts",
			// Presentation logic that is pure enough to test without a browser.
			"src/app/**/*.test.ts",
		],
		/**
		 * The escape hatch for the include above: an auth test that needs a real
		 * database names itself `*.integration.test.ts` and is picked up by the
		 * other config instead. Without this, adding one database-backed test under
		 * `src/server/auth/` would silently cost this bucket its no-dependencies
		 * guarantee.
		 */
		exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
		env: {
			...process.env,
			// The app validates env at import time; nothing here signs anything.
			AUTH_SECRET: process.env.AUTH_SECRET || randomBytes(32).toString("hex"),
			// Present so env validation passes; no test in this bucket connects.
			DATABASE_URL:
				process.env.DATABASE_URL ?? "postgresql://unused@localhost:5432/unused",
		},
		server: { deps: { inline: inlineDeps } },
	},
});
