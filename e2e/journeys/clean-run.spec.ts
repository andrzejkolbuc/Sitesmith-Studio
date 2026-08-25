import { EXPECTED } from "../fixture-server";
import { expect, test } from "../fixtures";

/**
 * A clean result is an outcome, not an absence.
 *
 * The distinction matters more than it looks: an empty list and a failed run
 * look identical if the interface just renders nothing. A user who cannot tell
 * "your site is fine" from "the check broke" learns to distrust both.
 */

test("a site with nothing wrong says so, rather than showing an empty list", async ({
	signedIn,
	site,
	createProject,
}) => {
	/**
	 * A single monolingual page with no declared alternates and no locale in its
	 * URL. Every rule is designed to stay silent here — which makes it the right
	 * shape for proving the empty state, and a second guard on the narrowing.
	 */
	await createProject({
		startUrl: `${site.baseUrl}${EXPECTED.silentPath}`,
		locales: "",
	});

	await signedIn.getByRole("button", { name: "Run a check" }).click();
	await expect(signedIn.getByText("Complete")).toBeVisible({
		timeout: 60_000,
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
