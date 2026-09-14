# Container Deploy Skeleton Implementation Plan

## Overview

Make Sitesmith Studio build and run as a container image, proven rather than
asserted: schema reaches a fresh database by migration, Chromium is positively
demonstrated to launch inside the final image, and a local composition runs the
whole thing. The persistent host is deliberately out of scope and stays with
S-13.

## Current State Analysis

The runtime surface does not resist containerisation. The app has a three-variable
environment (`src/env.js:12-25`), writes nothing to disk (snapshots are `bytea`),
launches exactly one headless Chromium per run and measures pages sequentially
(`src/server/crawl/render.ts:287-311`), and already runs crawls as in-process
background work with a boot-time recovery sweep (`src/instrumentation.ts`). None
of that needs to change.

Four things are genuinely missing or wrong:

- **No path for schema into a production image.** There is no `drizzle/`
  directory; schema reaches a database only through `drizzle-kit push`, and
  `drizzle-kit` is a devDependency (`package.json:57`). A production install
  drops it. Both harnesses work around this by running
  `node_modules/drizzle-kit/bin.cjs` directly (`test/global-setup.ts:57-62`,
  `e2e/global-setup.ts:90-97`) — a precedent that does not survive `--omit=dev`.
- **A broken image will not announce itself.** `render.ts:289-297` catches a
  failed `chromium.launch()` and returns `{ observations: [], complete: false }`.
  An image with no working browser boots, serves every page, and crawls — it just
  quietly reports that speed could not be measured.
- **No build output tuned for a container.** `next.config.js` is an empty config
  object; `output: "standalone"` is unset.
- **No container definition, no composition, no CI.** `ls Dockerfile* compose*
  .github` → nothing. Confirmed as outstanding since bootstrap
  (`context/changes/bootstrap-verification/verification.md:160-163`).

And one fact that research did not cover, verified this session: **the repository
has no git remote.** `git remote -v` returns nothing and `.github/` does not
exist. A workflow can be written but cannot execute until a remote exists.

## Desired End State

A developer on Windows or POSIX can run one command to build the image and have
it verified end to end: the image builds, a composition brings up Postgres and
the app, migrations apply to an empty database, the app serves, and a real
Chromium launches inside the container and returns a real page measurement. The
same verification is invoked by a committed CI workflow that will run unchanged
the first time a remote exists.

Verify by: `npm run image:verify` exits zero from a clean checkout with Docker
running, and exits non-zero if Chromium is removed from the image.

### Key Discoveries

- `drizzle-orm/postgres-js/migrator` is present in the installed tree and
  `drizzle-orm` is a **runtime** dependency — so migrations can be applied from a
  production image with no devDependency at all.
- `drizzle.config.ts:3` imports `~/env`, which pulls `AUTH_SECRET` into every
  drizzle-kit invocation. Any runtime migrate step must avoid that import entirely.
- `src/server/db/index.ts:4` also imports `~/env`. The migrate runner must build
  its own connection from `process.env.DATABASE_URL`, not reuse `db`.
- `src/instrumentation.ts` already closes runs left open by a dead process, so an
  ungraceful container stop is survivable without new code.
- `output: "standalone"` traces with `@vercel/nft`, which analyses `import`,
  `require` and `fs` usage. Chromium is a binary, not a module — it will never be
  traced, and must come from the base image layer.
- `test/global-setup.ts:30-42` issues `CREATE DATABASE` against the `/postgres`
  maintenance database, so the compose Postgres must permit that.
- `e2e/global-setup.ts:87-89` records why drizzle-kit is spawned through `node`:
  since Node 20, spawning a `.cmd` shim without a shell fails on Windows with
  EINVAL. Anything this slice adds must work from PowerShell.
- Local Node is v24.18.0; `package.json` has no `engines`. The binding floor is
  unflagged TypeScript stripping in `scripts/seed-*.ts` (Node 22.18+).
- `playwright` is pinned at `1.62.1`, which is the base-image tag to match.

## What We're NOT Doing

- **Provisioning or choosing a host.** Deferred to S-13, per the kickoff scope.
  No Azure, no registry account, no secrets management, no TLS termination.
- **Creating a git remote.** The workflow ships unexecuted; see Phase 4.
- **Graceful SIGTERM handling.** The boot-time sweep already recovers stale runs.
  Adding a shutdown hook cannot be verified without a host and is speculative work.
