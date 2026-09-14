---
date: 2026-09-14T00:05:00+02:00
researcher: Andrzej Kolbuc
git_commit: 50b37641528604439b98c83e6c6a6cd0caf2c0b0
branch: master
repository: Sitesmith-Studio
topic: "What containerising Sitesmith Studio actually requires"
tags: [research, codebase, container, docker, deployment, playwright, drizzle, f-02]
status: complete
last_updated: 2026-09-14
last_updated_by: Andrzej Kolbuc
---

# Research: What containerising Sitesmith Studio actually requires

**Date**: 2026-09-14T00:05:00+02:00
**Researcher**: Andrzej Kolbuc
**Git Commit**: `50b3764`
**Branch**: master
**Repository**: Sitesmith-Studio

## Research Question

F-02 (`container-deploy-skeleton`), scoped at kickoff to the container half only:
a Dockerfile, a local composition and a CI image build, with the host deferred to
S-13. What does the codebase actually require for that, and what would a plan
written from assumptions get wrong?

## Summary

**The Dockerfile is the easy part.** The app has a three-variable environment,
writes nothing to disk, launches exactly one browser at a time, and already runs
its long work as an in-process background task that behaves identically in a
container. Nothing in the runtime surface fights containerisation.

Three things are not easy, and none of them is about Docker:

1. **Schema delivery has no supported path into a production image.** There is no
   migrations directory; schema reaches a database only via `drizzle-kit push`,
   and `drizzle-kit` is a devDependency. A production install drops it. Both test
   harnesses already work around this by invoking the binary out of
   `node_modules` directly — a precedent, but not one that survives `--omit=dev`.

2. **A broken image will not announce itself.** `chromium.launch()` failure is
   caught and degraded, not thrown. An image missing Chromium boots cleanly,
   serves every page, crawls successfully, and silently reports that speed could
   not be measured — forever. Any acceptance check that only asks "does it boot"
   will pass on a broken image.

3. **`drizzle.config.ts` imports `~/env`**, so running `db:push` validates
   `AUTH_SECRET` as well as `DATABASE_URL`. A migration step given only a database
   URL fails on a missing auth secret, which is a confusing way to discover this.

The roadmap's own framing also needs correcting: **F-02's PRD ref points at the
wrong requirement.** It cites NFR-3, which is the retention/bounded-footprint
requirement about snapshot expiry. Nothing in the PRD's NFR section is about
hosting. The genuine hosting constraints live in **Non-Goals**, and they are
permissive — which matters, because they license the simple design.

## Detailed Findings

### Runtime surface — nothing here resists a container

**Browser use is minimal and singular.** One launch site, `src/server/crawl/render.ts:289`:

- `chromium` only. No firefox, no webkit anywhere in `src/server/`.
- `headless: true`, no `channel` — the bundled Chromium, not a system Chrome.
- **One browser per run**, launched once in `renderSample` (`render.ts:287`),
  pages measured **sequentially** in a `for` loop (`render.ts:301-306`), closed in
  a `finally` (`render.ts:308`). No concurrency, no pool, no orphan risk.

**The launch failure path is the container risk.** `render.ts:289-297` catches a
failed launch and returns `{ observations: [], complete: false }`, with a comment
stating the intent plainly — reporting a site as error-free because we could not
open a browser is the claim this codebase refuses to make. That is right for the
product and dangerous for a deployment: a container whose Chromium is missing or
missing a system library is indistinguishable, from the outside, from one working
correctly on a site with no performance problems. It surfaces only as
`renderSummary.complete: false`, which the UI renders as "Speed and loading errors
could not be measured during this check."

**Long-running work already assumes a single persistent process.** From
`context/changes/first-multilingual-crawl/plan.md:77-87`: a crawl runs as a
background task inside the Node process with the run row as its state; the trigger
inserts a `queued` run, starts the work without awaiting, and returns. The plan
explicitly states this "behaves the same in development as in the container F-02
will add". Its known weakness is handled rather than solved — on boot, any run
still marked `running` is closed as `interrupted`.

