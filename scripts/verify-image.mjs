/**
 * Build the image and run every container check, in one command.
 *
 * The same sequence runs on a laptop and in CI — `.github/workflows/image.yml`
 * calls this script and holds no verification logic of its own, so what CI runs
 * is exactly what a developer runs and there is no second definition to drift.
 *
 *   npm run image:verify
 *
 * The two checks are at deliberately different depths and both are kept:
 * `check-browser.mjs` runs inside the image and proves a browser and its system
 * libraries are there; `smoke-container.mjs` runs against the running stack and
 * proves the application's own render path reaches one. The first failing points
 * at the Dockerfile or the base image; the second failing while the first passes
 * points at the app or its wiring.
 *
 * **Its own compose project, on its own ports.** Verification builds a database
 * from nothing and tears it down afterwards, and it must be able to do that while
 * someone is developing against the composition's usual database. A separate
 * project name keeps the containers, the network and — the part that matters —
 * the volume entirely separate, so the teardown below can use `down -v` without
 * the risk of discarding a developer's data.
 *
 * Teardown runs whether or not the checks passed. A failed local run that left a
 * database and an app container behind would be a worse experience than the
 * failure it was reporting.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Its own project, so nothing here can reach the everyday composition. */
const PROJECT = "sitesmith-studio-verify";
const IMAGE = "sitesmith-studio";

/**
 * Ports that are not the composition's defaults, so a verification run and a
 * development database can be up at the same time.
 */
const PORTS = {
	POSTGRES_PORT: "55432",
	APP_PORT: "13100",
};

/** Docker's own bin directory, then whatever PATH offers. Same reasoning as `db.mjs`. */
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

/**
 * The environment every compose invocation gets.
 *
 * The port overrides are set here rather than in `.env` because a shell variable
 * beats `.env` in compose's precedence, which is what lets this run alongside a
 * developer's database without editing their file. Everything else compose reads
 * is defaulted in `compose.yaml`, so this works with no `.env` at all — which is
 * how CI runs it.
 */
const env = { ...process.env, ...PORTS };

function step(label, args) {
	console.log(`\nverify: ${label}`);
	console.log(`  $ docker ${args.join(" ")}`);
	execFileSync(docker, args, { stdio: "inherit", env });
}

const composeArgs = (...rest) => [
	"compose",
	"-p",
	PROJECT,
	"--profile",
	"app",
	...rest,
];

let failure = null;

try {
	step("building the image", composeArgs("build"));

	// Inside the image, with no composition at all — which is why the entrypoint
	// has to tolerate an unset DATABASE_URL rather than insisting on a database.
	step("chromium launches in the image", [
		"run",
		"--rm",
		IMAGE,
		"node",
		"scripts/check-browser.mjs",
	]);

	// `--wait` blocks until both services report healthy, so the check below needs
	// no sleep and cannot race the server's startup.
	step("bringing up the composition", composeArgs("up", "-d", "--wait"));

	step("the app's render path reaches a browser", [
		...composeArgs("exec", "-T", "app", "node", "scripts/smoke-container.mjs"),
	]);
} catch (caught) {
	failure = caught;
} finally {
	try {
		// `-v` is safe only because of the separate project name above: the volume
		// removed here is this run's, never the development database's.
		step("tearing down", composeArgs("down", "-v", "--remove-orphans"));
	} catch (teardownFailure) {
		console.error("verify: teardown itself failed. Containers may remain.");
		console.error(teardownFailure.message);
		// A failed teardown must not hide a failed check.
		if (!failure) failure = teardownFailure;
	}
}

if (failure) {
	console.error("\nverify: FAILED.");
	console.error(`  ${failure.message}`);
	process.exit(1);
}

console.log(
	"\nverify: the image builds, migrates, serves, and can open a browser.",
);
