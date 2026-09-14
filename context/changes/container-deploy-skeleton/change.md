---
change_id: container-deploy-skeleton
title: Container deploy skeleton — image and local composition, host deferred
status: implementing
created: 2026-09-13
updated: 2026-09-14
archived_at: null
---

## Notes

Roadmap item **F-02** (`NFR-3`), whose stated outcome is "the application builds
and runs as a container on a persistent host, rather than only on a developer
laptop". **This slice deliberately delivers only the first half.**

Scope decided at kickoff, 2026-09-13:

- **Container only; the host is deferred.** A Dockerfile, a local composition and
  a CI image build, proven to run as a container. Provisioning waits for S-13,
  which is the first thing that actually needs a process staying alive when the
  laptop closes. This follows the roadmap item's own Risk note: F-02 unlocks only
  a nice-to-have, and a deployment built now must be maintained through months of
  change before anything needs deploying.
- **Postgres both ways.** One image, two compositions: Postgres in compose for the
  local loop (zero marginal cost, which the PRD's zero-spend constraint wants),
  and a managed instance reached by `DATABASE_URL` in production. The app must not
  know which it is talking to.
- **Official Playwright base image.** `mcr.microsoft.com/playwright`, so Chromium
  and its system libraries are already correct and version-matched. Larger image,
  but the slim-base alternative makes the system-lib list our problem, and S-06
  made `playwright` a runtime dependency rather than a dev one.

**Consequence for the roadmap:** F-02 must NOT be closed as `done` when this
change archives. The persistent-host half is unmet, and S-13 still depends on it.
Either F-02 stays open with the container half recorded, or it is split — decide
at archive time, not now.

Open question inherited from the roadmap, still owned by the user and still
unanswered: *which host, concretely?* The tech stack names a self-hosted container
targeting Azure, but nothing is provisioned. Deferring the host is what makes it
safe to leave that open for now.

## What this slice delivered, and what it did not

Recorded at implementation time so the archive decision about F-02 is made on
facts rather than reconstruction.

**Delivered.** Schema reaches a database by committed migration in every context
— developer shell, integration harness, e2e harness, container entrypoint. A
multi-stage image on the version-matched Playwright base, running as a non-root
user, applying migrations before it serves. A local composition with Postgres
behind a healthcheck and the app behind a profile. Two checks at different
depths, both asserting positive facts: `check-browser.mjs` that a browser
launches inside the image, `smoke-container.mjs` that the application's own
render path reaches one. One command, `npm run image:verify`, that runs the whole
sequence and tears down afterwards.

**Two clauses are unmet, and both are reasons F-02 must not close as `done`:**

1. **No persistent host.** Deferred to S-13 at kickoff, as recorded above. There
   is no provisioned environment, no registry, no secrets management and no TLS
   termination. `compose.yaml` is a local composition for development and
   verification — it is not a deployment and must not be read as one.
2. **The CI workflow ships unexecuted.** `.github/workflows/image.yml` is
   committed and parses, but the repository has no git remote, so it has never
   run and cannot run until one exists. Its correctness is asserted only as far
   as "the YAML is valid and it invokes the same command a developer does".

The roadmap's F-02 says "the application builds and runs as a container **on a
persistent host**". The first half is now demonstrable. The second half is
untouched. Either F-02 stays open with the container half recorded against it,
or it is split — that decision belongs at archive time and this note exists so it
can be made without reopening the question of what was actually built.
