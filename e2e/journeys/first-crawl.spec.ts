import { EXPECTED } from "../fixture-server";
import { expect, test } from "../fixtures";

/**
 * The journey the product exists for.
 *
 * Sign in, define a multilingual project, run a check, and read a finding you
 * could act on. Every assertion is about what a user can see or do — a role, a
 * visible string — never about markup. A test coupled to class names breaks on
 * restyle and catches nothing, which is the failure mode this risk names.
 *
 * Waits are on state, never on elapsed time: a crawl that takes longer on a
 * slower machine must not fail the suite, and a sleep long enough to be safe is
 * long enough to be useless.
 */

test("an owner crawls a multilingual site and reads a real finding", async ({
	signedIn,
	site,
	createProject,
}) => {
	await createProject({ startUrl: site.baseUrl });

	await signedIn.getByRole("button", { name: "Run a check" }).click();

	/**
	 * Progress must appear without a reload. This is the one criterion no other
	 * tool in this project could verify — the in-app browser pane never
	 * composites, so its polling never runs. A real browser settles it.
	 */
	await expect(signedIn.getByText("Crawling")).toBeVisible();

	// Completion, on the same page, still without a reload.
	await expect(signedIn.getByText("Complete")).toBeVisible({
		timeout: 60_000,
	});

	// The fixture declares a German page that 404s.
	await expect(
		signedIn.getByRole("heading", { name: EXPECTED.brokenVariant.heading }),
	).toBeVisible();

	// Families publishing en and de, where the project also expects fr.
	await expect(
		signedIn.getByRole("heading", { name: EXPECTED.missingLocale.heading }),
	).toBeVisible();

	// A locale-shaped URL declaring no alternates at all.
	await expect(
		signedIn.getByRole("heading", { name: EXPECTED.noAlternates.heading }),
	).toBeVisible();

	/**
	 * The negative assertion, and the most valuable one here.
	 *
	 * A page with no hreflang and no locale in its URL is an ordinary
	 * single-language page. Rule 4 was narrowed specifically so it stays silent;
	 * if this ever fails, the narrowing has regressed and the first screen a user
	 * sees becomes mostly noise.
	 */
	await expect(signedIn.getByText(EXPECTED.silentPath)).toHaveCount(0);
});

test("a finding says which locale is missing, not just that something is wrong", async ({
	signedIn,
	site,
	createProject,
}) => {
	await createProject({ startUrl: site.baseUrl });

	await signedIn.getByRole("button", { name: "Run a check" }).click();
	await expect(signedIn.getByText("Complete")).toBeVisible({
		timeout: 60_000,
	});

	/**
	 * A finding has to be actionable without opening the database. That means
	 * naming the locale and the page, not just the category — so this asserts the
	 * evidence line, which is the part a user actually works from.
	 */
	await expect(
		signedIn.getByText(`No ${EXPECTED.missingLocale.locale} version`).first(),
	).toBeVisible();
});

test("a second check cannot start while one is running", async ({
	signedIn,
	site,
	createProject,
}) => {
	await createProject({ startUrl: site.baseUrl });

	const runButton = signedIn.getByRole("button", { name: "Run a check" });
	await runButton.click();

	/**
	 * Clicking twice is an ordinary thing to do, not a fault. The interface
	 * disables the control rather than letting a second run start and then
	 * explaining the conflict.
	 */
	await expect(
		signedIn.getByRole("button", { name: "Check in progress" }),
	).toBeDisabled();
});
