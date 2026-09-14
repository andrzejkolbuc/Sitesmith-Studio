/**
 * Start, stop and inspect the development database from any shell.
 *
 * `start-database.sh` only runs in a POSIX shell, so on Windows it silently does
 * nothing in PowerShell — which looks exactly like a database that failed to
 * start. This wraps the same job in Node, which every shell can run, and calls
 * the Docker binary by absolute path rather than relying on it being on PATH
 * (it often is not in a shell opened before Docker was installed).
 *
 *   npm run db:start    bring the database up
 *   npm run db:stop     stop it, keeping the data
 *   npm run db:status   what is actually running
 *
 * `compose.yaml` is now the definition — this file no longer hand-rolls a
 * `docker run` argument list, it drives `docker compose` against the `postgres`
 * service. The commands stay because they are the interface people have learned
 * and because they carry the diagnostics a bare compose invocation does not: the
 * binary discovery above, the engine-down hint below, and the agreement check
 * between DATABASE_URL and the POSTGRES_* variables compose reads.
 *
 * The data lives in the `postgres-data` volume, so stopping is not destructive.
 * Removing the volume is not something this script does.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** The service in `compose.yaml`, not a container name. */
const SERVICE = "postgres";

/** Docker's own bin directory, then whatever PATH offers. */
const CANDIDATES = [
	"C:/Program Files/Docker/Docker/resources/bin/docker.exe",
	"/usr/local/bin/docker",
	"/usr/bin/docker",
];

function dockerBinary() {
	for (const candidate of CANDIDATES) {
		if (existsSync(candidate)) return candidate;
	}
	return "docker";
}

const docker = dockerBinary();

function run(args, { quiet = false } = {}) {
	return execFileSync(docker, args, {
		encoding: "utf8",
		stdio: quiet ? "pipe" : ["pipe", "pipe", "pipe"],
	}).trim();
}

/** `docker compose` is a subcommand, so every invocation shares this prefix. */
function compose(args, options) {
	return run(["compose", ...args], options);
}

function fail(message, hint) {
	console.error(`db: ${message}`);
	if (hint) console.error(`    ${hint}`);
	process.exit(1);
}

function requireEngine() {
	try {
		run(["info", "--format", "{{.ServerVersion}}"], { quiet: true });
	} catch {
		fail(
			"the Docker engine is not running.",
			"Start Docker Desktop and wait for the whale icon to settle, then retry.",
		);
	}
}

/** Reads the environment without importing the app's env module, which uses a path alias. */
function loadEnv() {
	try {
		process.loadEnvFile(".env");
	} catch {
		// Absent .env is fine: `compose.yaml` defaults every variable it reads.
	}
}

function databaseSettings() {
	const url = process.env.DATABASE_URL;
	if (!url) fail("DATABASE_URL is not set.", "Expected it in .env");

	const parsed = new URL(url);
	return {
		user: decodeURIComponent(parsed.username),
		password: decodeURIComponent(parsed.password),
		port: parsed.port || "5432",
		database: parsed.pathname.slice(1),
	};
}

/**
 * The connection is stated twice — once as a URL the app reads, once as the
 * discrete POSTGRES_* variables compose reads — because compose substitutes
 * whole values and cannot take a URL apart.
 *
 * Two representations of one thing are two things that can drift, and the
 * failure when they do is confusing rather than obvious: the database starts
 * perfectly well with the credentials compose was given, and the app is refused
 * by the credentials it was given. Checking here turns that into a sentence.
 *
 * Only variables actually present are compared. `.env` is allowed to say nothing
 * and let compose's defaults stand; what it may not do is disagree.
 */
function checkAgreement({ user, password, port, database }) {
	const expected = [
		["POSTGRES_USER", user],
		["POSTGRES_PASSWORD", password],
		["POSTGRES_DB", database],
		["POSTGRES_PORT", port],
	];

	const disagreements = expected.filter(
		([name, fromUrl]) =>
			process.env[name] !== undefined && process.env[name] !== fromUrl,
	);

	if (disagreements.length === 0) return;

	console.error("db: DATABASE_URL and the POSTGRES_* variables disagree.");
	for (const [name, fromUrl] of disagreements) {
		console.error(
			`    ${name} is "${process.env[name]}"; DATABASE_URL says "${fromUrl}".`,
		);
	}
	console.error(
		"    They describe the same database. Compose would start one the app cannot reach.",
	);
	process.exit(1);
}

/** What compose reports for the service: "running", "exited", or nothing at all. */
function serviceState() {
	const out = compose(["ps", "-a", "--format", "{{.State}}", SERVICE], {
		quiet: true,
	});
	return out || "absent";
}

function start() {
	requireEngine();
	loadEnv();
	checkAgreement(databaseSettings());

	const { port, database } = databaseSettings();

	if (serviceState() === "running") {
		console.log(`db: ${database} is already running on localhost:${port}.`);
		return;
	}

	console.log(`db: starting ${database} on port ${port}…`);
	// Only the postgres service: naming it is what keeps the `app` profile out,
	// so the daily loop never waits for an image build.
	compose(["up", "-d", SERVICE], { quiet: true });
	console.log(`db: up. Run \`npm run db:migrate\` next.`);
}

function stop() {
	requireEngine();
	loadEnv();

	if (serviceState() !== "running") {
		console.log(`db: ${SERVICE} is not running.`);
		return;
	}

	// `stop`, not `down`: `down` removes the containers and would invite the
	// habit of adding `-v`, which discards the data.
	compose(["stop", SERVICE], { quiet: true });
	console.log("db: stopped. Data is kept in its volume.");
}

function status() {
	loadEnv();

	try {
		const version = run(["info", "--format", "{{.ServerVersion}}"], {
			quiet: true,
		});
		console.log(`engine:    ${version}`);
	} catch {
		console.log("engine:    not running");
		console.log("container: unknown (engine is down)");
		return;
	}

	const state = serviceState();
	console.log(`container: ${state === "absent" ? "not created" : state}`);

	if (state === "running") {
		const settings = databaseSettings();
		console.log(
			`database:  ${settings.database} on localhost:${settings.port}`,
		);
		checkAgreement(settings);
	}
}

const command = process.argv[2];

switch (command) {
	case "start":
		start();
		break;
	case "stop":
		stop();
		break;
	case "status":
		status();
		break;
	default:
		fail(`unknown command "${command ?? ""}".`, "Use start, stop or status.");
}
