import { expect, RUN_TIMEOUT_MS, test } from "../fixtures";

/**
 * The one view meant to leave the building.
 *
 * Everything else in this product is read by the person who runs the checks. A
 * report is read by their client, who did not ask for it, cannot click it, and
 * has no way to tell a thin result from a healthy site. Two things therefore
 * have to hold, and neither is visible from a unit test: the document says what
 * the check covered before it says what it found, and it says all of it in
 * words the reader can act on.
 */

test("a report states what the check covered before what it found", async ({
	signedIn,
	site,
	createProject,
}) => {
	await createProject({ startUrl: site.baseUrl, locales: "" });

	await signedIn.getByRole("button", { name: "Run a check" }).click();
	await expect(signedIn.getByText("Complete", { exact: true })).toBeVisible({
		timeout: RUN_TIMEOUT_MS,
	});

	await signedIn.getByRole("link", { name: "Client report" }).click();
	await signedIn.waitForURL(/\/report\/[0-9a-f-]+$/);

	/*
	 * Order is the assertion, not merely presence. A coverage statement below the
	 * findings is a footnote, and the reader this document is for reaches its
	 * conclusion long before a footnote.
	 */
	const covered = signedIn.getByRole("heading", {
		name: "What this check covered",
	});
	const found = signedIn.getByRole("heading", { name: "What we found" });

	await expect(covered).toBeVisible();
	await expect(found).toBeVisible();

	const order = await covered.evaluate(
		(node, other) =>
			node.compareDocumentPosition(other as Node) &
			Node.DOCUMENT_POSITION_FOLLOWING,
		await found.elementHandle(),
	);
	expect(order).toBeGreaterThan(0);
});

test("a report carries no operator controls or crawl configuration", async ({
	signedIn,
	site,
	createProject,
}) => {
	await createProject({ startUrl: site.baseUrl, locales: "" });

	await signedIn.getByRole("button", { name: "Run a check" }).click();
	await expect(signedIn.getByText("Complete", { exact: true })).toBeVisible({
		timeout: RUN_TIMEOUT_MS,
	});

	await signedIn.getByRole("link", { name: "Client report" }).click();
	await signedIn.waitForURL(/\/report\/[0-9a-f-]+$/);

	/*
	 * A control on a printed page is a dead affordance, and the pacing a crawl
	 * ran under is our business rather than the client's.
	 */
	await expect(
		signedIn.getByRole("button", { name: "Run a check" }),
	).toHaveCount(0);
	await expect(
		signedIn.getByRole("heading", { name: "Run history" }),
	).toHaveCount(0);
	await expect(signedIn.getByText("Request pacing")).toHaveCount(0);
});

test("a report speaks to someone who does not read status codes", async ({
	signedIn,
	site,
	createProject,
}) => {
	await createProject({ startUrl: site.baseUrl, locales: "" });

	await signedIn.getByRole("button", { name: "Run a check" }).click();
	await expect(signedIn.getByText("Complete", { exact: true })).toBeVisible({
		timeout: RUN_TIMEOUT_MS,
	});

	await signedIn.getByRole("link", { name: "Client report" }).click();
	await signedIn.waitForURL(/\/report\/[0-9a-f-]+$/);
	await expect(
		signedIn.getByRole("heading", { name: "What we found" }),
	).toBeVisible();

	/*
	 * The register guarded end to end rather than per string. The unit tests hold
	 * the vocabulary itself; this holds everything the page assembles around it,
	 * which is where an operator component reused by mistake would show up.
	 *
	 * Addresses are stripped before matching, and that is a rule about whose words
	 * these are rather than a convenience. The client's own URLs are their data —
	 * this fixture publishes `/meta/no-canonical`, and a real site may name a page
	 * anything at all. We print those verbatim because changing them would be
	 * inventing evidence; the register is a promise about the sentences we write,
	 * not about the site we are describing.
	 */
	const prose = (await signedIn.locator("main").innerText()).replace(
		/https?:\/\/\S+/g,
		"",
	);

	expect(prose).not.toMatch(/hreflang/i);
	expect(prose).not.toMatch(/canonical/i);
	expect(prose).not.toMatch(/robots\.txt/i);
	expect(prose).not.toMatch(/x-robots-tag|strict-transport-security/i);
	expect(prose).not.toMatch(/\b(ttfb|lcp|cls)\b/i);
	expect(prose).not.toMatch(/\breturns?\s+\d{3}\b/i);
});
