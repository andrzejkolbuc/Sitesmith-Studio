import { EXPECTED } from "../fixture-server";
import { expect, RUN_TIMEOUT_MS, test } from "../fixtures";

/**
 * The journey S-08 exists for: say what the site should look like, then be told
 * when it stops looking like that.
 *
 * Every assertion is on a role or a visible string, never on markup, and every
 * wait is on state. The one thing worth stating about the *shape* of these
 * cases: they wait for the appearance section itself rather than for a run
 * status, because the section is what settles last. `lessons.md` rule 3 is the
 * entry about asserting on a state that exists for a few hundred milliseconds,
 * and a panel that renders as its query resolves is exactly that trap.
 */

test("a project with no baseline is told it needs one, not that it is clean", async ({
	signedIn,
	site,
	createProject,
}) => {
	await createProject({ startUrl: `${site.baseUrl}${EXPECTED.silentPath}` });

	await signedIn.getByRole("button", { name: "Run a check" }).click();
	await expect(signedIn.getByText("Complete", { exact: true })).toBeVisible({
		timeout: RUN_TIMEOUT_MS,
	});

	/**
	 * The state this section spends most of its life in. It must read as an
	 * instruction rather than as a verdict — a project nobody has told what the
	 * site should look like has not been found clean.
	 */
	await expect(
		signedIn.getByRole("heading", { name: "Appearance" }),
	).toBeVisible();
	await expect(
		signedIn.getByText("No baseline is pinned", { exact: false }),
	).toBeVisible();
	await expect(
		signedIn.getByRole("button", { name: "Pin this run as the baseline" }),
	).toBeVisible();
});

test("pinning a baseline makes the next run report against it", async ({
	signedIn,
	site,
	createProject,
}) => {
	await createProject({ startUrl: `${site.baseUrl}${EXPECTED.silentPath}` });

	await signedIn.getByRole("button", { name: "Run a check" }).click();
	await expect(signedIn.getByText("Complete", { exact: true })).toBeVisible({
		timeout: RUN_TIMEOUT_MS,
	});

	await signedIn
		.getByRole("button", { name: "Pin this run as the baseline" })
		.click();

	/**
	 * The instruction is gone, which is the fact worth asserting: the section has
	 * left the state it was in. Waiting for this rather than for the button's own
	 * disappearance keeps the assertion on what the reader is told.
	 */
	await expect(
		signedIn.getByText("No baseline is pinned", { exact: false }),
	).toHaveCount(0);

	await signedIn.getByRole("button", { name: "Run a check" }).click();
	await expect(signedIn.getByText("Complete", { exact: true })).toBeVisible({
		timeout: RUN_TIMEOUT_MS,
	});

	/**
	 * The coverage sentence, which is the section's contract: it says how much of
	 * the site it describes rather than letting a quiet list imply the whole one.
	 */
	await expect(
		signedIn.getByText("compared against the baseline", { exact: false }),
	).toBeVisible({ timeout: RUN_TIMEOUT_MS });

	/**
	 * Nothing was deployed between the two runs, so the honest answer is that the
	 * pages still match. This is the property the whole slice turns on — if our
	 * own rendering were the noise source, this is where it would show.
	 */
	await expect(
		signedIn.getByText("matches the baseline").first(),
	).toBeVisible();
});
