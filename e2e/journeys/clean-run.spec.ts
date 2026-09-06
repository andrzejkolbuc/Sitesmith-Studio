import { EXPECTED } from "../fixture-server";
import { expect, RUN_TIMEOUT_MS, test } from "../fixtures";

/**
 * A clean result is an outcome, not an absence.
 *
 * The distinction matters more than it looks: an empty list and a failed run
 * look identical if the interface just renders nothing. A user who cannot tell
 * "your site is fine" from "the check broke" learns to distrust both.
 */

test("a site with nothing wrong says so, rather than showing an empty list", async ({
	signedIn,
	plainSite,
	createProject,
}) => {
	/**
	 * A single monolingual page with no declared alternates and no locale in its
	 * URL, on a site publishing neither robots.txt nor a sitemap. Every rule is
	 * designed to stay silent here — which makes it the right shape for proving
	 * the empty state, and a second guard on the narrowing.
	 *
	 * The site files are what the plain fixture drops: the standard one disallows
	 * a path its own sitemap submits, and that contradiction is a true finding on
	 * every crawl of it, whichever page the run starts from.
	 */
	await createProject({
		startUrl: `${plainSite.baseUrl}${EXPECTED.silentPath}`,
		locales: "",
	});

	await signedIn.getByRole("button", { name: "Run a check" }).click();
	await expect(signedIn.getByText("Complete", { exact: true })).toBeVisible({
		timeout: RUN_TIMEOUT_MS,
	});

	// Stated as an outcome...
	await expect(signedIn.getByText("Nothing found")).toBeVisible();
	// ...with the reason, so it cannot be mistaken for a failure.
	await expect(
		signedIn.getByText("published the locales this project expects"),
	).toBeVisible();
});

test("a project with no expected locales says nothing can be reported missing", async ({
	signedIn,
	site,
	createProject,
}) => {
	await createProject({
		startUrl: `${site.baseUrl}${EXPECTED.silentPath}`,
		locales: "",
	});

	/**
	 * Without a declared expectation there is nothing for a variant to be missing
	 * from. Saying so plainly beats showing an empty field the user has to
	 * interpret.
	 */
	await expect(
		signedIn.getByText("nothing can be reported missing"),
	).toBeVisible();
});

test("a path excluded on the form is recorded on the project", async ({
	signedIn,
	site,
}) => {
	/**
	 * The form is where an operator protects a client's admin area, and a field
	 * that silently fails to save would be worse than not offering one: they would
	 * believe a path was off limits and start a run against it.
	 */
	const name = `Journey ${Date.now()}`;

	await signedIn.goto("/projects/new");
	await signedIn.getByLabel("Name").fill(name);
	await signedIn.getByLabel("Start URL").fill(site.baseUrl);
	await signedIn.getByLabel("Exclude paths").fill("/admin, /cart");
	await signedIn.getByRole("button", { name: "Create project" }).click();

	await expect(signedIn.getByRole("heading", { name })).toBeVisible();

	// Shown back on the project, so the scope can be checked before a run starts.
	await expect(signedIn.getByText("/admin, /cart")).toBeVisible();
});