Two consequences for the container:
- **Restart kills in-flight runs.** Recovery is a status flip, not a resume. Any
  rolling-deploy, autoscale or multi-replica story contradicts the recorded
  design. Single instance is the assumption, and the PRD's non-goals license it
  (`prd.md:467-468`, "No horizontal scale beyond a single machine").
- **A boot-time sweep exists**, so an ungraceful stop is survivable. A graceful
  shutdown hook would be an improvement, not a prerequisite.

**No filesystem dependency.** Snapshots are `bytea` in Postgres
(`visual-regression-baselines/plan.md:178-186`). The filesystem option was
considered and declined *specifically because* it "adds … a volume F-02 has not
decided on" (`visual-regression-baselines/research.md:334-336`). So **the image
needs no volume**; snapshot bytes are database growth. `public/` contains only
`favicon.ico`.

### Build — `output: "standalone"` is unset, and what it implies

Read from this version's own shipped docs at
`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md`:

- `output: 'standalone'` emits `.next/standalone` with a minimal `server.js`,
  deployable "without installing `node_modules`".
- **It does not copy `public/` or `.next/static`.** Both must be copied manually
  after the build (`cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/`).
- The server honours `PORT` and `HOSTNAME`; `HOSTNAME=0.0.0.0` is what makes it
  reachable from outside the container.
- Tracing is done by `@vercel/nft`, which "statically analyze[s] `import`,
  `require`, and `fs` usage".

**The tracing caveat matters here.** Chromium is not reachable by static analysis
of imports — it is a binary in a browsers directory, not a module. `nft` will not
trace it into `.next/standalone`. With the chosen Playwright base image this is
fine, because the browser comes from the base layer rather than from the trace —
but it means the final stage must be the Playwright image (or otherwise carry the
browsers path), and a "copy standalone into a slim node image" optimisation would
silently produce the exact broken-but-quiet container described above.

**Env at build time.** The full surface is three variables (`src/env.js`):
`AUTH_SECRET`, `DATABASE_URL`, `NODE_ENV`. `skipValidation` is driven by
`SKIP_ENV_VALIDATION`, and `next.config.js` already carries a comment naming
Docker builds as the reason it exists.

### Schema delivery — the real decision

**There is no migrations directory.** `ls drizzle/` → absent. `drizzle.config.ts`
declares `schema`, `dialect`, `dbCredentials.url` and a `tablesFilter` of
`sitesmith-studio_*`; nothing emits SQL migrations. Confirmed as a standing
property in `first-multilingual-crawl/plan.md` ("Drizzle is push-based (`db:push`,
no migrations directory)") and again in two archived changes.

**`drizzle-kit` is a devDependency.** A production image built with `--omit=dev`
has no way to apply schema.

**The established in-repo pattern** — used by both harnesses, identically:

- `test/global-setup.ts:57-62` and `e2e/global-setup.ts:90-97` both resolve
  `node_modules/drizzle-kit/bin.cjs` and run it via `execFileSync(process.execPath, [drizzleKit, "push", "--force"])`.
- `e2e/global-setup.ts:87-89` records why it invokes the binary through Node
  rather than `npx`: since Node 20, spawning a `.cmd` shim without a shell fails
  on Windows with EINVAL.

So the precedent is "run the drizzle-kit binary directly with `DATABASE_URL` in
the environment" — which works only where devDependencies are installed.

**A second trap in the same area:** `drizzle.config.ts` imports `~/env`, so
drizzle-kit triggers the full env validation — including `AUTH_SECRET`. A schema
step handed only a database URL fails on a missing auth secret, and the error will
not obviously point at the config import.

The options the codebase's shape actually permits, for the plan to choose between:
ship `drizzle-kit` into the runtime image; generate real migrations and apply them
at boot; or make schema delivery an explicit external step that never runs inside
the app container. This is the single most consequential open decision.

### Dev and test harness — three databases on one server

All three are derived from one `DATABASE_URL` by rewriting the database name:

| Context | Database | Derived at |
|---|---|---|
| Development | `sitesmith-studio` | `.env` |
| Integration | `sitesmith-studio-test` | `vitest.integration.config.ts:24` |
| E2E | `sitesmith-studio-e2e` | `playwright.config.ts` |

