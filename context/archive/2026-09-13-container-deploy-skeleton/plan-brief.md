# Container Deploy Skeleton — Plan Brief

> Full plan: `context/changes/container-deploy-skeleton/plan.md`
> Research: `context/changes/container-deploy-skeleton/research.md`

## What & Why

Sitesmith Studio runs only on a developer laptop. F-02 makes it build and run as
a container image — the first half of "runs on a persistent host", with the host
itself deliberately deferred to S-13. The reason to do the container half now and
the host half later is the roadmap item's own risk note: a deployment built
before anything needs deploying is maintained through months of change for no
return.

## Starting Point

The runtime surface is already container-shaped: three environment variables, no
filesystem writes, one headless Chromium per run measured sequentially, crawls as
in-process background work with a boot-time sweep that closes runs a dead process
left open. Nothing about the app fights containerisation.

What is missing is everything around it — no Dockerfile, no composition, no CI,
`output: "standalone"` unset — plus two traps. Schema reaches a database only via
`drizzle-kit push`, which is a devDependency a production install drops. And a
failed `chromium.launch()` is caught and degraded rather than thrown, so an image
with no working browser boots, serves and crawls while silently measuring nothing.

## Desired End State

One command builds the image and verifies it end to end: the composition brings
up Postgres and the app, migrations apply to an empty database, the app serves,
and a real Chromium launches inside the container and returns a real page
measurement. The same command is what CI calls. Removing Chromium from the image
makes it fail.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Schema delivery | Generate migrations, apply via `drizzle-orm`'s migrator | `drizzle-orm` is already a runtime dependency, so nothing dev-only enters the image — and it sidesteps the `drizzle.config.ts → ~/env → AUTH_SECRET` trap | Plan |
| Scope of that change | Convert dev, integration and e2e too; retire `db:push` | One mechanism means the schema tests validate is the schema the container applies | Plan |
| Composition shape | Postgres by default, app behind a profile | Keeps the daily loop fast while still proving the image runs; production mode avoids the `next dev` project-directory collision | Plan |
| Build output | `output: "standalone"`, final stage on the Playwright base | Small app layer; Chromium comes from the base layer, which `@vercel/nft` was never going to trace anyway | Plan |
| Chromium proof | Positive assertions at two depths | The app degrades silently by design, so "no errors" is worthless as a deployment signal | Research |
| Smoke trigger | `renderSample` called inside the app container | Reaches the real launch site with no auth, project or crawl, so the check has one reason to fail | Plan review |
| Verification env | compose supplies throwaway values for both required vars | `.env` is gitignored and absent in CI, so `image:verify` needs its own source to behave identically in both places | Plan review |
| CI | Verification script now, thin workflow that calls it | No git remote exists — the logic is verified locally, the YAML is not | Plan |
| `scripts/db.mjs` | Kept as the entry point, rewritten to drive compose | Preserves the Docker-binary discovery and PowerShell-safe errors it exists for | Plan |
| Graceful shutdown | Out of scope | The boot sweep already recovers stale runs; a SIGTERM hook can't be verified without a host | Plan |

## Scope

**In scope:** Dockerfile and `.dockerignore`; `output: "standalone"`; `engines`;
generated migrations and a migrate runner; conversion of dev and both test
harnesses off `push`; `compose.yaml`; `scripts/db.mjs` rewrite; two container
checks; an `image:verify` command; an unexecuted CI workflow.

**Out of scope:** Choosing or provisioning a host; creating a git remote;
registry, secrets, TLS; graceful SIGTERM handling; any crawl, render, findings or
UI code; volumes for application data; multi-replica concerns; observability.

## Architecture / Approach

A two-stage build: Next builds to `.next/standalone` in a build stage, and the
final stage is the version-matched Playwright image so Chromium and its system
libraries arrive from a layer that is already correct. The entrypoint applies
migrations and then execs the server — refusing to start rather than serving
against an unmigrated database. Compose provides Postgres for both the container
and the host-side dev and test loops, which already derive three database names
from one `DATABASE_URL`.

Verification is layered on purpose: one check proves the browser binary works in
the final image, a second proves the application's own render path reaches it.
The first failing points at the Dockerfile; the second failing alone points at
the app.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema on migrations | `drizzle/` committed, a migrate runner, all four contexts converted | Changes a project-wide property; generated schema must match what `push` produced |
| 2. The image | Dockerfile, `.dockerignore`, standalone output, `engines`, entrypoint, browser check | Standalone traces only what Next imports — scripts, `drizzle/` and static assets must all be copied explicitly |
| 3. The composition | `compose.yaml`, `scripts/db.mjs` rewritten onto compose | Compose Postgres must keep `CREATEDB` or both test suites break |
| 4. Proof and CI glue | End-to-end smoke, `image:verify`, workflow | Reaching an app-internal module from a standalone build |

**Prerequisites:** Docker running locally. Nothing else — F-02 depends on no
other roadmap item.
**Estimated effort:** ~3-4 sessions, one per phase, with Phase 1 the largest
because it reaches outside the container.

## Open Risks & Assumptions

- The Playwright base image's bundled Node must satisfy the 22.18+ floor that
  unflagged TypeScript stripping in the seed scripts imposes. Verified at
  implementation, not assumed.
- Existing developer databases must be dropped, recreated and re-seeded — drizzle's
  journal has no record of how their tables got there. The data is disposable and
  both seed scripts exist, so this is cheap, but it is a step not a no-op.
- `playwright`'s npm package must be traced into the standalone output. It is
  imported from one place so it should be, but the package resolves browsers
  through filesystem paths — the pattern the tracer handles worst. Checked in
  Phase 2 rather than assumed.
- The CI workflow ships unexecuted. Registry auth, permissions and syntax errors
  stay latent until a remote exists.
- **F-02 must not close as `done` when this archives.** Two clauses are unmet:
  the persistent host, and CI that has actually run. Decide at archive time
  whether F-02 stays open or splits.

## Success Criteria (Summary)

- A fresh checkout with Docker running reaches a working containerised app in one
  command, with no manual schema step.
- The container demonstrably renders a page with a real browser — asserted
  positively, so a silently broken image fails.
- The daily development loop and both test suites work unchanged against the
  composition, from PowerShell as well as bash.
