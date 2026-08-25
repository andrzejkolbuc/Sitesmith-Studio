import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test } from "@playwright/test";

import { E2E_ORPHAN } from "../global-setup";

/**
 * An account that authenticates but has no workspace.
 *
 * This state was found once by hand during implementation — a signed-in user
 * with no tenant hit an unhandled server error — fixed, and then left with no
 * automated guard. The risk is not that the fixed page regresses, though; it is
 * the next gated page, written by someone who never saw the original failure and
 * has no reason to think about a half-built identity. The invite flow on the
 * roadmap will make these accounts ordinary rather than exotic.
 *
 * So the routes are read off the filesystem rather than listed here. A page
 * added to the gated group is visited by this test the moment it exists, and has
 * to explain itself rather than crash.
 */

const GATED_ROOT = join(process.cwd(), "src", "app", "(app)");

/** A syntactically valid id for dynamic segments. */
const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

/**
 * Every gated route, derived from the files that define them.
 *
 * Route groups — the parenthesised directories — contribute no path segment,
 * and a dynamic segment is filled with a placeholder. Nothing is fetched with
 * it: the layout answers before the page runs, which is the property under test.
 */
function gatedRoutes(): string[] {
	const routes: string[] = [];

	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);

			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (entry.name !== "page.tsx") continue;

			const segments = relative(GATED_ROOT, dir)
				.split(sep)
				.filter((segment) => segment !== "" && segment !== ".")
				.filter((segment) => !segment.startsWith("("))
				.map((segment) => (segment.startsWith("[") ? PLACEHOLDER_ID : segment));

			routes.push(`/${segments.join("/")}`);
		}
	};

	walk(GATED_ROOT);
	return routes.sort();
}

async function signInAsOrphan(page: import("@playwright/test").Page) {
	await page.goto("/signin");
	await page.getByLabel("Email").fill(E2E_ORPHAN.email);
	await page.getByLabel("Password").fill(E2E_ORPHAN.password);
	await page.getByRole("button", { name: "Sign in" }).click();

	/**
	 * The notice itself is the proof the credentials were accepted. Waiting for
	 * the project list instead would hang, and waiting for a URL would pass even
	 * if the page rendered an error.
	 */
	await expect(
		page.getByRole("heading", { name: "This account has no workspace" }),
	).toBeVisible();
}

test("the gated group has routes to check", () => {
	/**
	 * Guards the derivation, not the app. If the route layout changes shape and
	 * the walk above silently finds nothing, every test below would pass by
	 * iterating over an empty list.
	 */
	const routes = gatedRoutes();
	expect(routes.length).toBeGreaterThan(0);
	expect(routes).toContain("/projects");
});

for (const route of gatedRoutes()) {
	test(`${route} explains itself to an account with no workspace`, async ({
		page,
	}) => {
		const serverErrors: string[] = [];
		page.on("response", (response) => {
			if (response.status() >= 500) {
				serverErrors.push(`${response.status()} ${response.url()}`);
			}
		});

		await signInAsOrphan(page);
		await page.goto(route);

		// Said plainly, and attributed to the account rather than to the page.
		await expect(
			page.getByRole("heading", { name: "This account has no workspace" }),
		).toBeVisible();
		await expect(page.getByText(E2E_ORPHAN.email)).toBeVisible();

		/**
		 * An explanation with no way forward is a dead end. Signing out is the one
		 * action that makes sense here, so it has to be present and real.
		 */
		await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();

		/**
		 * The original failure was a 500, and a 500 that renders a friendly body
		 * would satisfy every assertion above. Asserted separately so the failure
		 * reads as "the server errored" rather than "the text was missing".
		 */
		expect(serverErrors).toEqual([]);
	});
}

test("a partial account is not bounced back to sign in", async ({ page }) => {
	/**
	 * The tempting fix for this state is a redirect to /signin. It is the wrong
	 * one: the credentials were correct, so the user would be invited to enter
	 * them again forever, and would read the loop as a broken password.
	 */
	await signInAsOrphan(page);
	await page.goto("/projects");

	await expect(page).not.toHaveURL(/\/signin/);
});

test("signing out from the notice actually ends the session", async ({
	page,
}) => {
	await signInAsOrphan(page);
	await page.goto("/projects");
	await page.getByRole("button", { name: "Sign out" }).click();

	/**
	 * Wait for the sign-out to land before navigating again. Without this the
	 * next request can overtake the one clearing the cookie, and the test would
	 * report a broken sign-out that works perfectly for a real user.
	 */
	await page.waitForURL("/");

	/**
	 * Proven by what the session can no longer reach, rather than by landing on
	 * the marketing page — which an unauthenticated visitor sees too.
	 */
	await page.goto("/projects");
	await expect(page).toHaveURL(/\/signin/);
});
