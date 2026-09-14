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
