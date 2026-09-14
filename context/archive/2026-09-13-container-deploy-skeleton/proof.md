# Proof — container deploy skeleton

Evidence gathered while implementing, on 2026-09-14, on Windows 11 with Docker
Desktop 29.7.2. Recorded here because the claims this slice makes — "Chromium
launches in the image", "the app's own render path reaches it", "the image is
this big" — are the kind that quietly stop being true and need a number to
regress against.

## Phase 2 — the image

### Base image

`mcr.microsoft.com/playwright:v1.62.1-noble`, matching the pinned
`playwright@1.62.1`.

```
$ docker run --rm mcr.microsoft.com/playwright:v1.62.1-noble node --version
v24.18.1
```

That satisfies the `engines.node` floor of `>=22.18.0`, which exists because
`scripts/seed-*.ts` rely on unflagged TypeScript stripping. The floor was written
after this check, not before it.

Browsers ship at `/ms-playwright` (`chromium-1234`, `chromium_headless_shell-1234`,
`ffmpeg-1011`, `firefox-1538`, `webkit-2336`), and `PLAYWRIGHT_BROWSERS_PATH` is
already set in the base layer. The image runs as `pwuser` (uid 1001), which the
base image provides and which can already read that directory.

### The trace did not include what playwright needs — found by the check, not by reading

The first standalone build produced a `node_modules` of **13 packages**. It
contained `playwright` and `playwright-core`, so the naive form of criterion 2.5
passed. The container still failed:

```
$ docker run --rm sitesmith-studio node scripts/check-browser.mjs
entrypoint: DATABASE_URL is not set; skipping migrations.
Error: Cannot find module '/app/node_modules/playwright-core/browsers.json'
Require stack:
- /app/node_modules/playwright-core/lib/coreBundle.js
```

This is the failure the plan predicted at `Critical Implementation Details`:
playwright resolves its browser registry through constructed filesystem paths
rather than imports, which is the pattern `@vercel/nft` handles worst. `lib/` was
traced; `browsers.json`, which nothing imports by name, was not.

Fixed in `next.config.js` with `outputFileTracingIncludes` over the whole
`playwright` and `playwright-core` trees rather than over the one file that
happened to be missing — the registry reads several paths this way, and a list
naming only what we have tripped over would break again on the next upgrade, at
deploy time, as a browser that silently does not launch.

**Worth noting for anyone reading criterion 2.5 later:** "`playwright` is present
in `.next/standalone/node_modules`" was true while the image was broken. The
package directory being present is not the same claim as the package working.
2.2 is the criterion that actually held.

### Chromium launches in the final image

```
$ docker run --rm sitesmith-studio node scripts/check-browser.mjs
entrypoint: DATABASE_URL is not set; skipping migrations.
check-browser: chromium 151.0.7922.34 launched and rendered a page.
$ echo $?
0
```

The entrypoint line is itself evidence of two contracts: migration is skipped
rather than failed when no `DATABASE_URL` is set, and `exec "$@"` handed the
container's arguments to the check instead of starting the server.

### What is in the image

```
-- cwd: /app
-- static assets
-rwxr-xr-x 1 root root 15406 public/favicon.ico
.next/static -> chunks, hOFdCftoNM1gL5hhvIKZT, media
-- scripts
check-browser.mjs  migrate.mjs
-- drizzle
0000_freezing_violations.sql  meta/{0000_snapshot.json,_journal.json}
-- migrate deps
node_modules/{drizzle-orm,postgres,playwright,playwright-core}
-- user
uid=1001(pwuser) gid=1001(pwuser)
```

`drizzle-orm` and `postgres` are copied explicitly. Turbopack bundles the
server's database code into `.next/server`, so neither survives as a package in
the standalone tree — and `scripts/migrate.mjs`, which Next never imports, is
never traced at all. Both have zero runtime dependencies, so those two trees are
the whole requirement. Verified after the build rather than assumed, as the plan
required.

### Image size

| | Size |
| --- | --- |
| `mcr.microsoft.com/playwright:v1.62.1-noble` (base) | 3.52 GB |
| `sitesmith-studio:latest` | 3.62 GB |