`test/global-setup.ts:30-42` connects to the `/postgres` maintenance database to
issue `CREATE DATABASE`. **So the compose Postgres must permit creating
databases** — a locked-down single-database URL breaks the test suites. (This
constrains local compose only; the managed production instance never runs them.)

`vitest.integration.config.ts:33` also rewrites `DATABASE_URL` in the *config*
process, not just the workers, with a comment explaining that `globalSetup` runs
in the main process and would otherwise create tables in the development database.
`AUTH_SECRET` is defaulted to a random value for the integration run
(`vitest.integration.config.ts:52`).

**The dev-server collision is real and I hit it in this session.** With
`next dev` already running on port 3000, `npm run test:e2e` failed before any test
executed: *"Another next dev server is already running"*, naming the PID and
`.next\dev\logs\next-development.log`, exit code 1. `playwright.config.ts` sets
`reuseExistingServer: false` and spawns its own dev server on port 3210 — a
different port, and it still refused. The guard is scoped to the **project
directory**, not the port. Any compose service that runs `next dev` against a
bind-mounted project directory will collide with a host dev server the same way.
A production-mode container (`server.js`) is not affected.

**Env loading**, per entry point:
- npm scripts for seeds: `node --env-file=.env scripts/seed-*.ts`
- `playwright.config.ts:14` and `vitest.integration.config.ts:18`:
  `process.loadEnvFile(".env")`, both wrapped in try/catch so an absent `.env` is
  tolerated when values come from the environment.
- `.env` holds exactly `AUTH_SECRET` and `DATABASE_URL`; `.env.example` carries
  the same two keys; `.env` is gitignored (`.gitignore:36-37`).

### Node version floor

`package.json` has no `engines` field. The floor is set by APIs actually in use:

- `process.loadEnvFile` — Node 20.12+ / 21.7+.
- `node --env-file` — Node 20.6+.
- **`node scripts/seed-owner.ts` — running TypeScript directly.** Unflagged type
  stripping lands in Node 22.18+ / 23.6+. This is the binding constraint.

Local development runs **Node v24.18.0**. The base image should match that major
rather than the bare minimum, and `engines` is worth adding as part of this slice
so the constraint stops being implicit.

## Code References

- `src/server/crawl/render.ts:287-311` — the only browser launch; sequential pages; `finally { browser.close() }`
- `src/server/crawl/render.ts:289-297` — launch failure caught, degraded to `complete: false`
- `src/env.js:12-25` — the complete env surface: `AUTH_SECRET`, `DATABASE_URL`, `NODE_ENV`
- `src/env.js:44` — `skipValidation: !!process.env.SKIP_ENV_VALIDATION`
- `next.config.js:1-4` — the comment naming Docker builds as `SKIP_ENV_VALIDATION`'s purpose
- `drizzle.config.ts:3` — `import { env } from "~/env"`, pulling `AUTH_SECRET` into every drizzle-kit invocation
- `test/global-setup.ts:30-42` — `CREATE DATABASE` against the `/postgres` maintenance database
- `test/global-setup.ts:57-62`, `e2e/global-setup.ts:90-97` — the `drizzle-kit push --force` precedent
- `vitest.integration.config.ts:24,33,52` — test DB derivation, main-process redirect, random `AUTH_SECRET`
- `playwright.config.ts` — port 3210, `reuseExistingServer: false`, e2e DB rewrite
- `scripts/db.mjs:21-30` — container name `sitesmith-studio-postgres`, `postgres:latest`, hardcoded Windows Docker paths

## Architecture Insights

