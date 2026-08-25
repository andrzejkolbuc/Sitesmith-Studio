/**
 * Start, stop and inspect the development database from any shell.
 *
 * `start-database.sh` only runs in a POSIX shell, so on Windows it silently does
 * nothing in PowerShell — which looks exactly like a database that failed to
 * start. This wraps the same job in Node, which every shell can run, and calls
 * the Docker binary by absolute path rather than relying on it being on PATH
 * (it often is not in a shell opened before Docker was installed).
 *
 *   npm run db:start    create or start the container
 *   npm run db:stop     stop it, keeping the data
 *   npm run db:status   what is actually running
 *
 * The container keeps its data in a Docker volume, so stopping is not
 * destructive. Removing the container is not something this script does.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const CONTAINER = "sitesmith-studio-postgres";
const IMAGE = "postgres:latest";

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

/** Reads DATABASE_URL without importing the app's env module, which uses a path alias. */
function databaseSettings() {
	try {
		process.loadEnvFile(".env");
	} catch {
		// Absent .env is fine if the value is already in the environment.
	}

	const url = process.env.DATABASE_URL;
	if (!url) fail("DATABASE_URL is not set.", "Expected it in .env");

	const parsed = new URL(url);
	return {
		password: decodeURIComponent(parsed.password),
		port: parsed.port || "5432",
		database: parsed.pathname.slice(1),
	};
}

function containerState() {
	const out = run(
		["ps", "-a", "--filter", `name=^${CONTAINER}$`, "--format", "{{.State}}"],
		{ quiet: true },
	);
	return out || "absent";
}

function start() {
	requireEngine();

	const state = containerState();

	if (state === "running") {
		console.log(`db: ${CONTAINER} is already running.`);
		return;
	}

	if (state !== "absent") {
		run(["start", CONTAINER], { quiet: true });
		console.log(`db: started existing container ${CONTAINER}.`);
		return;
	}

	const { password, port, database } = databaseSettings();
	console.log(`db: creating ${CONTAINER} on port ${port}…`);

	run(
		[
			"run",
			"-d",
			"--name",
			CONTAINER,
			"-e",
			"POSTGRES_USER=postgres",
			"-e",
			`POSTGRES_PASSWORD=${password}`,
			"-e",
			`POSTGRES_DB=${database}`,
			"-p",
			`${port}:5432`,
			IMAGE,
		],
		{ quiet: true },
	);

	console.log(`db: created ${CONTAINER}. Run \`npm run db:push\` next.`);
}

function stop() {
	requireEngine();

	if (containerState() !== "running") {
		console.log(`db: ${CONTAINER} is not running.`);
		return;
	}

	run(["stop", CONTAINER], { quiet: true });
	console.log(`db: stopped ${CONTAINER}. Data is kept in its volume.`);
}

function status() {
	try {
		const version = run(["info", "--format", "{{.ServerVersion}}"], {
			quiet: true,
		});
		console.log(`engine:    ${version}`);
	} catch {
		console.log("engine:    not running");
		console.log(`container: unknown (engine is down)`);
		return;
	}

	const state = containerState();
	console.log(`container: ${state === "absent" ? "not created" : state}`);

	if (state === "running") {
		const { port, database } = databaseSettings();
		console.log(`database:  ${database} on localhost:${port}`);
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