**The application contributes about 100 MB**; the rest is a base layer that is
cached and changes only when playwright is upgraded. That split is the number to
watch: if the app layer grows into the hundreds of megabytes, the standalone
output has stopped being standalone — most plausibly because the final stage
started installing dependencies of its own.

## Phase 3 — the composition

### What the daily loop does and does not start

```
$ docker compose config --services
postgres
$ docker compose --profile app config --services
postgres
app
```

`docker compose up` brings up the database and nothing else. The app is behind
its profile because building the image on every `up` would make the fast path
slow, and the fast path is the one used a hundred times a day.

### The database, through the commands people already know

```
$ npm run db:start
db: starting sitesmith-studio on port 5432…
db: up. Run `npm run db:migrate` next.

$ npm run db:status
engine:    29.7.2
container: running
database:  sitesmith-studio on localhost:5432

$ docker compose ps --format "{{.Service}} {{.State}} {{.Health}}"
postgres running healthy

$ npm run db:migrate
migrate: schema is up to date.
```

`compose.yaml` is now the definition; `scripts/db.mjs` drives it instead of
hand-rolling a `docker run` argument list. Everything the script existed for is
kept — the absolute-path Docker discovery, the engine-down hint, the
`DATABASE_URL`-derived status — and it gains the agreement check between
`DATABASE_URL` and the `POSTGRES_*` variables compose reads.

### A migration this cost something, and it is worth writing down

The pre-existing development container was created by `docker run`, not by
compose, so compose could not adopt it: the container name was taken and its
data sat in an **anonymous** volume. Following the correction recorded in the
plan's Migration Notes, the database was inspected before anything was removed:

```
sitesmith-studio_tenant: 1
__drizzle_migrations: 1
sitesmith-studio_project: 1
sitesmith-studio_user: 1
```

Three rows, all of them produced by `db:seed-owner` and `db:seed-project` during
Phase 1 and reproducible by running those two commands again — which is what
"disposable" actually looks like, checked rather than assumed. The container was
removed and its anonymous volume (`e8f446ad…`) deliberately **left in place**
rather than pruned, so the decision stays reversible. The dev owner and project
were re-seeded after the compose database came up.

### The Postgres 18 mount path, which would have failed silently

`postgres:latest` is now Postgres 18, where `PGDATA` is
`/var/lib/postgresql/18/docker` and the image declares its volume at
`/var/lib/postgresql`:

```
$ docker image inspect postgres:latest --format '{{json .Config.Volumes}}'
{"/var/lib/postgresql":{}}
PGDATA=/var/lib/postgresql/18/docker
```

The familiar `postgres-data:/var/lib/postgresql/data` would not have errored.
Postgres would have initialised into an anonymous volume beside the named one,
the database would have worked perfectly, and the data would have vanished on
the first `docker compose down` — the failure only showing up as an empty
database days later. The mount targets the declared path instead.

### The app service serves

```
$ docker compose --profile app up -d --build
 Container sitesmith-studio-postgres Healthy
 Container sitesmith-studio-app Started

$ docker compose logs app
migrate: schema is up to date.
▲ Next.js 16.3.1
- Network:       http://0.0.0.0:3000
✓ Ready in 0ms

$ curl -o /dev/null -w "HTTP %{http_code}" http://localhost:3100/signin
HTTP 200      # <title>Sitesmith Studio</title>, "Sign in"
```

Three contracts in that log at once: the entrypoint applied migrations before the
server started, `HOSTNAME=0.0.0.0` made the server reachable from outside the
container, and the service publishes on 3100 so a host `next dev` on 3000 is
undisturbed.

### Both suites against the compose database

```
$ npm run test:integration
Test Files  12 passed (12)
     Tests  122 passed (122)
  Duration  158.19s

$ npm run test:e2e
25 passed (11.6m)
```

The integration suite is the proof that the migrated schema is correct — it
asserts tenant isolation and run persistence, which live in the interaction
between query and schema — and it now asserts that against a database compose
defined rather than one a hand-rolled `docker run` produced. `CREATE DATABASE`
against the `/postgres` maintenance database still works, which is why both
suites can create their own databases in the same instance.

## Phase 4 — proof and CI glue

