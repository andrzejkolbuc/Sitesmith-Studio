/**
 * Creates or updates a project's crawl configuration.
 *
 * The create form covers name, start URL and locales. Everything else — crawl
 * scope and the politeness dials — lives here rather than in a form, because
 * forms are addable later without rework and the slice they would have competed
 * with is the crawl itself.
 *
 *   npm run db:seed-project -- --tenant "Kolbuc Studio" --name "Acme" \
 *     --start-url https://acme.example --locales en,de,fr \
 *     --exclude /private,/admin --concurrency 2 --delay 500
 *
 * Idempotent on (tenant, name): re-running updates rather than duplicating.
 *
 * Opens its own database connection rather than importing ~/server/db, which
 * resolves the ~/env path alias that plain Node does not read.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { projects, tenants } from "../src/server/db/schema.ts";

const schema = { projects, tenants };

function readOption(flag: string): string | undefined {
	const index = process.argv.indexOf(`--${flag}`);
	if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
	return undefined;
}

function fail(message: string): never {
	console.error(`seed-project: ${message}`);
	process.exit(1);
}

const list = (value: string | undefined): string[] =>
	value
		? value
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean)
		: [];

const tenantName = readOption("tenant");
const name = readOption("name");
const startUrl = readOption("start-url");

if (!tenantName) fail("missing --tenant");
if (!name) fail("missing --name");
if (!startUrl) fail("missing --start-url");

try {
	new URL(startUrl);
} catch {
	fail(`--start-url is not a valid absolute URL: ${startUrl}`);
}

const locales = list(readOption("locales")).map((l) => l.toLowerCase());
const includePaths = list(readOption("include"));
const excludePaths = list(readOption("exclude"));

const maxConcurrency = Number.parseInt(readOption("concurrency") ?? "2", 10);
const requestDelayMs = Number.parseInt(readOption("delay") ?? "500", 10);

if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
	fail("--concurrency must be a positive integer");
}
if (!Number.isSafeInteger(requestDelayMs) || requestDelayMs < 0) {
	fail("--delay must be a non-negative integer");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail("DATABASE_URL is not set — run with --env-file=.env");

const connection = postgres(databaseUrl, { max: 1 });
const db = drizzle(connection, { schema });

try {
	const tenant = await db.query.tenants.findFirst({
		where: eq(tenants.name, tenantName),
	});
	if (!tenant)
		fail(`no tenant named "${tenantName}" — run db:seed-owner first`);

	const config = {
		startUrl,
		locales,
		includePaths,
		excludePaths,
		maxConcurrency,
		requestDelayMs,
	};

	const existing = await db.query.projects.findFirst({
		where: and(eq(projects.tenantId, tenant.id), eq(projects.name, name)),
	});

	if (existing) {
		await db.update(projects).set(config).where(eq(projects.id, existing.id));
		console.log(`seed-project: updated "${name}" (${existing.id})`);
	} else {
		const [created] = await db
			.insert(projects)
			.values({ tenantId: tenant.id, name, ...config })
			.returning();
		console.log(`seed-project: created "${name}" (${created?.id})`);
	}

	console.log(
		`  start ${startUrl} | locales [${locales.join(", ") || "none"}] | concurrency ${maxConcurrency} | delay ${requestDelayMs}ms`,
	);
} finally {
	await connection.end();
}