- **The app is already shaped for a single persistent container.** In-process
  background work, boot-time recovery, no filesystem state, no queue. The
  container does not require an architecture change — which is exactly what the
  tech-stack hand-off predicted would *not* be true (it anticipated "a separate
  worker process alongside the web app", `tech-stack.md:49-73`). That prediction
  was superseded by `first-multilingual-crawl`, and a plan should follow the code,
  not the hand-off.
- **Degrade-rather-than-crash is a deliberate, repeated pattern** (`render.ts`,
  `coverage.ts`'s three-state discipline, the visual section's `uncomparedReason`).
  It makes the product honest and makes deployments hard to verify. Acceptance
  criteria for this slice must be positive assertions — *a browser launched and
  measured a page* — not absence of errors.
- **Windows is a first-class development platform here**, not an afterthought.
  `scripts/db.mjs` exists solely because `start-database.sh` silently did nothing
  in PowerShell, and `e2e/global-setup.ts` invokes drizzle-kit through `node`
  because `.cmd` shims fail with EINVAL. Anything this slice adds must work from
  PowerShell.

## Historical Context (from prior changes)

- `context/foundation/tech-stack.md:44-47` — self-hosted container targeting
  Azure, Cloudflare in front as CDN/DNS only; chosen because the workload "needs a
  persistent process rather than a short-lived invocation".
- `context/foundation/tech-stack.md:71-73` — **"Hosting cost is real. The
  zero-spend constraint recorded during shaping covers tool licences, not
  infrastructure."** The zero-spend constraint (`prd.md:31-34`) does *not* forbid
  paying for a host.
- `context/changes/bootstrap-verification/verification.md:160-163` — the scaffold
  generated no Dockerfile, no CI workflows, no worker; all recorded as outstanding.
- `context/foundation/roadmap.md:209-211` (S-06) — "**Constrains F-02:**
  `playwright` is a runtime dependency from this slice onward, so any container
  must ship Chromium and its system libraries."
- `context/foundation/roadmap.md:248-249` (S-08) — "**Constrains F-02:** nothing
  new. `pixelmatch` and `pngjs` are pure JavaScript."
- `context/archive/2026-09-05-browser-observed-checks/proof.md` — ~4-6s per
  rendered page, cap of twelve, so roughly +60s on a 5-minute crawl.
- `context/changes/visual-regression-baselines/proof.md` — measured snapshot size
  ~1.6-2.2 MB per page; "12 watched pages × ~2 MB × 4 retained sets × 10 projects
  ≈ 960 MB", four to ten times the planning estimate. **Anyone sizing a host
  should use the measured figure.** This is Postgres growth, not volume growth.

## PRD correction worth carrying into the plan

F-02 cites **NFR-3**, but the PRD's NFRs are unnumbered (`prd.md:332-348`) and the
third bullet is *"Stored snapshots and run history stay within a bounded
footprint"* — retention, not hosting. Nothing in the NFR section concerns
deployment. The applicable requirements are Non-Goals, and they are permissive:

- `prd.md:462-464` — "No high-availability guarantee for the product itself …
  Removes redundancy, failover and uptime targets from scope."
- `prd.md:467-468` — "No horizontal scale beyond a single machine."
- `prd.md:438-442` — "the product is standalone and must not connect to any
  project pipeline or deployment process."

That last one is worth pausing on: it forbids the *product* integrating with a
client's deployment pipeline. It does not forbid this repo having its own CI. But
a plan should say so explicitly rather than leave the tension unremarked.

## Open Questions

1. **How does schema reach a fresh database?** The blocking decision. Ship
   `drizzle-kit` into the runtime image, generate real migrations, or keep schema
   delivery outside the container entirely. Note that generating migrations is a
   change to a standing project-wide property, not a container detail.
2. **Does compose run the app at all, or only Postgres?** Running `next dev` in
   compose against a bind mount collides with a host dev server (observed). Options:
   compose provides only Postgres and the app stays on the host; or the app service
   runs production mode; or it exists but is opt-in via a profile.
3. **What happens to `scripts/db.mjs`?** Compose could replace it, wrap it, or sit
   beside it. It must keep working from PowerShell either way — that is why it
   exists.
4. **Is `engines` added here?** The Node floor is currently implicit and set by
   unflagged TypeScript stripping in the seed scripts.
5. **Which host, concretely?** Inherited, still owned by the user, still
   unanswered — and deliberately deferred by this slice's scope, which is what
   makes leaving it open safe.
