import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Tests run against a real Postgres, not a mock.
 *
 * The property under test — that one tenant cannot read another's rows — lives in
 * the interaction between a procedure and a query. A mocked database would assert
 * that the code calls what we told it to call, which is not the same thing and
 * would keep passing if the scoping were removed.
 *
 * The database is a separate one inside the existing dev container rather than new
 * infrastructure. `test/global-setup.ts` creates it and applies the schema.
 */
// Node's own .env reader — avoids a dotenv dependency, and `vitest/config` does
// not re-export vite's loadEnv.
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
 * would then create tables in, and which the suite's per-test truncation would
 * empty. The guard in `test/global-setup.ts` catches that mistake; this line
 * prevents it.
 */
process.env.DATABASE_URL = testUrl;

export default defineConfig({
	resolve: {
		alias: {
			"~": fileURLToPath(new URL("./src", import.meta.url)),
			/**
			 * next-auth reaches `next/server` through Next's package exports map,
			 * which Vitest's resolver does not apply for this specifier. The test
			 * only imports auth transitively — via the tRPC context — so pointing at
			 * the real file is enough to let the module graph load.
			 */
			"next/server": fileURLToPath(
				new URL("./node_modules/next/server.js", import.meta.url),
			),
		},
	},
	test: {
		environment: "node",
		globalSetup: ["./test/global-setup.ts"],
		env: {
			...process.env,
			DATABASE_URL: testUrl,
			/**
			 * The application validates env at import time, so a value must exist.
			 * Generated rather than hardcoded: a literal here is credential-shaped
			 * and trips secret scanners, and the noise costs more than the line
			 * saves. Nothing in the suite signs or verifies a session with it.
			 */
			AUTH_SECRET: process.env.AUTH_SECRET || randomBytes(32).toString("hex"),
		},
		// Integration tests share one database; parallel files would race on truncation.
		fileParallelism: false,
		server: {
			deps: {
				/**
				 * Externalised dependencies bypass Vite's resolver, so the
				 * `next/server` alias above never reaches next-auth. Inlining puts
				 * these through the transform pipeline where the alias applies.
				 */
				inline: ["next-auth", "@auth/core", "@auth/drizzle-adapter"],
			},
		},
	},
});
