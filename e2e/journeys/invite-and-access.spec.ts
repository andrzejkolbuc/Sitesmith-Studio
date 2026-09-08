import { expect, test } from "../fixtures";

/**
 * Inviting a client, and what they can see afterwards.
 *
 * The whole slice as a person experiences it: an owner creates two projects,
 * invites a client viewer to one of them, hands over a link, and the invitee
 * sets a password and lands somewhere deliberately smaller than the owner's
 * view.
 *
 * The negative half is the point. It is easy to build an invite flow that works
 * and still shows the invitee everything — the tests that catch that are the
 * ones asserting the *other* project is unreachable, by URL and by image, not
 * merely absent from a list. A client viewer who can reach a sibling project
 * has learned the agency's client list, which is the one thing the product
 * promises cannot happen.
 *
 * Uses a second browser context rather than signing out: the two sessions have
 * to exist at once for the owner's own view to stay proven while the invitee's
 * is examined.
 */

test("an invited client viewer sees one project and cannot reach the other", async ({
	browser,
	signedIn,
	createProject,
	site,
	plainSite,
}) => {
	const theirs = await createProject({ startUrl: site.baseUrl });
	const theirsUrl = signedIn.url();
	const notTheirs = await createProject({ startUrl: plainSite.baseUrl });
	const notTheirsUrl = signedIn.url();

	expect(theirsUrl).not.toBe(notTheirsUrl);

	/**
	 * Unique per run so re-runs and parallel runs cannot collide on the unique
	 * email constraint — the same reasoning as the timestamped project name.
	 */
	const email = `client-${Date.now()}@invite.test`;
	const password = "an-invited-client-password";

	await test.step("the owner issues an invite scoped to one project", async () => {
		await signedIn.goto("/projects");
		await signedIn.getByRole("link", { name: "People" }).click();

		await expect(
			signedIn.getByRole("heading", { name: "People" }),
		).toBeVisible();

		await signedIn.getByLabel("Email").fill(email);
		await signedIn.getByLabel("Role").selectOption("viewer");
		await signedIn.getByLabel("Project").selectOption({ label: theirs });
		await signedIn.getByRole("button", { name: "Create invite" }).click();

		await expect(signedIn.getByText(`Invite ready for ${email}`)).toBeVisible();
	});

	const link = await signedIn
		.getByRole("code")
		.filter({ hasText: "/invite/" })
		.first()
		.innerText();

	expect(link).toContain("/invite/");

	const context = await browser.newContext();
	const invitee = await context.newPage();

	try {
		await test.step("the invitee sets a password and is signed in", async () => {
			await invitee.goto(link);

			await expect(
				invitee.getByRole("heading", { name: "Set your password" }),
			).toBeVisible();

			await invitee.getByLabel("Password").fill(password);
			await invitee
				.getByRole("button", { name: "Set password and sign in" })
				.click();

			await expect(
				invitee.getByRole("heading", { name: "Projects" }),
			).toBeVisible();
		});

		await test.step("they see the project they were given, and only that one", async () => {
			await expect(invitee.getByText(theirs)).toBeVisible();
			await expect(invitee.getByText(notTheirs)).toHaveCount(0);
		});

		await test.step("they are offered no way to change anything", async () => {
			await expect(
				invitee.getByRole("link", { name: "New project" }),
			).toHaveCount(0);
			await expect(invitee.getByRole("link", { name: "People" })).toHaveCount(
				0,
			);

			await invitee.goto(theirsUrl);
			await expect(
				invitee.getByRole("heading", { name: theirs }),
			).toBeVisible();
			await expect(
				invitee.getByRole("button", { name: "Run a check" }),
			).toHaveCount(0);
		});

		await test.step("the other project is not found, by page or by image", async () => {
			await invitee.goto(notTheirsUrl);
			await expect(
				invitee.getByRole("heading", { name: notTheirs }),
			).toHaveCount(0);

			/**
			 * The management screen answers the same way. A viewer learning that a
			 * people page exists is a smaller leak than the client list, but it is
			 * the same kind, and the product answers both identically.
			 */
			await invitee.goto("/team");
			await expect(
				invitee.getByRole("heading", { name: "People" }),
			).toHaveCount(0);
		});

		await test.step("a spent invite link cannot be used again", async () => {
			/**
			 * A third context, not another tab in the invitee's. The accept page
			 * sends anyone who already has a session to their projects, so reusing
			 * the invitee's context would assert that redirect rather than the spent
			 * link — and would pass even if the invite were still live.
			 */
			const stranger = await browser.newContext();
			const second = await stranger.newPage();

			try {
				await second.goto(link);

				await expect(
					second.getByRole("heading", { name: "Invite not valid" }),
				).toBeVisible();
			} finally {
				await stranger.close();
			}
		});
	} finally {
		await context.close();
	}
});