### One command, from clean, exits zero

```
$ npm run image:verify

verify: building the image
verify: chromium launches in the image
  $ docker run --rm sitesmith-studio node scripts/check-browser.mjs
entrypoint: DATABASE_URL is not set; skipping migrations.
check-browser: chromium 151.0.7922.34 launched and rendered a page.

verify: bringing up the composition
  $ docker compose -p sitesmith-studio-verify --profile app up -d --wait
 Container sitesmith-studio-verify-postgres-1 Healthy
 Container sitesmith-studio-verify-app-1 Healthy

verify: the app's render path reaches a browser
  $ docker compose -p sitesmith-studio-verify --profile app exec -T app node scripts/smoke-container.mjs
smoke: rendering http://localhost:3000/signin
smoke: measured http://localhost:3000/signin — TTFB 8.8ms, LCP 64ms, CLS 0
smoke: 0 first-party and 0 third-party console errors.

verify: tearing down
 Volume sitesmith-studio-verify_postgres-data Removed

verify: the image builds, migrates, serves, and can open a browser.
$ echo $?
0
```

**A real measurement**, not an absence of errors — the browser's own navigation
timing and its own `PerformanceObserver`, produced by the application's code
inside the container against a page the composition served.

### The verification runs in its own project, and that is load-bearing

`image:verify` builds a database from nothing and must tear it down with
`down -v`. On a developer's laptop that command is a loaded gun pointed at the
database they work against, so the run gets its own compose project name
(`sitesmith-studio-verify`) and its own ports (55432, 13100). The volume removed
at teardown is `sitesmith-studio-verify_postgres-data`, which only this run ever
touched.

Observed during the run: `sitesmith-studio-postgres` stayed up and healthy
throughout. Afterwards:

```
$ docker ps -a     --filter name=sitesmith-studio-verify   →  0
$ docker volume ls --filter name=sitesmith-studio-verify   →  0
$ docker network ls --filter name=sitesmith-studio-verify  →  0
$ docker ps
sitesmith-studio-postgres Up 18 minutes (healthy)
```

This is also why `container_name` was removed from `compose.yaml` in the same
phase: a fixed container name is global to the Docker engine, so it would have
made a second copy of the composition impossible.

### The checks assert positively — demonstrated, not claimed

The hazard is specific. `render.ts:289-297` catches a failed launch and returns
`{ observations: [], complete: false }`, so a check built around thrown errors
passes on a broken image. Pointing `PLAYWRIGHT_BROWSERS_PATH` at an empty
directory reproduces exactly that state:

```
$ docker run --rm -e PLAYWRIGHT_BROWSERS_PATH=<empty dir> sitesmith-studio \
    node scripts/smoke-container.mjs
smoke: rendering http://localhost:3000/signin
smoke: the browser was not usable.
    `renderSample` returned complete: false, which it does when
    `chromium.launch()` throws — a missing browser binary, a missing
    system library, or a sandbox refusing to start.
    The image can still boot, serve and crawl in this state; it just
    measures nothing. That is the failure this check exists for.
$ echo $?
1
```

The same command against the same image with a **working** browser and nothing
serving fails differently:

```
smoke: the page could not be rendered.
    http://localhost:3000/signin: page.goto: net::ERR_CONNECTION_REFUSED
```

That contrast is the point. The check distinguishes "no browser" from "no page",
so a failure names its own cause rather than leaving both open. `check-browser.mjs`
under the same broken condition is equally explicit:

```
check-browser: chromium failed to launch.
    The browser binary or its system libraries are missing from this image.
    The final stage must be the Playwright base image — Chromium is a binary
    and is never traced into the standalone output.
browserType.launch: Executable doesn't exist at …/chrome-headless-shell
$ echo $?
1
```

### The workflow parses, and has never run

```
$ yq '{"name": .name, "on": (.on | keys), "jobs": (.jobs | keys),
       "run": .jobs.verify.steps[2].run}' < .github/workflows/image.yml
name: image
on: [push, pull_request, workflow_dispatch]
jobs: [verify]
run: npm run image:verify
```