- **Any change to crawl, render, findings or UI code.** This slice touches build,
  schema delivery and tooling only.
- **Volumes for application data.** Snapshots are database rows; the image needs
  no volume. Compose still uses a volume for Postgres' own data.
- **Multi-replica, autoscale or rolling-deploy concerns.** The recorded design is
  single-instance and the PRD's Non-Goals license it (`prd.md:467-468`).
- **Observability tooling.** No PRD requirement opens it.

## Implementation Approach

Four phases, each independently verifiable, ordered so that each one's proof is
possible when it lands.

Schema comes first because it is the only decision that changes a standing
project-wide property, and because everything after it assumes migrations exist.
The image comes second and proves Chromium at the binary level. The composition
comes third and gives the app a database to talk to. The end-to-end smoke comes
last because it needs both — and it is the only check that exercises the app's
own render path, which is where the silent-degrade risk actually lives.

The two Chromium proofs are deliberately at different depths and both are kept:
Phase 2 asserts the browser and its system libraries exist in the final layer;
Phase 4 asserts the application's code path reaches them. Phase 2 failing points
at the Dockerfile; Phase 4 failing with Phase 2 green points at the app or its
wiring.

## Critical Implementation Details

**The `~/env` trap governs the migrate runner's shape.** Both `drizzle.config.ts`
and `src/server/db/index.ts` import `~/env`, which validates `AUTH_SECRET`
alongside `DATABASE_URL`. The migrate runner must import neither — it constructs
its own `postgres()` client from `process.env.DATABASE_URL`. A runner that
imports `~/server/db` for convenience will fail at deploy time on a missing auth
secret, and the error will not point at the cause.

**Standalone tracing and the migrate runner.** `@vercel/nft` traces from Next's
entry points. A migrate script that Next never imports is not traced, so neither
it nor `drizzle-orm/postgres-js/migrator` is guaranteed to land in
`.next/standalone/node_modules`. The entrypoint must therefore either bundle the
runner with its dependencies at build time, or the Dockerfile must copy the
needed module trees explicitly. Decide by checking what is actually present in
`.next/standalone` after the build rather than assuming.

**The `playwright` package is a separate question from the Chromium binary.** The
binary is handled by the base image; the npm package must still be traced into
`.next/standalone/node_modules`. It is imported from exactly one place
(`src/server/crawl/render.ts:1`), so nft should find it — but playwright resolves
its browser registry through filesystem paths rather than imports, which is the
pattern nft handles worst, and no `outputFileTracingIncludes` or
`serverExternalPackages` config exists in this project today. Check the built
output for it rather than assuming; `outputFileTracingIncludes` is available in
this Next version if it turns out to be missing or incomplete.

**The final stage must be the Playwright image.** Chromium comes from the base
layer, not from the trace. Swapping the final stage to a slim Node image is the
one change that produces a container which boots, serves and crawls while
silently measuring nothing — the exact failure Phase 2's check exists to catch.

**The base image's Node version is a constraint to verify, not assume.** The tag
is chosen to match `playwright@1.62.1`; whether it ships a Node satisfying the
22.18+ floor for unflagged TypeScript stripping must be checked with
`docker run --rm <image> node --version` before the `engines` range is written.

## Phase 1: Schema on migrations

### Overview

Replace push-based schema delivery with generated, committed migrations applied
through `drizzle-orm`'s migrator, in every context: development, integration,
e2e, and the container. This is the only phase that changes how the project works
outside the container.

### Changes Required:

#### 1. Generated migrations

**File**: `drizzle/` (new directory, committed)

**Intent**: Produce the initial migration set from the current schema so a fresh
database can be built from the repository alone.

**Contract**: `drizzle-kit generate` output — SQL files plus the `meta/` journal —
reflecting `src/server/db/schema.ts` exactly as it stands. The generated set must
produce a database indistinguishable from one built by the current
`drizzle-kit push`; verify by diffing schemas, not by assuming.

#### 2. Migrate runner

**File**: `scripts/migrate.mjs`

**Intent**: Apply the committed migrations to whatever `DATABASE_URL` points at,
from any context — a developer shell, a test harness, or the container entrypoint.

