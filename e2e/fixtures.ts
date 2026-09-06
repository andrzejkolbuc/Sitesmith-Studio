import { test as base, expect, type Page } from "@playwright/test";

import { type Fixture, startFixtureSite } from "../test/fixtures/site";
import { E2E_OWNER } from "./global-setup";

/**
 * Shared setup for the journeys.
 *
 * Sign-in happens through the real form rather than by injecting a session
 * cookie. Injecting would be faster and would decouple every journey from the
 * auth flow — which is exactly why it is the wrong call here: the flow would
 * then be untested by everything, and a break in it would surface as five
 * confusing failures instead of one clear one.
 */

type Fixtures = {
	/** A page already signed in as the seeded owner. */
	signedIn: Page;
	/** A crawlable site with known findings, stopped when the test ends. */
	site: Fixture;
	/**
	 * The same site publishing neither robots.txt nor a sitemap.
	 *
	 * What an ordinary small site looks like, and the only shape on which a run
	 * can honestly find nothing: the standard fixture's robots.txt disallows a
	 * path its own sitemap submits, which is a true finding on every crawl of it.
	 */
	plainSite: Fixture;
	/** Creates a project and lands on its detail page. Returns its name. */
	createProject: (options: {
		startUrl: string;
		locales?: string;
	}) => Promise<string>;
};

export const test = base.extend<Fixtures>({
	signedIn: async ({ page }, use) => {
		await page.goto("/signin");

		await page.getByLabel("Email").fill(E2E_OWNER.email);
		await page.getByLabel("Password").fill(E2E_OWNER.password);
		await page.getByRole("button", { name: "Sign in" }).click();

		// Landing on the project list is what proves the session took.
		await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

		await use(page);
	},

	// biome-ignore lint/correctness/noEmptyPattern: Playwright reads the destructuring pattern to work out which fixtures this one depends on; `{}` is how it spells "none", and `_` would change that meaning.
	site: async ({}, use) => {
		const fixture = await startFixtureSite();
		await use(fixture);
		await fixture.close();
	},

	// biome-ignore lint/correctness/noEmptyPattern: as above.
	plainSite: async ({}, use) => {
		const fixture = await startFixtureSite({ publishesSiteFiles: false });
		await use(fixture);
		await fixture.close();
	},

	createProject: async ({ signedIn }, use) => {
		await use(async ({ startUrl, locales = "en, de, fr" }) => {
			/**
			 * A timestamped name so a re-run never collides with rows a previous
			 * run left behind, and so a failure names which run created it.
			 */
			const name = `Journey ${Date.now()}`;

			await signedIn.goto("/projects/new");
			await signedIn.getByLabel("Name").fill(name);
			await signedIn.getByLabel("Start URL").fill(startUrl);
			await signedIn.getByLabel("Expected locales").fill(locales);
			await signedIn.getByRole("button", { name: "Create project" }).click();

			// The detail page is the redirect target; its heading is the project name.
			await expect(signedIn.getByRole("heading", { name })).toBeVisible();

			return name;
		});
	},
});

export { expect };

/**
 * How long a run may take before a journey gives up on it.
 *
 * A crawl of the fixture site is seconds. What dominates now is the render pass:
 * up to twelve pages, each costing a browser launch, a settle window, a scroll
 * sweep and a full-page encode. That ceiling is bounded and stateable in advance
 * — which is exactly why the sample is capped absolutely — so the budget here is
 * that ceiling rather than a number raised until the suite stopped failing.
 *
 * Waits still key on state; this is only the point at which a run that is not
 * going to finish stops holding the suite up.
 */
export const RUN_TIMEOUT_MS = 180_000;