Valid YAML with every key intact, and it invokes the same command a developer
runs. **That is the whole of the claim.** The repository has no git remote, so
the workflow has never executed and cannot until one exists — which is the second
of the two unmet clauses recorded in `change.md`, alongside the deferred host.

## Manual verification

Run on 2026-09-14 in **Windows PowerShell 5.1** (`$PSVersionTable.PSVersion` →
5.1.26100.9444), which is the shell the PowerShell rows exist to check. Everything
above this section was run from Git Bash, so these are the rows that could not be
inferred from it.

### The three PowerShell rows

```powershell
PS> npm run db:status
engine:    29.7.2
container: running
database:  sitesmith-studio on localhost:5432

PS> npm run db:stop
db: stopped. Data is kept in its volume.
PS> npm run db:status
container: exited

PS> npm run db:start
db: starting sitesmith-studio on port 5432…
db: up. Run `npm run db:migrate` next.

PS> docker build -t sitesmith-studio .
BUILD_EXIT=0

PS> npm run image:verify
smoke: measured http://localhost:3000/signin — TTFB 9.3ms, LCP 68ms, CLS 0
verify: the image builds, migrates, serves, and can open a browser.
VERIFY_EXIT=0
```

### The volume actually persists

Checked across both things that could lose it — a stop/start, and a full
container removal and recreate:

```
BEFORE                          AFTER stop→start        AFTER rm→up
__drizzle_migrations: 1         (same)                  (same)
sitesmith-studio_project: 1     (same)                  (same)
sitesmith-studio_tenant: 1      (same)                  (same)
sitesmith-studio_user: 1        (same)                  (same)
                                owner: owner@sitesmith.test
                                project: Demo Site
```

Row counts alone would be a weak assertion — four tables with one row each is
also what a freshly migrated and re-seeded database looks like. The owner's email
and the project's name are read back as well, because those are values only the
original rows carry.

### A bare `docker compose up` starts only the database

From a genuinely clean state — the postgres container stopped and removed first,
so `compose ps -a` listed nothing at all:

```powershell
PS> docker compose up -d
 Container sitesmith-studio-postgres-1 Created
 Container sitesmith-studio-postgres-1 Started
PS> docker compose ps -a --format "{{.Service}} {{.State}}"
postgres running
```

No app service, no image build. The daily loop stays fast.

### Teardown after a failing run — fault injected, not assumed

The first attempt at this was wrong and is recorded because the mistake is
instructive: occupying host port 13100 with a local listener was expected to make
`compose up` fail, and **the run passed anyway** — Docker Desktop published the
port regardless. A test that does not produce the failure it is testing for proves
nothing, and it would have been easy to read that passing run as evidence.

The fault was then injected where it actually bites: `smoke-container.mjs`'s
target was temporarily pointed at `http://localhost:59999/deliberately-unreachable`.

```powershell
PS> npm run image:verify
smoke: rendering http://localhost:59999/deliberately-unreachable
smoke: the page could not be rendered.
    page.goto: net::ERR_CONNECTION_REFUSED

verify: tearing down
 Container sitesmith-studio-verify-app-1 Removed
 Container sitesmith-studio-verify-postgres-1 Removed
 Volume sitesmith-studio-verify_postgres-data Removed
 Network sitesmith-studio-verify_default Removed
verify: FAILED.
VERIFY_EXIT=1

PS> # stray artifacts after the failing run
containers=0 volumes=0 networks=0
PS> docker ps
sitesmith-studio-postgres-1 Up About a minute (healthy)
```

Teardown ran on the failure path, removed everything it created, and the
development database was untouched throughout. The temporary edit was reverted
with `git checkout` and the image rebuilt, so the tagged image carries the real
target again.

### Still unverified

Two rows are **not** covered by anything above and remain open:

- **3.9 — the engine-down diagnostic.** Requires stopping Docker Desktop, which
  no check here did. The code path is unchanged from before this slice, but
  unchanged is not the same as exercised.
- **3.12 — a host `next dev` on 3000 coexisting with the app profile.** The app
  service runs production mode, publishes 3100 and bind-mounts nothing, so the
  collision the research observed should be structurally impossible — which is
  an argument, not an observation, and this file is for observations.

### 3.12 — a host `next dev` and the app profile, running at once

