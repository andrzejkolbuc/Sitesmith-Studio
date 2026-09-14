/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
	/**
	 * Emit a self-contained server under `.next/standalone`, so the container's
	 * final stage carries no dependency install of its own. Only what
	 * `@vercel/nft` traces from Next's entry points lands there — anything Next
	 * never imports must be copied explicitly by the Dockerfile.
	 */
	output: "standalone",

	/**
	 * Playwright's own files, which the trace cannot find.
	 *
	 * `@vercel/nft` analyses `import`, `require` and `fs` usage, and playwright
	 * resolves its browser registry through constructed filesystem paths — the
	 * pattern nft handles worst. The first standalone build traced
	 * `playwright-core/lib` but not `playwright-core/browsers.json`, and the
	 * container failed at `chromium.launch()` with MODULE_NOT_FOUND on a file
	 * nothing imports by name.
	 *
	 * Included as whole package trees rather than as the one file that happened to
	 * be missing: the registry reads several paths this way, and a list that only
	 * names the ones we have tripped over so far would break again on the next
	 * playwright upgrade, at deploy time, as a browser that silently does not
	 * launch. The browser binaries themselves are not here — they live in the
	 * Playwright base image at /ms-playwright — so this adds megabytes, not
	 * gigabytes.
	 */
	outputFileTracingIncludes: {
		"/*": ["node_modules/playwright/**/*", "node_modules/playwright-core/**/*"],
	},
};

export default config;
