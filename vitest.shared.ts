import { fileURLToPath } from "node:url";

/**
 * Configuration every vitest bucket shares.
 *
 * The buckets differ in one thing only: what has to be running before they can
 * work. Resolution, aliasing and dependency inlining are identical, so they live
 * here rather than being copied and drifting apart.
 */

export const resolve = {
	alias: {
		"~": fileURLToPath(new URL("./src", import.meta.url)),
		/**
		 * next-auth reaches `next/server` through Next's package exports map, which
		 * Vitest's resolver does not apply for this specifier. Pointing at the real
		 * file lets the module graph load.
		 */
		"next/server": fileURLToPath(
			new URL("./node_modules/next/server.js", import.meta.url),
		),
	},
};

/**
 * Externalised dependencies bypass Vite's resolver, so the `next/server` alias
 * above never reaches next-auth. Inlining puts them through the transform
 * pipeline where the alias applies.
 */
export const inlineDeps = ["next-auth", "@auth/core", "@auth/drizzle-adapter"];