The reason this row exists is a specific observation from research: `next dev`
guards on the **project directory** rather than the port, so a bind-mounted
dev-mode compose service collides with a host dev server even on a different
port. The symptom is nasty — the page renders, every build chunk 403s, React
never hydrates, and the result looks like a working page that ignores clicks.
So "both return 200" is not the assertion; "the client-side app is alive" is.

Host `npm run dev` started on 3000, then the app profile brought up alongside it:

```powershell
PS> docker compose --profile app up -d --wait
 Container sitesmith-studio-app-1 Healthy
PS> docker compose ps -a --format "{{.Service}} {{.State}} {{.Health}}"
app running healthy
postgres running healthy
```

Both served at the same time, from different processes on different ports:

```
host  next dev  :3000/signin   HTTP 200  title=Sitesmith Studio  bytes=15942
container app   :3100/signin   HTTP 200  title=Sitesmith Studio  bytes=10956

LocalAddress LocalPort OwningProcess
::                3000         35744
::                3100         15672
```

The differing byte counts are the tell that these are genuinely two builds — dev
output with its HMR client against a production build — and not one server
answering twice.

**Host dev server, with the container up** — 148 requests, every chunk, stylesheet
and font `200 OK`, **no 403s anywhere**. Hydration confirmed by things only a
live React client produces:

```
[log] [HMR] connected
[log] [Fast Refresh] done in 83ms
[log] [TRPC] project.list took 375ms to execute   Server
```

A tRPC query issued from the browser is proof the client bundle loaded, executed
and is talking to the server — which is exactly what the 403 collision prevents.

**Container app, at the same moment** — zero console errors, all assets 200,
hashed production chunk names and no HMR client:

```
GET /signin                            → 200 OK
GET /_next/static/chunks/1tkd3n0s0srjf.css → 200 OK
GET /_next/static/media/*.woff2        → 200 OK  (×5)
GET /_next/static/chunks/*.js          → 200 OK  (×7)
```

Both pages screenshotted and fully styled. That incidentally re-proves the
Dockerfile's static-asset `COPY` destinations: the documented footgun there
produces a site with no CSS rather than an error, and the container's page has
its CSS.

The dev server's log does carry `TRPCError: This account is not attached to a
tenant` — that is a stale browser session for an account with no workspace being
correctly refused, which is the product working, not a collision. It is noted
here so a later reader does not mistake it for one.

No collision. The app service runs production mode and bind-mounts nothing,
which is what makes the research's failure mode structurally unreachable — and
this is now the observation rather than the argument.

### 3.9 — the engine-down diagnostic

Exercised by pointing the Docker client at an unreachable daemon
(`DOCKER_HOST=tcp://127.0.0.1:1`) rather than by stopping Docker Desktop, so the
development database stayed up throughout.

```powershell
PS> $env:DOCKER_HOST = "tcp://127.0.0.1:1"

PS> npm run db:status
engine:    not running
container: unknown (engine is down)
STATUS_EXIT=0

PS> npm run db:start
db: the Docker engine is not running.
    Start Docker Desktop and wait for the whale icon to settle, then retry.
START_EXIT=1

PS> npm run db:stop
db: the Docker engine is not running.
    Start Docker Desktop and wait for the whale icon to settle, then retry.
STOP_EXIT=1
```

A friendly diagnostic in every case, no stack trace, and the exit codes are the
right way round: `status` succeeds because reporting "the engine is down" **is**
its job done, while `start` and `stop` fail because they were asked to do
something and could not.

**What this is and is not.** `scripts/db.mjs` decides the engine is down by one
test — whether `docker info` succeeds — and an unreachable `DOCKER_HOST` makes it
fail exactly as a stopped daemon does, reaching the same `catch`. The difference
is the underlying transport error (a refused TCP connect rather than a missing
named pipe), which the script never inspects. So this is a faithful exercise of
the code path and a **proxy** for the literal scenario, not the literal scenario
itself; it is recorded as a proxy so nobody later reads more into it than was
tested.

`DOCKER_HOST` was set for that shell only; `npm run db:status` afterwards
reported the engine at 29.7.2 with the container running, unchanged.
