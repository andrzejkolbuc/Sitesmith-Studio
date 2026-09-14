# Sitesmith Studio

Post-deploy and pre-go-live checks for the multilingual client sites a freelance
or agency developer maintains but does not own.

The problem it exists for is a size-and-shape mismatch. A portfolio of 3–10
client sites, each roughly 200 pages across 2–6 language variants, is 400–1,200
URLs per project — just above the free ceiling of the tools that would otherwise
check it. And those tools treat every URL as independent, so nothing reports
whether the six language variants of one page are still in sync. Today the check
is a manual spot-check, performed when remembered, repeated per project and per
variant. Because it is manual it is inconsistent, so regressions survive instead
of being caught when they are introduced.

Sitesmith Studio crawls a site you point it at, runs its checks across every
language variant, and reports **one explained problem per underlying cause**
rather than a list of symptoms. That last part is the point of the product. On a
real client site, twenty-four rules reporting honestly and separately produced
sixty-seven list entries for what a person would call five or six problems —
twenty dead links and eight diverged variants that were one broken language
switcher, thirty-four duplicated-metadata findings that were three CMS templates
seen through ten languages. Correlation collapses those back down, grouped by
the site's own hreflang families rather than by anything we guessed.

It also compares each run against the one before it, so a go-live decision is
made against what actually changed rather than against accumulated known state.

