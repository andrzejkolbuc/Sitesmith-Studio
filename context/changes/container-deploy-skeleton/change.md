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
