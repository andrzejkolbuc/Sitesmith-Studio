import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { runs } from "../../src/server/db/schema";
import { expect, RUN_TIMEOUT_MS, test } from "../fixtures";

/**
 * Marks a stored run as having stopped at the page ceiling.
 *
 * Written rather than crawled, and that is the honest option here. The ceiling
 * is two thousand pages and the fixture site has a dozen, so the only ways to
 * reach it for real are to lower the limit — which would put a test-only env var
 * into shipped configuration, a boundary this slice explicitly held — or to serve
 * two thousand fixture pages, which buys the same assertion for minutes of suite
 * time. What is fabricated is exactly the flag the crawler would have set; every
 * other thing under test, from the procedure call to the printed sentence, is the
 * real path.
 */
async function markStoppedAtPageLimit(runId: string): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error("DATABASE_URL is not set for the journey.");

	const connection = postgres(databaseUrl, { max: 1 });
	try {
		await drizzle(connection, { schema: { runs } })
			.update(runs)
			.set({ reachedPageLimit: true, crawlComplete: false })
			.where(eq(runs.id, runId));
	} finally {
		await connection.end();
	}
}

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

test("a truncated run's report says the site is larger than what it describes", async ({
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

	const runId = signedIn.url().split("/report/")[1];
	expect(runId).toBeTruthy();
	await markStoppedAtPageLimit(runId as string);

	await signedIn.reload();
	await expect(
		signedIn.getByRole("heading", { name: "What this check covered" }),
	).toBeVisible();

	/*
	 * The sentence the slice exists to produce. A partial pass silences rules
	 * across two dozen gates, so it reports *fewer* problems than a full one — and
	 * a client reading a short report without this sentence concludes their site is
	 * healthy. Asserted on the words rather than on a container, because which
	 * element carries them is not what the reader depends on.
	 */
	const prose = await signedIn.locator("main").innerText();
	expect(prose).toContain("larger than what is described here");
	expect(prose).toContain("fewer problems");

	/* And still in the register: no ceiling, no page limit, no crawl vocabulary. */
	expect(prose).not.toMatch(/page limit|ceiling|crawl/i);
});

test("a run cannot be reported under another project's name", async ({
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
	const runId = signedIn.url().split("/report/")[1];

	/*
	 * A second project of the reader's own, so this is not a tenancy test. The
	 * procedures already refuse another tenant's run; what they cannot see is that
	 * the id pair in the URL names two things that have nothing to do with each
	 * other. Rendered, that is a document headed with one client's name and start
	 * URL describing a different client's site — the report making a confident
	 * claim about the wrong site, which is the failure this route has to prevent
	 * on its own.
	 */
	await createProject({ startUrl: site.baseUrl, locales: "" });
	await signedIn.waitForURL(/\/projects\/[0-9a-f-]+$/);
	const otherProjectId = signedIn.url().split("/projects/")[1];

	const response = await signedIn.goto(
		`/projects/${otherProjectId}/report/${runId}`,
	);
	expect(response?.status()).toBe(404);
});