**Status: pre-deployment.** It runs locally and in a container; no host is
provisioned and nothing is published to a registry. See
[Running as a container](#running-as-a-container).

---

## Getting started

**You will need** Node ≥ 22.18.0, npm 11.16.0, and Docker (for Postgres).

```bash
npm install
cp .env.example .env
```

Then set `AUTH_SECRET` in `.env` — everything else in the file has a working
local default:

```bash
npx auth secret
```

Start the database and apply the schema:

```bash
npm run db:start && npm run db:migrate
```

Create the first account (see [Accounts](#accounts-and-roles) below for why this
step exists):

```bash
npm run db:seed-owner -- --tenant "Your Studio" --email you@example.com --password "a-long-local-password"
```

Run it:

```bash
npm run dev
```

Open <http://localhost:3000> and sign in with the address and password you just
seeded.

---

## Accounts and roles

**The product is invite-only and has no registration page.** That is a design
decision, not a missing feature: an account always belongs to exactly one
workspace, and the only two ways into one are being seeded as its Owner or
redeeming an invite from that Owner.

So the first account is created from the command line:

```bash
npm run db:seed-owner -- --tenant "Your Studio" --email you@example.com --password "a-long-local-password"
```

Values may also come from `SEED_TENANT` / `SEED_EMAIL` / `SEED_PASSWORD`;
arguments win. Re-running it against an address that already exists **updates
that account's password**, which is also how you recover a local login you have
forgotten.

Everyone else is invited from inside the app. As the Owner, open **People**,
issue an invite, and send the person the link it gives you. The link is composed
in your browser from its own origin, so it is correct at localhost or anywhere
else without configuring a base URL. It **works once, expires in seven days, and
is shown exactly once** — only a digest is stored, so it cannot be shown again.
Revoke it from the same screen if it goes astray. Redeeming it is where the
account comes into being: the invitee sets their own password, minimum 12
characters.

Three roles, fixed:

| Role | Can |
|------|-----|
| **Owner** | Everything in the workspace: create, configure and delete projects, pin baselines, edit masks, invite and assign people. Reaches every project by role, without assignments. |
| **Team member** | Run checks and read results, on the projects they are assigned. Cannot configure a project or manage people. |
| **Client viewer** | Read-only, on the project they were invited to. |

Roles and assignments are read from the database on every request rather than
carried in the session, so demoting or un-assigning someone takes effect
immediately. (Credentials sign-in forces JWT sessions, which cannot be revoked
early — a role baked into the token would stay wrong until it expired.)

---

## Using it

1. **Add a project.** *New project* takes a name, a start URL, and the locales
   the site is expected to publish. Declaring the locales is what makes a
   *missing* variant detectable — without it, a language that vanished entirely
   is indistinguishable from one the site never had.
2. **Set the crawl scope.** Excluded paths are the safety-relevant half: a
   client's admin area, checkout, or anything that does work when fetched has no
   business being crawled. The form covers name, URL and locales; scope and the
   politeness dials live in a script for now:

   ```bash
   npm run db:seed-project -- --tenant "Your Studio" --name "Acme" \
     --start-url https://acme.example --locales en,de,fr \
     --exclude /private,/admin --concurrency 2 --delay 500
   ```

   Defaults are deliberately timid (2 concurrent requests, 500 ms apart). The
   cost of being too slow is a slow run; the cost of being too fast is someone
   else's outage.
3. **Run a check.** Open the project and start a run. Progress updates without a
   reload; one run per project at a time.
4. **Read the report.** Findings arrive grouped by cause and annotated against
   the previous run, so what changed is separated from what was already there.
5. **Pin a baseline** (Owner) once a run represents what the site is supposed to
   look like. Later runs compare their screenshots against it. Use **masks** to
   paint over regions that are volatile by nature — a carousel, an ad slot —
   before the screenshot is ever stored.
6. **Delete a project** (Owner) from the projects list. The row is retained
   internally with a deletion timestamp so run history is never orphaned, but it
   is gone from every surface in the product and cannot be restored from the
   interface.

---

## Tests

```bash
npm run test             # unit + integration
npm run test:unit        # pure logic — needs nothing running
npm run test:integration # needs Postgres
npm run test:e2e         # needs Postgres, browsers, dev server
npm run test:all         # everything
npm run test:watch       # re-run on change
```

The distinction that matters is not speed but *what must be running* — a
contributor with no Docker can still run `test:unit` and get a real signal.
Integration tests use a real Postgres in a `-test` database and refuse to run
against anything else, because they truncate tables.

The risks these suites exist to cover are enumerated in
[`context/foundation/test-plan.md`](context/foundation/test-plan.md), along with
a section on what is deliberately *not* tested.

---

## Database

The development database runs in Docker. From any shell, including PowerShell:

```bash
npm run db:start
```

Then apply the schema:

```bash
npm run db:migrate
```

`npm run db:status` reports what is running, and `npm run db:stop` stops the
container without discarding its data.

`compose.yaml` is the definition; those three commands are the interface, and
they carry diagnostics a bare `docker compose` does not — the Docker binary is
found by absolute path (it is often not on PATH in a shell opened before Docker
was installed), a stopped engine is reported as a sentence rather than a stack
trace, and `DATABASE_URL` is checked against the `POSTGRES_*` variables compose
reads. The connection is stated twice because compose substitutes whole values
and cannot take a URL apart; `db:status` is what stops the two from drifting.

Copy `.env.example` to `.env` before the first start. Every variable compose
reads also has a default in `compose.yaml`, so the composition is valid with no
`.env` at all — which is how CI runs it.

### Changing the schema

Schema is delivered by **committed migrations**, not by pushing a schema at a
database. After editing `src/server/db/schema.ts`:

```bash
npm run db:generate
```

Commit the generated files in `drizzle/` alongside the schema change, then run
`npm run db:migrate` to apply them. A schema edit without a matching generate
will fail the test suites rather than being silently absorbed — that is
deliberate, because the same migrations are what reach a deployed container.

---

## Running as a container

The app builds to an image and runs against the compose Postgres:

```bash
docker compose --profile app up --build
```

It serves on <http://localhost:3100> — deliberately not 3000, so a host
`npm run dev` and the container can run side by side. The image applies the
committed migrations before it starts serving, so a fresh database becomes a
working instance with no extra step.

The base image is `mcr.microsoft.com/playwright`, matched to the pinned
`playwright` version, because the crawler launches a real Chromium and needs its
system libraries to be correct. Two checks prove that rather than assume it:

```bash
docker run --rm sitesmith-studio node scripts/check-browser.mjs
```

asserts a browser launches inside the image, and `scripts/smoke-container.mjs`
asserts the application's own render path reaches one. Both assert a positive
result on purpose — `src/server/crawl/render.ts` degrades rather than crashes
when no browser is available, so an image with a broken Chromium boots, serves
and crawls while silently measuring nothing.

**There is no deployment yet.** No host is provisioned and nothing is published
to a registry; `compose.yaml` is a local composition for development and
verification, not a production topology. Choosing and provisioning a host is a
separate piece of work.

---

## How this project is built

Next.js 16, tRPC, Drizzle, NextAuth and Tailwind, on Postgres — scaffolded from
[create-t3-app](https://create.t3.gg/).

The written foundation lives in [`context/foundation/`](context/foundation/) and
is upstream of the code rather than a description of it:

| Document | What it holds |
|----------|---------------|
| [`prd.md`](context/foundation/prd.md) | Vision, personas, requirements, access control, non-goals, open questions |
| [`shape-notes.md`](context/foundation/shape-notes.md) | The discovery conversation the PRD was written from |
| [`roadmap.md`](context/foundation/roadmap.md) | Ordered, user-visible slices and their status |
| [`test-plan.md`](context/foundation/test-plan.md) | Risk map and phased test rollout |
| [`tech-stack.md`](context/foundation/tech-stack.md) | Why this stack |
| [`lessons.md`](context/foundation/lessons.md) | Patterns worth carrying into future work |

Per-change plans and their reviews live in `context/changes/`, and completed
ones are archived under `context/archive/`.
