---
date: 2026-09-09T01:00:09+02:00
researcher: Andrzej Kolbuc
git_commit: c6b0437615aa544f4a7e727b49ec79c672a2dcf6
branch: master
repository: Sitesmith-Studio
topic: "S-11 client-readable-report: what a report over a stored run would have to be built from"
tags: [research, codebase, reporting, findings-vocabulary, authorization, delivery, s-11]
status: complete
last_updated: 2026-09-09
last_updated_by: Andrzej Kolbuc
---

# Research: S-11 client-readable-report

**Date**: 2026-09-09T01:00:09+02:00
**Researcher**: Andrzej Kolbuc
**Git Commit**: c6b0437615aa544f4a7e727b49ec79c672a2dcf6
**Branch**: master
**Repository**: Sitesmith-Studio

> No git remote is configured, so references below are local paths, not GitHub permalinks.

## Research Question

What exists in the codebase that S-11 ("User can generate a client-readable report from a stored
run", FR-041) must be built from? Scoped by the user to three focus areas — the finding
vocabulary, access and isolation, and the run data model — with the delivery shape left
deliberately open so all three candidates could be costed against real code.

Prior-decision archaeology across `context/archive/` was explicitly **out of scope** for this pass.

## Summary

The slice is buildable, and the authorization half is close to free. The content half is not the
slice the roadmap describes.

Four findings dominate:

1. **A report over a stored run is not currently reproducible.** There is no correlated-problems
   table, no comparison table and no trend table. Correlation runs client-side at read time
   (`src/app/(app)/projects/[id]/correlate.ts`), the run comparison is computed against whichever
   run happens to be the newest older sibling, and snapshot pixels expire after 3 runs. Generating
   "the same report" twice can legitimately produce different content. Whether the report freezes
   its inputs at generation time is a product decision S-11 cannot avoid.

2. **S-11 as scoped quietly contains two further slices.** A client report wants an ordering
   ("your three worst problems") and an explanation ("what is actually wrong"). Neither exists.
   There is no severity, priority or confidence anywhere in `src/`, and correlated problems are
   worded abstractly *on purpose* — naming the defect is the thing the code deliberately refuses
   to do. The roadmap records S-11's Unknowns as "—" (`context/foundation/roadmap.md:292`); that
   is understated.

3. **Authorization needs no new machinery — for one of the three shapes.** An in-app report page
   inherits a three-layer model that already handles Client-viewers correctly. A tokenised
   shareable link does not: it would be this codebase's first bearer credential that survives its
   own first use, against an NFR that names "any shareable link" by hand and calls the commitment
   binary.

4. **The delivery costs are not what the framing assumed.** `playwright` is a **runtime**
   dependency (`package.json:43`) and the app already launches headless Chromium in production
   (`src/server/crawl/render.ts:289`), so a PDF path adds no new dependency and no container
   weight. Its real cost is that no templating engine, no print stylesheet and no way for a
   headless browser to authenticate exist. Meanwhile all three shapes need the same new report
   markup, because 100% of the current rendering lives in client components.

**Recommendation for the plan: build the in-app read surface (Shape A) first.** It is the only
shape that can be built before F-02 (unbuilt, no host provisioned), it introduces no new secret or
security surface, and it produces the report markup that the other two shapes would need anyway.
Doing A first makes B or C cheaper later; doing B or C first does not make A cheaper.

## Detailed Findings

### 1. The run data model — what a report can stand on

**A run is reachable in full from its id.** `runs` carries `projectId`; `pages`, `findings`,
`pageObservations` and `pageSnapshots` all carry `runId` directly
(`src/server/db/schema.ts:341-826`), so nothing needs a join through `pages` to be scoped.

**But four things a report would want are not stored:**

- **No correlated-problems, comparison, trend or visual-baseline table exists.** All are computed
  at read time. Correlation is client-side in a `useMemo`
  (`src/app/(app)/projects/[id]/run-panel.tsx:290-293`), and `correlate.ts` is explicit that this
  is deliberate. The run-to-run comparison is computed per request
  (`src/server/api/routers/project.ts:350-356`) against a predecessor found by ordering, not by a
  stored pointer (`:374-381`) — so backfilling or deleting a run silently changes a past run's
  new/resolved labels.
- **Findings carry no URL** — only `pageId` and a `detail` jsonb (`src/server/crawl/run.ts:541`).
  The view recovers URLs out of `detail` via `evidenceRoles`; `correlate` passes `url: null`
  outright (`src/app/(app)/projects/[id]/correlate.ts:155-159`).
- **Snapshot pixels expire after 3 runs beyond the baseline** (`src/server/crawl/retention.ts:33`,
  fired at `src/server/crawl/run.ts:673-676`). The rows and the `comparison` verdict survive; the
  images do not. A report referencing screenshots is not reproducible later unless it embeds them
  at generation time.
- **No actor.** `runs` has no `triggeredByUserId`; nothing records who started a check.

**Run provenance now exists, and the lessons file predates it.** `runs.ruleSet`
(`src/server/db/schema.ts:413`) stores a sorted array of finding-type discriminators, written in
the run-closing UPDATE (`src/server/crawl/run.ts:620`) and read by `comparability()`
(`src/server/crawl/comparison.ts:87-126`) and the trend grid
(`src/app/(app)/projects/[id]/trend.ts:161-190`) to distinguish "the rule found nothing" from "the
rule did not exist yet". `context/foundation/lessons.md` ("A rule shipping is not the site
changing") states that nothing records which rules produced a run; that describes the state at
S-07 and is now historical. **The rule it states still holds** — and it bites hardest here, because
three limits remain:

- `ruleSet` records rules **declared**, not **exercised**: it is a static constant, so
  `visual_changed` appears even on a run with no baseline. Coverage lives separately in
  `renderSummary` / `visualSummary`, so a report claiming "we checked for X" must read both.
- It cannot detect a **changed** rule — logic and thresholds can be rewritten under an unchanged
  type string. No code version or rule hash is stored anywhere.
- `null` is common and terminal: any crashed, swept or pre-column run is permanently
  non-comparable (`src/server/crawl/run.ts:117-126`, `:691-700`).

**There is no run-level score, and its absence is documented as a decision in four places** —
`src/server/crawl/render.ts:18-20` ("a 0-100 composite is an index this product would be
asserting"), `src/server/crawl/visual.ts:29`,
`src/app/(app)/projects/[id]/performance.ts:49`,
`src/app/(app)/projects/[id]/visual-panel.tsx:209`. The only run-level numbers are `pagesCrawled`
and `findingsCount` (`src/server/db/schema.ts:361-362`). `summarise.ts` is not a summariser — it is
display truncation (`MAX_LISTED = 5`).

**A run view is currently 9 round trips with no server-side assembler**
(`src/app/(app)/projects/[id]/run-panel.tsx:181-293`, plus sub-panel queries). A report needs one
server-side procedure resolving everything from one run id under one access check; nothing like
that exists.

### 2. The finding vocabulary — half-centralised, and the easy half is centralised

**29 finding types**, all declared in `src/server/crawl/findings.ts:30-99` and emitted only from
that file. Detection modules (`content.ts`, `external.ts`, `images.ts`, `tls.ts`, `visual.ts`,
`robots.ts`, `sitemap.ts`, `metadata.ts`) contain zero emit sites — they are observation modules
that feed it. This single-emitter shape is a significant asset.

**Tier 1 — type labels: already central, already close to lay register.**
`src/app/(app)/projects/[id]/finding-labels.ts:9-40` is one exported `Record<string,string>` with
four call sites, each with an `?? type` fallback. Several entries are already client-safe: "Images
that shift the layout as they load", "One page's content at several URLs". A parallel client label
map is hours of work.

**Tier 2 — evidence sentences: scattered, and this is where the technical register lives.** The
`Evidence` component is an **845-line, 29-case inline-JSX switch**
(`src/app/(app)/projects/[id]/run-panel.tsx:944-1789`) with six module-private sub-vocabulary maps
(`:59`, `:69`, `:84`, `:95`, `:101`, `:116`) and a default case that prints raw JSON at the reader
(`:1783`). Roughly two-thirds of cases leak HTTP status codes, header names, `canonical`,
`hreflang`, `robots.txt` or pixel geometry. Verbatim samples:

- `:976-982` — "Declared {locale} version returns {httpStatus}" (renders as "returns 404")
- `:1370` — "This page's canonical is itself not canonical"
- `:1722` — "robots.txt line {n}, in the {userAgentGroup} group"
- `src/app/(app)/projects/[id]/visual.ts:300` — "{n} of {m} compared pixels differ, in {k} regions"

**Two in-repo precedents exist for extracting sentence logic**: `describeVisualChange`
(`src/app/(app)/projects/[id]/visual.ts:266-325`) and the exported `REASON_SENTENCE` /
`REASON_HEADING` tables (`src/app/(app)/projects/[id]/comparison-view.ts:31-53`). `visual.ts:255-258`
records exactly why: "the sentence is a decision, and the one time it was left to the component it
silently printed the raw detail object at a reader." That is the pattern S-11 should follow, and
extracting `Evidence` is worth doing regardless of which delivery shape wins.

**No i18n framework exists** — no `next-intl`, `i18next` or `react-intl`, no locale routing. A
second vocabulary is a new parallel table with no machinery to plug into.

**Correlated problems get three abstract sentences, deliberately.**
`src/app/(app)/projects/[id]/run-panel.tsx:671-683` emits only "One page family emits all of
these" / "The same N page families exhibit all of these" / "The same N page(s) emit all of these".
The header comment at `:658-670` explains the refusal: naming the defect "is our diagnosis rather
than anything the site asserted — so the product stops at what it can stand behind." This is the
`lessons.md` rule "Trace every finding to the site's own assertion" holding in code.

**This is the sharpest tension in S-11.** "The same 4 page families exhibit all of these" is
arguably *less* readable to a client than the raw findings — "page family" is itself jargon. Making
correlated problems client-readable means naming causes, which runs directly into the rule the code
is enforcing on purpose. That is a product decision, not a rewrite, and it is larger than the
vocabulary problem the roadmap flags.

**No severity, priority or confidence exists.** A case-insensitive grep across `src/` returns one
unrelated hit (`parity.ts:84`); the `findings` table has no such column
(`src/server/db/schema.ts:791-820`). The archived `detection-rule-confidence` change is **not** a
confidence field — it was a false-positive discipline phase, and there is nothing to revive. The
only ordinal signals are `FindingStatus` ("new" | "still_present" | "resolved",
`src/server/crawl/comparison.ts:51`) and problem ordering by finding count
(`correlate.ts:240-243`).

### 3. Access and isolation — the model is ready, and it self-enforces

**Three roles**, defined in `src/server/auth/roles.ts:18-45` with predicates (`isOwner`,
`canRunChecks`, `canConfigureProject`) so capability is asked by name. Role lives in `users.role`
with a DB-level default (`src/server/db/schema.ts:101-105`) and is **resolved per request, never
carried in the JWT** — reasoned in three places (`src/server/auth/config.ts:26-35`,
`src/server/api/trpc.ts:41-48`, `src/server/auth/account.ts:19-21`), because JWT sessions cannot be
revoked and "one indexed lookup is the cheaper mistake."

**One choke point resolves tenant, role and assignments** (`src/server/api/trpc.ts:33-96`).
`assignedProjectIds === null` means Owner/unrestricted; `[]` means assigned to nothing — the comment
at `:64-68` names conflating them as "the one mistake in this file that would be silent."

**Every domain read is `tenantProcedure` + `assertProjectAccess` + `tenantScope`.** All 15
procedures in `src/server/api/routers/project.ts` follow it; the only read without
`assertProjectAccess` is `list` (`:57-71`), correctly, since it filters on assignments directly.
`assertProjectAccess` (`src/server/api/trpc.ts:303-324`) throws bare `NOT_FOUND` for both "not
assigned" and "not in tenant", so a Client-viewer cannot learn the agency has other clients.
Reachability is checked before capability (`project.ts:128-134`).

**Unauthenticated surfaces are few and each establishes its own authority.** There is **no
`middleware.ts`** — the auth adapter pulls the Postgres driver, which cannot run in Next's edge
middleware runtime (`src/app/(app)/layout.tsx:30-32`), so the gate is structural via the `(app)`
route group. Outside it: `/`, `/signin`, `/invite/[token]`, the two Auth.js/tRPC handlers, and
`/api/snapshots/[snapshotId]`.

**The snapshot route is the written precedent for any new bytes-out surface**
(`src/app/api/snapshots/[snapshotId]/route.ts:16-30`): it inherits nothing, so it re-derives
session (`:55-57`), tenant from the DB (`:59-63`) and the project-assignment check by hand
(`:103-113`), answers `404` for every refusal (`:37`), and sets `cache-control: private, no-store`
(`:46-49`) so a tenant's client's site does not outlive the session allowed to see it.

**Isolation is enforced by tests that will fail until S-11 declares itself.**
`src/server/api/tenant-isolation.test.ts:415-430` reads `appRouter._def.procedures` and asserts
equality with its `CASES` table — **any new procedure breaks the build until its isolation
behaviour is stated**. A parallel `unreachable` table
(`src/server/api/within-tenant-access.test.ts:70-81`) asserts every project/run-id-taking read
answers `NOT_FOUND`, never `FORBIDDEN`. The snapshot route needed its own describe block
(`tenant-isolation.test.ts:446-620`) precisely because a non-tRPC route is invisible to the
completeness check. `e2e/journeys/partial-account.spec.ts:22-59` walks `src/app/(app)/` on the
filesystem and auto-enrols any new page — **a page placed outside that group is silently exempt.**

### 4. Delivery mechanics — costed against the real repo

**Correction to the framing this research started from:** `playwright` is a **runtime dependency**
(`package.json:43`); only `@playwright/test` is a devDependency (`:54`). The app already launches
headless Chromium in production application code (`src/server/crawl/render.ts:289`), Next
auto-externalises `playwright`
(`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/serverExternalPackages.md:79-80`),
and the roadmap already binds F-02 to shipping Chromium and its system libraries
(`context/foundation/roadmap.md:209-210`). A PDF path therefore adds **0 MB** of new runtime
dependency.

**What all three shapes share.** Eight framework-free pure TypeScript modules in
`src/app/(app)/projects/[id]/` — `correlate.ts`, `summarise.ts`, `finding-labels.ts`, `parity.ts`,
`visual.ts`, `comparison-view.ts`, `performance.ts`, `trend.ts` — each with a test sibling. Every
shape reuses all of them. **No shape reuses any presentation**, because 100% of rendering is in
client components (`run-panel.tsx` 1,829 lines, plus four more, all `"use client"`). New report
markup is unavoidable in A, B and C alike, which equalises much of the cost and makes the delivery
mechanism the real differentiator.

**Next 16.3.1 non-HTML responses**: plain Web `Response` with an explicit `Content-Type`
(`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md:598-620`), and
`ReadableStream` for streaming (`:367-439`). There is no Next-specific download helper;
`Content-Disposition` is a header you set yourself. Route handler params are a Promise in this
version (`01-app/01-getting-started/15-route-handlers.md:191-198`).

**Shape A — in-app read surface. Cheapest by a wide margin.** Reuses the entire auth stack
unchanged; role-conditional UI is an established pattern (`run-panel.tsx:334`,
`visual-panel.tsx:106`, `projects/page.tsx:24`). Must build: one page under `src/app/(app)/`, report
components over `correlate()` output, and the plain-English layer. No blockers. Only product-side
unknowns. It is also the only shape whose cost does not depend on the unbuilt F-02.

**Shape B — downloadable file. Two sub-options, both middling-to-expensive.**
*B1 standalone HTML* must build a server-side HTML generator that **does not exist in any form** —
no templating engine, no `react-dom/server`, nothing (verified by grep). Tailwind 4 is
`@import`-based with build-time extraction (`src/styles/globals.css:1`), so there is no runtime way
to get "the CSS for this markup". Fonts are `next/font/google` self-hosted static assets
(`src/app/layout.tsx:4,22-38`), so a file opened from disk falls back to system fonts unless three
IBM Plex families are base64-inlined. Snapshots come from an auth-gated route, so images must be
omitted or embedded as data URIs.
*B2 PDF via Playwright* needs no new dependency, but needs a `playwright install chromium` build
step that does not exist yet, a launch-failure path mirroring `render.ts:290-296`, a print
stylesheet (**no `@media print`, `@page`, `print:` utility or `window.print()` exists anywhere in
`src/`**), and — the real cost — an **authentication story for the headless browser**. There is no
service account; auth is a cookie/JWT session. Solving it collapses B2 into either B1 or C.

**Shape C — tokenised link. Mechanically cheap, highest risk.** More precedent exists than
expected: `src/app/invite/[token]/page.tsx:14-18` is already a session-less, publicly-openable
route placed outside `(app)` on purpose, and `src/server/auth/invite.ts` is a complete,
well-reasoned token kit — 32 random bytes hex-encoded (`:29,:46-49`), sha256 digest-only storage
(`src/server/db/schema.ts:887-888,:900`), expiry enforced inside the lookup query
(`src/server/auth/accept-invite.ts:47-50`), and consumption and invalidation made the same database
event in one transaction (`:62-101`).

**But the precedent does not actually cover this case.** An invite grants an *account* and is
consumed on first use; a report link would grant *repeated, session-free read access to client
data*. Nothing in this codebase has a token that survives its first use, so there is no revocation
pattern to inherit, and the recorded JWT non-revocability gap
(`src/server/auth/config.ts:111-118`) means a session-free reader cannot be cut off by any existing
mechanism. `context/foundation/prd.md:338-340` names "generated reports, any shareable link" by
hand and calls the commitment binary. C also needs a public base URL env var that does not exist
(`src/env.js:9-37` defines none).

## Code References

- `src/server/db/schema.ts:341-471` — `runs`, incl. `ruleSet:413`, `renderSummary:428`, `visualSummary:457`
- `src/server/db/schema.ts:791-826` — `findings`: `type` + `detail` jsonb, nullable `pageId`, no URL
- `src/server/db/schema.ts:855-903` — invites: digest-only storage, single-use-by-schema
- `src/server/crawl/findings.ts:30-99` — all 29 finding types, single emitter
- `src/server/crawl/run.ts:591-662` — the run-closing UPDATE that writes all six provenance columns
- `src/server/crawl/retention.ts:33,99-101` — snapshot pixels expire after 3 runs
- `src/server/crawl/comparison.ts:87-126` — `comparability()`, `rules_changed` evaluated last
- `src/server/crawl/render.ts:289` — production `chromium.launch()`; `:18-20` refuses a composite score
- `src/server/api/trpc.ts:33-96` — context resolution choke point; `:211-225` `tenantProcedure`; `:303-324` `assertProjectAccess`
- `src/server/api/routers/project.ts:57-650` — all 15 procedures and their guards
- `src/server/auth/roles.ts:18-45` — the three roles and their predicates
- `src/server/auth/invite.ts:29-49` — token minting; `src/server/auth/accept-invite.ts:62-101` — atomic redemption
- `src/app/api/snapshots/[snapshotId]/route.ts:16-117` — the bytes-out precedent, written as policy
- `src/app/(app)/layout.tsx:11-13,30-58` — the structural gate and why there is no middleware
- `src/app/(app)/projects/[id]/run-panel.tsx:671-683` — the three correlated-problem sentences; `:944-1789` — the 845-line Evidence switch
- `src/app/(app)/projects/[id]/finding-labels.ts:9-40` — the central label table
- `src/app/(app)/projects/[id]/correlate.ts:190-194` — the grouping key
- `src/app/(app)/projects/[id]/visual.ts:255-325` — the extraction precedent and its recorded reason
- `src/server/api/tenant-isolation.test.ts:415-430` — the exhaustiveness guard S-11 must satisfy
- `src/server/api/within-tenant-access.test.ts:70-105` — the `NOT_FOUND`-never-`FORBIDDEN` table
- `e2e/journeys/partial-account.spec.ts:22-59` — filesystem route discovery for `(app)` pages

## Architecture Insights

- **The codebase reasons in comments, and those comments are the spec.** Refusals (a composite
  score, naming a defect, storing role in the JWT, conflating `null` with `[]`) are documented at
  the point of code with their reasoning. S-11 should treat them as constraints to argue with
  explicitly, not defaults to drift past.
- **Enforcement is structural wherever possible**: `tenantScope` takes a table so a wrong argument
  fails to compile; the `(app)` route group makes the session gate positional; two test files fail
  the build when a new procedure or page appears without declaring its isolation behaviour.
- **Read-time computation is a deliberate stance.** Correlation, comparison and trend are all
  derived rather than stored, so the product can improve its rule without rewriting history. A
  *report* is the first feature that wants the opposite — a fixed artefact — and that tension is
  the architectural heart of this slice.
- **One emitter, one label table, one evidence decoder** (`evidenceRoles`, deliberately
  import-free so it can cross to the client bundle) means the content layer has clean seams in
  principle; the 845-line JSX switch is the one place that violates it.

## Historical Context (from prior changes)

Deliberately out of scope for this pass — the user scoped research to vocabulary, isolation and the
run data model. Only what surfaced incidentally is recorded here:

- `context/foundation/lessons.md` — "A rule shipping is not the site changing" predates
  `runs.ruleSet`; the problem statement is historical, the rule still binds. "Trace every finding
  to the site's own assertion" is actively enforced by the correlated-problem wording.
- `context/archive/2026-08-25-detection-rule-confidence/change.md:1-30` — a false-positive
  discipline phase, **not** a confidence field. Nothing to revive for ranking.
- `context/foundation/roadmap.md:209-210` — records `playwright` as a runtime dependency from S-06
  onward and notes F-02 was proposed before that was true.

Worth a dedicated pass before planning if the correlated-problem explanation layer is in scope:
`2026-09-03-correlated-findings` and `2026-09-04-run-history-and-comparison`.

## Related Research

- `context/changes/roles-invites-and-client-access/` — S-10, the access model this slice rides on
- `context/archive/2026-09-03-correlated-findings/` — S-09, the content this slice reports (not read)
- `context/archive/2026-09-04-run-history-and-comparison/` — S-07, run comparison (not read)

## Open Questions

1. **Which delivery shape?** Research recommends A (in-app) first; A produces the markup B and C
   need, and is the only shape independent of the unbuilt F-02.
2. **Does the report freeze its inputs at generation time?** Correlation and comparison are
   read-time by design. A report that is not reproducible is arguably not a report; freezing
   contradicts the recorded reason they were left unstored. This needs an explicit decision.
3. **Does the report carry a headline number?** A client report is exactly where one gets wanted,
   and the code refuses composite scores in four places with stated reasoning.
4. **Is ranking in S-11 or its own slice?** No severity/priority/confidence exists. A static
   per-type severity map is the cheap version; anything computed is a slice of its own.
5. **How does a client-readable correlated problem get worded without naming a defect the site
   never asserted?** The current three sentences are abstract on purpose. This is the largest
   genuinely open product question in the slice.
6. **What does the report say when the data is partial?** `ruleSet` null, `crawlComplete` false,
   `reachedPageLimit` true, snapshots expired, a run that crashed. The least technical reader is
   the one least equipped to notice a caveat — and `lessons.md` warns specifically against
   reporting our own collection limits as the client's defects.
7. **Host and memory budget** (roadmap Open Question 8, `roadmap.md:370`) — unprovisioned. Blocks
   any judgement on whether a second Chromium can run alongside an in-process crawl (B2).
8. **Public base URL** — no `AUTH_URL`/`APP_URL` exists (`src/env.js:9-37`). Required for C only.
9. **Should the report attribute the run?** No `triggeredByUserId` is stored and it is
   unrecoverable afterwards. If a client-facing report should say who ran the check, that column
   has to land before the runs it describes.