**Contract**: Reads `process.env.DATABASE_URL` directly and constructs its own
`postgres()` client; imports neither `~/env` nor `~/server/db`. Exits non-zero
with a clear message when `DATABASE_URL` is absent. `.mjs` rather than `.ts` so
it runs under any Node without relying on type stripping — the container
entrypoint must not depend on that feature.

The one non-obvious part is the connection lifecycle, which matters more here than
in the harnesses:

```js
const sql = postgres(url, { max: 1 });
await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
await sql.end();
```

Without `end()`, the process hangs after migrating and the container never starts.

#### 3. npm scripts

**File**: `package.json`

**Intent**: Make migration the project's single schema mechanism and remove the
push path so the two cannot drift.

**Contract**: `db:migrate` invokes `node --env-file=.env scripts/migrate.mjs`
(matching the existing seed scripts' env convention); `db:generate` stays;
`db:push` is removed. `db:studio` is unaffected.

#### 4. Integration harness

**File**: `test/global-setup.ts`

**Intent**: Apply migrations instead of shelling out to the drizzle-kit binary.

**Contract**: The `execFileSync(process.execPath, [drizzleKit, "push", "--force"])`
block at lines 57-62 is replaced by a direct call into the same migrator the
runner uses. The `CREATE DATABASE` logic above it and the `-test` suffix guard
are untouched. The comment explaining the Windows EINVAL workaround goes with the
code it explained — its lesson no longer applies once no binary is spawned.

#### 5. E2E harness

**File**: `e2e/global-setup.ts`

**Intent**: Same conversion, same reasoning.

**Contract**: The equivalent block at lines 90-97 is replaced identically. The
`postgres`/`drizzle` client constructed immediately afterwards for seeding is
already present and can be reused rather than opened twice.

#### 6. Contributor documentation

**File**: `README.md`

**Intent**: Tell a contributor that schema changes now require a generate step,
because a forgotten `db:generate` will surface as a test failure rather than
being silently absorbed the way `push` absorbed it.

**Contract**: **Write a database section; do not edit one.** `README.md` is 29
lines of untouched `create-t3-app` boilerplate with no setup sequence and no
database instructions — its only database mention is a link to Drizzle's site. The
new section states how to bring up a database, how to apply schema (`db:migrate`),
and that editing `src/server/db/schema.ts` requires `db:generate` and committing
the result.

### Success Criteria:

#### Automated Verification:

- Migrations generate without error: `npm run db:generate` produces no pending diff
- Schema applies to an empty database: `npm run db:migrate` against a dropped-and-recreated database
- Unit tests pass: `npm run test:unit`
- Integration tests pass against a migrated database: `npm run test:integration`
- E2E tests pass against a migrated database: `npm run test:e2e`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- No `drizzle-kit push` invocation remains: `grep -rn "drizzle-kit" scripts/ test/ e2e/ package.json` hits only the `db:generate` and `db:studio` scripts

#### Manual Verification:

- A schema built by migrations matches one built by the old push path (compare with `\d` output or drizzle-kit's own diff on a scratch database)
- `npm run db:migrate` runs successfully from PowerShell, not only from bash
- A deliberately forgotten `db:generate` after a schema edit produces a comprehensible failure rather than a silent pass

**Implementation Note**: After completing this phase and all automated
verification passes, pause here for manual confirmation from the human that the
manual testing was successful before proceeding to the next phase.

---

## Phase 2: The image

### Overview

Produce a multi-stage Dockerfile that builds the app to a standalone output and
runs it on the version-matched Playwright base, and prove at the binary level
that Chromium launches inside the result.

### Changes Required:

#### 1. Standalone build output

**File**: `next.config.js`

**Intent**: Emit a self-contained server so the final stage carries no dependency
install of its own.

**Contract**: `output: "standalone"` added to the exported config object. The
existing `import "./src/env.js"` and its `SKIP_ENV_VALIDATION` comment stay —
that comment already names Docker builds as the reason the escape hatch exists,
and this phase is the first thing to use it.

#### 2. Node floor

**File**: `package.json`

**Intent**: Make the currently implicit Node requirement explicit, so the base
image and a contributor's local Node are checked against the same statement.

**Contract**: An `engines.node` range whose floor is the version that supports
unflagged TypeScript stripping in `scripts/seed-*.ts`. Write the range only after
verifying what the chosen base image actually ships.

#### 3. Build context exclusions

**File**: `.dockerignore`

**Intent**: Keep the build context small and keep host state — most importantly
`.env` and `node_modules` — out of the image.

**Contract**: Excludes at minimum `node_modules`, `.next`, `.git`, `.env*`,
`context/`, `test-results/`, `playwright-report/`, `blob-report/`. Mirrors
`.gitignore` where the reasoning is the same, but is a separate file with a
separate purpose — `context/` is committed and still has no business in an image.

#### 4. Dockerfile

**File**: `Dockerfile`

**Intent**: Build the app in one stage and run it on the Playwright base, so
Chromium and its system libraries come from a layer that is already correct and
version-matched.

**Contract**: Multi-stage. The final stage is
`mcr.microsoft.com/playwright:v1.62.1-<variant>` — matching the pinned
`playwright@1.62.1` — and must never be replaced by a slim Node image. The build
stage runs with `SKIP_ENV_VALIDATION` set, since no real `AUTH_SECRET` or
`DATABASE_URL` exists at build time. Exposes the port; sets `HOSTNAME=0.0.0.0` so
the server is reachable from outside the container. Runs as a non-root user.

**What must be copied, and why the list is explicit**: standalone output contains
only what `@vercel/nft` traced from Next's entry points, so anything Next does not
import is absent unless a `COPY` line puts it there. That covers the static assets
(the documented footgun — wrong destinations produce a site with no CSS rather
than an error), **the container-side scripts**, and **the `drizzle/` directory the
migrate runner reads**:

```dockerfile
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/public ./public
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts/migrate.mjs /app/scripts/check-browser.mjs ./scripts/
```

Phase 4 adds `smoke-container.mjs` to that last line. The list is deliberately
explicit rather than `COPY scripts/`: a container carrying only the scripts it
runs is easier to reason about than one carrying the vault mirror and the seeds.
Anyone adding a container-side script must extend this line — a script that is
merely written is not a script that is present.

#### 5. Entrypoint

**File**: `docker-entrypoint.sh`

**Intent**: Apply migrations, then start the server — so a fresh database becomes
a working deployment with no external step.

**Contract**: `ENTRYPOINT` runs `scripts/migrate.mjs`, then `exec "$@"` — with
`CMD ["node", "server.js"]` as the default. Migration becomes a precondition for
whatever the container was asked to do, and `exec` makes that command PID 1 so it
receives signals directly. A failed migration exits non-zero without running the
command; a container that serves against an unmigrated database is worse than one
that refuses to start. The script must be committed with its executable bit set,
or the Dockerfile must set it — on Windows checkouts the mode does not survive by
default.

`exec "$@"` rather than a hardcoded `node server.js` is what lets
`docker run <image> node scripts/check-browser.mjs` work at all. Without it, those
words are passed to a script that ignores them and the container starts the server
instead — so the browser check would silently test nothing.

**The migrate step must tolerate having no database**, because Phase 2's browser
check runs before any composition exists. Skip migration when `DATABASE_URL` is
unset and say so on stderr; fail loudly only when a URL is present and migration
against it does not work. An unset URL means nobody asked for a database; an
unreachable one means something is wrong.

#### 6. Browser proof

**File**: `scripts/check-browser.mjs`

**Intent**: Assert positively, from inside the image, that a browser launches and
can open a page — the check that distinguishes a working image from the quiet
broken one `render.ts` would otherwise produce.

**Contract**: Launches `chromium` headless exactly as `render.ts:289` does, opens
a `data:` URL needing no network, reads something back from the page, closes the
browser, and exits zero only if all of that succeeded. Any failure exits non-zero
with the underlying error — it must not degrade, because degrading is the bug it
exists to catch.

### Success Criteria:

#### Automated Verification:

- Image builds: `docker build -t sitesmith-studio .`
- Chromium launches in the final image: `docker run --rm sitesmith-studio node scripts/check-browser.mjs` exits zero
- Static assets are present in the image: `public/favicon.ico` and `.next/static` exist under the app directory
- The container-side scripts and `drizzle/` are present in the image
- `playwright` is present in `.next/standalone/node_modules` after the build
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- The host build still works: `npm run build`

#### Manual Verification:

- Base image Node version satisfies the `engines` range: `docker run --rm <base> node --version`
- Removing or renaming the browsers directory in a scratch image makes `check-browser.mjs` fail — the check is load-bearing, not decorative
- Image size is understood and recorded in proof, so a later regression is visible
- `docker build` succeeds from PowerShell

**Implementation Note**: After completing this phase and all automated
verification passes, pause here for manual confirmation from the human that the
manual testing was successful before proceeding to the next phase.

---

## Phase 3: The composition

### Overview

Give the image a database to talk to, and make compose the single definition of
the local Postgres — without losing the Windows lessons `scripts/db.mjs` encodes.

### Changes Required:

#### 1. Composition

**File**: `compose.yaml`

**Intent**: Run Postgres for the daily development loop by default, and the built
image alongside it on request, so the container's central claim is demonstrable
with one command.

**Contract**: A `postgres` service with a named volume, a healthcheck so
dependants wait for readiness rather than racing it, and credentials and port
supplied by **discrete `POSTGRES_*` variables** added to `.env` and
`.env.example` alongside `DATABASE_URL`. Compose substitutes whole variables and
cannot parse a URL into its parts — `scripts/db.mjs:65-80` does that in
JavaScript today, which is why deriving them inside `compose.yaml` is not
available. Discrete variables are what make `docker compose up` work when run
directly, not only through `db.mjs`.

Two representations of one connection can drift, so `db.mjs` must assert they
agree: it already parses `DATABASE_URL` for its status output, and comparing the
parsed host, port, password and database name against the `POSTGRES_*` values is
a few lines in a script that already exists to catch exactly this kind of
environment problem before it becomes a confusing failure. `.env.example` must
show both with a comment saying they describe the same database.

The superuser must retain `CREATEDB` — `test/global-setup.ts:30-42` connects to
the `/postgres` maintenance database to create the test and e2e databases, and a
locked-down single-database role breaks both suites.

An `app` service under a compose profile, so `docker compose up` starts only the
database. It runs the built image in production mode against the compose
Postgres. Production mode is not an aesthetic choice: `next dev` guards on the
project directory rather than the port, so a bind-mounted dev-mode service
collides with a host dev server even on a different port (observed during
research).

**The app service carries its own environment, defined in the composition.**
`src/env.js:12-25` requires `AUTH_SECRET` and `DATABASE_URL` at runtime —
`SKIP_ENV_VALIDATION` covers the build only — and neither can come from `.env`,
which is gitignored and excluded by `.dockerignore`, and which CI does not have at
all. The composition therefore supplies both directly: a `DATABASE_URL` pointing
at the compose `postgres` service by its service name, and a literal
verification-only `AUTH_SECRET`.

Both values are genuinely disposable — the database is ephemeral and the secret
signs nothing that outlives the run, which is the same reasoning that lets
`vitest.integration.config.ts:52` generate a random `AUTH_SECRET` for the
integration suite. What makes this safe is that it stays obviously
verification-only: the value must be self-describing (something no one could
mistake for a real secret) and commented as such where it is defined. This is what
makes `image:verify` behave identically on a laptop and in CI, which was the whole
reason for having one command rather than two.

#### 2. Database helper

**File**: `scripts/db.mjs`

**Intent**: Keep `npm run db:start|stop|status` as the interface while compose
becomes the definition, so there remains exactly one way to get a database.

**Contract**: The three commands drive `docker compose` instead of
`docker run`/`start`/`stop`. Everything the script exists for is preserved: the
absolute-path Docker binary discovery (`CANDIDATES`), `requireEngine()` and its
"start Docker Desktop" hint, and the `DATABASE_URL`-derived status output. The
`CONTAINER`/`IMAGE` constants and the hand-rolled `docker run` argument list go
away — compose owns them now. The file header comment must be updated; it
currently describes behaviour that will no longer be true.

#### 3. Contributor documentation

**File**: `README.md` (same file touched in Phase 1)

**Intent**: State how to bring up the database, and how to run the app as a
container when someone wants to.

**Contract**: Names `npm run db:start` as the everyday path and the profile
invocation as the container path, and says plainly that the host is not part of
this slice so nobody reads the composition as a deployment.

Also removes two pieces of scaffold boilerplate that this change makes actively
wrong: the **"How do I deploy this?"** section, which points at `create-t3-app`'s
Vercel, Netlify and Docker guides and would contradict the Dockerfile and
composition this slice adds, and the **Prisma** entry in the technology list,
which this project does not use.

### Success Criteria:

#### Automated Verification:

- Composition is valid: `docker compose config`
- Postgres starts and reports healthy: `npm run db:start` then `npm run db:status`
- Migrations apply against the compose database: `npm run db:migrate`
- Integration tests pass against the compose database: `npm run test:integration`
- E2E tests pass against the compose database: `npm run test:e2e`
- The app profile starts and serves: the app service reaches a ready state and the sign-in page responds
- Linting passes: `npm run check`

#### Manual Verification:

- `npm run db:start`, `db:stop` and `db:status` all behave correctly from PowerShell
- With the Docker engine stopped, `npm run db:status` still prints the friendly diagnostic rather than a stack trace
- Stopping and restarting the database preserves data — the volume works
- `docker compose up` alone does not build or start the app, keeping the daily loop fast
- A host `next dev` on port 3000 and the compose app profile coexist without collision

**Implementation Note**: After completing this phase and all automated
verification passes, pause here for manual confirmation from the human that the
manual testing was successful before proceeding to the next phase.

---

## Phase 4: Proof and CI glue

### Overview

Prove the application's own render path reaches a browser inside the container,
wrap the whole build-and-verify sequence in one command, and commit the workflow
that will call it the day a remote exists.

### Changes Required:

#### 1. End-to-end smoke

**File**: `scripts/smoke-container.mjs`

**Intent**: Assert that the containerised app, against a real database, produces
a real page measurement — closing the gap between "Chromium exists in the image"
(Phase 2) and "the product can use it".

**Contract**: Runs **inside the running app container** and calls `renderSample`
(`src/server/crawl/render.ts:275`) directly against a URL the composition itself
serves — the app's own sign-in page is sufficient and needs no fixture. Asserts a
positive result: at least one observation came back, and `complete` is true.
Exits non-zero otherwise.

Calling `renderSample` rather than driving the UI is deliberate. It reaches the
real launch site at `render.ts:289` with no authentication, no project record and
no crawl, so the check has exactly one reason to fail. The HTTP path is already
covered by the e2e suite on the host in every phase; what nothing else covers is
whether this code, in this image, can open a browser.

Absence of errors is explicitly not the assertion. `render.ts:289-297` returns a
successful-looking result with `complete: false` precisely when the browser is
missing, so a check written around thrown errors passes on a broken image.

Add `smoke-container.mjs` to the Dockerfile's scripts `COPY` line from Phase 2 —
a script that is written but not copied is not in the image. If reaching an
app-internal module from a standalone build needs a thin wrapper for the trace to
include, that wrapper is part of this change.

#### 2. Verification command

**File**: `package.json`, plus a script under `scripts/` if the sequence exceeds
what an npm script line can carry readably

**Intent**: One command that builds the image and runs every container check, so
the same sequence runs locally and in CI with no second definition to drift.

**Contract**: `image:verify` builds the image, brings up the composition with the
app profile, runs `check-browser.mjs` inside the image and `smoke-container.mjs`
against the running stack, then tears down — propagating a non-zero exit from any
step. Teardown must run even when a check fails, or a failed local run leaves
containers behind.

#### 3. CI workflow

**File**: `.github/workflows/image.yml`

**Intent**: Have the image build and verification run on push the first time a
remote exists, with no further work needed at that point.

**Contract**: Checks out, sets up Node per `engines`, and calls `image:verify` —
the workflow holds no verification logic of its own, so what CI runs is exactly
what a developer runs. No registry push and no secrets: publishing needs a
registry, which needs the host decision this slice deferred.

**This file cannot be executed until a git remote exists.** It must be committed
with a comment saying so, and Phase 4's criteria must not claim it passes.

#### 4. Change record

**File**: `context/changes/container-deploy-skeleton/change.md`

**Intent**: Record what this slice did and did not deliver, so the archive
decision about F-02 is made on facts rather than memory.

**Contract**: Notes stay; `status` and `updated` are stamped. Adds that the
workflow ships unexecuted for want of a remote — a second unmet clause alongside
the already-recorded host deferral, and equally a reason F-02 must not close as
`done`.

### Success Criteria:

#### Automated Verification:

- Full verification passes from a clean state: `npm run image:verify` exits zero
- The smoke asserts positively: it fails when pointed at a stack with no working browser, not merely when an error is thrown
- Workflow YAML is syntactically valid (parse it locally; it cannot be run)
- Linting passes: `npm run check`
- Type checking passes: `npm run typecheck`

#### Manual Verification:

- `npm run image:verify` succeeds from PowerShell
- A deliberately broken image — Chromium removed — fails the smoke, and the failure message identifies the browser as the cause
- Teardown leaves no stray containers or volumes after both a passing and a failing run
- `change.md` states both unmet clauses (host deferred, workflow unexecuted) plainly enough that the archive decision needs no reconstruction

**Implementation Note**: After completing this phase and all automated
verification passes, pause here for manual confirmation from the human that the
manual testing was successful.

---

## Testing Strategy

### Unit Tests:

Nothing in this slice adds product logic, so no new unit tests are expected. The
existing unit suite is a regression guard: it must keep passing through the
schema conversion, which is the only phase that touches code the suite covers.

### Integration Tests:

The existing integration suite is the proof that migrations produce a correct
schema. It already asserts tenant isolation and run persistence — properties that
live in the interaction between query and schema — so it fails loudly if the
generated migrations differ from what push produced. No new integration tests are
needed; the conversion is verified by the suite continuing to pass.

### Container Checks:

Two new checks, deliberately at different depths and both retained:

- `check-browser.mjs` — runs inside the image, asserts a browser launches and a
  page opens. Fails → the Dockerfile or base image is wrong.
- `smoke-container.mjs` — runs against the composition, asserts the app's own
  render path returns a real measurement. Fails while the first passes → the app
  or its wiring is wrong, not the image.

Both must assert positive facts. This codebase degrades rather than crashes by
design — `render.ts`, `coverage.ts`'s three-state discipline, the visual section's
`uncomparedReason` — which makes "no errors occurred" worthless as a deployment
signal.

### Manual Testing Steps:

1. From a clean checkout with Docker running, `npm run db:start` and confirm Postgres reports healthy.
2. `npm run db:migrate` against an empty database; confirm the schema is complete.
3. `npm run test:integration` and `npm run test:e2e`; both green against the compose database.
4. `npm run image:verify`; confirm it exits zero.
5. Break the image deliberately — remove the browsers directory in a scratch build — and confirm both container checks fail with messages naming the browser.
6. Repeat steps 1-4 from PowerShell.
7. Start a host `next dev` on port 3000, then bring up the app profile; confirm no collision.

## Performance Considerations

The Playwright base image is large — that was accepted at kickoff, because the
slim-base alternative makes the system-library list our problem, and S-06 made
`playwright` a runtime dependency. Standalone output keeps the app layer small,
so image size is dominated by a base layer that is cached and rarely changes.

Record the built image size in proof so a later regression — most plausibly a
final stage that stops being standalone — is visible rather than gradual.

Runtime performance is unchanged: the same single sequential browser, roughly
4-6 seconds per rendered page against a cap of twelve
(`context/archive/2026-09-05-browser-observed-checks/proof.md`).

## Migration Notes

**Schema mechanism changes project-wide.** After Phase 1, editing
`src/server/db/schema.ts` requires `npm run db:generate` and committing the
result. A forgotten generate now fails tests rather than being silently absorbed
by `push` — which is the point, but it is a new way for a contributor to be
caught out and is why Phase 1 touches the README.

**Existing developer databases are already at the current schema**, and drizzle's
migration journal has no record of how they got there — so the initial migration
would try to build tables that already exist. The generated SQL uses plain
`CREATE TABLE` with no `IF NOT EXISTS` (confirmed in
`drizzle/0000_freezing_violations.sql`), so this fails rather than degrading.
**Drop and recreate the development database, apply migrations, then re-seed**
with `db:seed-owner` and `db:seed-project`.

> **Correction, recorded during implementation.** This section originally
> justified the drop by asserting the development database "holds nothing but
> disposable development data". That was false. It held 7 projects, 38 runs,
> 5,609 pages and 24 snapshots — including the yazaki crawl history that
> `context/foundation/lessons.md` cites as evidence for "A rule shipping is not
> the site changing". The drop was carried out as planned on an explicit decision
> taken with that cost known, but the plan's stated reason for it was wrong.
>
> Two things follow for anyone reaching this section later. Check what a database
> actually contains before dropping it — the claim that dev data is disposable is
> an assumption, not a property. And note that an existing database whose schema
> already matches the migration can instead be **baselined**: record migration
> `0000` in drizzle's journal without executing it, which adopts the database into
> migrations while keeping its rows. That path was available here and was not
> taken.

**No production data exists to migrate.** No host is provisioned, so the first
database this ever runs against is empty — which is the easy case and the one the
entrypoint is designed for.

## References

- Change ticket: `context/changes/container-deploy-skeleton/change.md`
- Research: `context/changes/container-deploy-skeleton/research.md`
- Roadmap entry: `context/foundation/roadmap.md:110-121` (F-02)
- The browser launch site this slice must prove works: `src/server/crawl/render.ts:287-311`
- The silent-degrade path: `src/server/crawl/render.ts:289-297`
- Boot-time stale-run recovery: `src/instrumentation.ts`
- The push precedent being replaced: `test/global-setup.ts:57-62`, `e2e/global-setup.ts:90-97`
- The Windows lessons to preserve: `scripts/db.mjs:1-35`, `e2e/global-setup.ts:87-89`
- Env surface: `src/env.js:12-25`, `src/env.js:44`
- Standalone output docs, this version: `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md`
- Hosting Non-Goals that license the single-instance design: `context/foundation/prd.md:462-468`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema on migrations

#### Automated

- [x] 1.1 Migrations generate without error — 31a85f5
- [x] 1.2 Schema applies to an empty database — 31a85f5
- [x] 1.3 Unit tests pass — 31a85f5
- [x] 1.4 Integration tests pass against a migrated database — 31a85f5
- [x] 1.5 E2E tests pass against a migrated database — 31a85f5
- [x] 1.6 Type checking passes — 31a85f5
- [x] 1.7 Linting passes — 31a85f5
- [x] 1.8 No `drizzle-kit push` invocation remains — 31a85f5

#### Manual

- [x] 1.9 Migrated schema matches the push-built schema — 31a85f5
- [x] 1.10 `npm run db:migrate` runs from PowerShell — 31a85f5
- [x] 1.11 A forgotten `db:generate` fails comprehensibly — 31a85f5

### Phase 2: The image

#### Automated

- [x] 2.1 Image builds — 6b65dae
- [x] 2.2 Chromium launches in the final image — 6b65dae
- [x] 2.3 Static assets are present in the image — 6b65dae
- [x] 2.4 The container-side scripts and `drizzle/` are present in the image — 6b65dae
- [x] 2.5 `playwright` is present in `.next/standalone/node_modules` after the build — 6b65dae
- [x] 2.6 Type checking passes — 6b65dae
- [x] 2.7 Linting passes — 6b65dae
- [x] 2.8 The host build still works — 6b65dae

#### Manual

- [x] 2.9 Base image Node version satisfies the `engines` range
- [x] 2.10 Removing the browsers directory makes the check fail
- [x] 2.11 Image size recorded in proof
- [x] 2.12 `docker build` succeeds from PowerShell

### Phase 3: The composition

#### Automated

- [x] 3.1 Composition is valid — dc3ca3d
- [x] 3.2 Postgres starts and reports healthy — dc3ca3d
- [x] 3.3 Migrations apply against the compose database — dc3ca3d
- [x] 3.4 Integration tests pass against the compose database — dc3ca3d
- [x] 3.5 E2E tests pass against the compose database — dc3ca3d
- [x] 3.6 The app profile starts and serves — dc3ca3d
- [x] 3.7 Linting passes — dc3ca3d

#### Manual

- [x] 3.8 `db:start`, `db:stop`, `db:status` behave correctly from PowerShell
- [ ] 3.9 Engine-down diagnostic still friendly
- [x] 3.10 Stop and restart preserves data
- [x] 3.11 `docker compose up` alone does not start the app
- [ ] 3.12 Host `next dev` and the app profile coexist

### Phase 4: Proof and CI glue

#### Automated

- [x] 4.1 Full verification passes from a clean state — 871d532
- [x] 4.2 The smoke asserts positively — 871d532
- [x] 4.3 Workflow YAML is syntactically valid — 871d532
- [x] 4.4 Linting passes — 871d532
- [x] 4.5 Type checking passes — 871d532

#### Manual

- [x] 4.6 `npm run image:verify` succeeds from PowerShell
- [x] 4.7 A deliberately broken image fails the smoke, naming the browser
- [x] 4.8 Teardown leaves no stray containers or volumes
- [x] 4.9 `change.md` states both unmet clauses plainly
