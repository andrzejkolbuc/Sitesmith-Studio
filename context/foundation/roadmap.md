---
project: "Sitesmith-Studio"
version: 1
status: draft
created: 2026-08-21
updated: 2026-09-05
prd_version: 1
main_goal: market-feedback
top_blocker: capacity
---

# Roadmap: Sitesmith-Studio

> Derived from `context/foundation/prd.md` (v1) + auto-researched codebase baseline.
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

## Vision recap

A freelance or agency developer maintains 3-10 client sites, each roughly 200 pages across
2-6 language variants. After every deploy, and again before every go-live, they need to know
whether anything broke - and today that check is a manual spot-check done when remembered, so
regressions survive for weeks.

Every project in the portfolio sits just above the free ceiling of the tools that could check
it, and the language variants multiply the work in a way per-URL tools do not model. The
product's distinguishing trait - the one thing that, if removed, would make this a rebuild of
tools that already exist - is that it reasons about a page together with its language siblings
and its previous run, and reports one explained problem instead of many symptoms.

## North star

**S-01: User can define a multilingual project, crawl it, and see which pages are missing a
language variant** - the smallest end-to-end flow whose success proves the core product idea
holds, placed as early as its prerequisites allow because everything else only matters if this
works.

> This slice is the validation milestone: it exercises every layer - project setup, crawling at
> real scale, deriving variant relationships from the site's own declarations, reporting a
> finding - and it answers the two questions the PRD could not: whether a full run is fast
> enough to actually get used, and whether variant derivation survives contact with real client
> sites. It also delivers the one capability no free tool provides, so if it fails the product
> has no reason to exist.

## At a glance

> Status `built` means implemented and covered by tests, but not accepted: the
> remaining acceptance criteria need one real client site and cannot be closed
> against a fixture. See `context/changes/first-multilingual-crawl/plan.md`.

| ID   | Change ID                       | Outcome (user can …)                                                          | Prerequisites    | PRD refs                                                                             | Status   |
| ---- | ------------------------------- | ----------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------ | -------- |
| F-01 | tenant-scoped-owner-signin      | (foundation) records are tenant-scoped and an Owner can sign in                | —                | FR-002, FR-009, NFR-2                                                                | done     |
| F-02 | container-deploy-skeleton       | (foundation) the app runs as a container on a persistent host                  | —                | NFR-3                                                                                | ready    |
| S-01 | first-multilingual-crawl        | define a project, crawl it, and see pages missing a language variant           | F-01             | US-01, FR-006, FR-007, FR-008, FR-011, FR-012, FR-013, FR-014, FR-024, FR-036, NFR-1 | built    |
| S-02 | hreflang-and-variant-parity     | see hreflang graph problems and variants that regressed while siblings did not | S-01             | US-01, FR-025, FR-026                                                                | done     |
| S-03 | cross-variant-content-drift     | see content drift between language variants                                    | S-02             | FR-027                                                                               | done     |
| S-04 | crawl-technical-checks          | see broken links, sitemap and robots problems, orphans, duplicates, TLS issues | S-01             | FR-016, FR-017, FR-018, FR-019, FR-020, FR-030                                       | done     |
| S-05 | seo-metadata-checks             | see title, meta, canonical and noindex problems                                | S-01             | FR-021, FR-022, FR-023                                                               | done     |
| S-06 | browser-observed-checks         | see console errors, sampled performance scores, and image weight problems      | S-01             | FR-015, FR-028, FR-029                                                               | proposed |
| S-07 | run-history-and-comparison      | compare a run against the previous one and see only what changed               | S-01             | US-02, FR-037, FR-038                                                                | done     |
| S-08 | visual-regression-baselines     | set a baseline and see which pages changed visually, ignoring volatile regions | S-06, S-07       | US-02, FR-031, FR-032, FR-033, FR-034, FR-035                                        | proposed |
| S-09 | correlated-findings             | see one explained problem per underlying cause instead of many symptoms        | S-02, S-04, S-05 | US-01, FR-040                                                                        | done     |
| S-10 | roles-invites-and-client-access | invite team members and client viewers, scoped to the right projects           | F-01             | FR-001, FR-003, FR-004, FR-005, FR-010, NFR-2                                        | proposed |
| S-11 | client-readable-report          | generate a client-readable report from a stored run                            | S-09, S-10       | FR-041                                                                               | proposed |
| S-12 | quality-trend-history           | see issue counts over time (scores half needs S-06)                            | S-07             | FR-039 (partly)                                                                      | done     |
| S-13 | scheduled-and-staging-runs      | schedule recurring runs and check protected or staging environments            | F-02, S-01       | FR-042, FR-043                                                                       | proposed |
| S-14 | assisted-finding-prioritisation | have findings ranked by which matter most                                      | S-09             | FR-044                                                                               | proposed |

## Streams

Navigation aid - groups items that share a Prerequisites chain. Canonical ordering still lives
in the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme                          | Chain                             | Note                                                                                                 |
| ------ | ------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A      | Multilingual core              | `F-01` → `S-01` → `S-02` → `S-03` | The north star chain. Carries the product's distinguishing trait; every other stream feeds into it.  |
| B      | Crawl-level checks & the rule  | `S-04` / `S-05` → `S-09` → `S-14` | Joins Stream A at `S-01`. `S-04` and `S-05` are independent of each other and of Stream C.           |
| C      | Browser-driven checks          | `S-06` → `S-08`                   | Joins Stream A at `S-01`. `S-06` introduces page rendering; `S-08` is its expensive consumer.        |
| D      | Runs, comparison & trend       | `S-07` → `S-12`                   | Joins Stream A at `S-01`. Needs two stored runs before it demonstrates anything.                     |
| E      | Access, reporting & deployment | `S-10` → `S-11`; `F-02` → `S-13`  | `S-10` joins Stream A at `F-01`; `S-11` also needs `S-09`. `F-02` depends on nothing else.           |

## Baseline

What's already in place in the codebase as of `2026-08-21` (auto-researched, user-confirmed).
Foundations below assume these are present and do NOT re-scaffold them.

- **Frontend:** present - Next 16.3.1, React 19, Tailwind 4, Biome. One scaffold demo page; no product UI.
- **Backend / API:** present - Next route handlers plus tRPC. One demo router; no product endpoints.
- **Data:** present - Drizzle 0.45.2 on Postgres, 5 tables applied to a live container, push-based with no migrations directory. Tables are the Auth.js set plus a scaffold demo; **no domain tables exist**.
- **Auth:** partial - credentials sign-in logic works, but there is no sign-in UI, no role column, and no invite flow.
- **Deploy / infra:** absent - no container definition, no CI workflows. The stack hand-off declares self-hosting as intent, not implementation.
- **Observability:** absent - no logging, tracing or metrics libraries. No PRD requirement demands them, so no foundation opens for this.

## Foundations

### F-01: Tenant-scoped records and Owner sign-in

- **Outcome:** (foundation) every record carries the tenant and project it belongs to, and an Owner can sign in and reach their own data.
- **Change ID:** `tenant-scoped-owner-signin`
- **PRD refs:** FR-002, FR-009, NFR-2
- **Unlocks:** S-01 (project data needs an owner and a tenant to belong to), S-10 (roles and invites extend this model), and the isolation NFR that every later slice inherits.
- **Prerequisites:** —
- **Parallel with:** F-02
- **Blockers:** —
- **Unknowns:** — (the sign-in path already exists and is verified; what is missing is the UI and the scoping)
- **Risk:** Sequenced first because retrofitting tenant scoping onto existing domain tables is a migration, not an edit - and S-01 creates the first domain tables. Deliberately minimal: sign-in screen, tenant and project columns, an Owner able to see their own projects. Roles, invites and client access are S-10, not here. The failure mode to avoid is this expanding into the full account system the PRD warned would cost four weeks before the first page is ever checked.
- **Status:** done

### F-02: Container deploy skeleton

- **Outcome:** (foundation) the application builds and runs as a container on a persistent host, rather than only on a developer laptop.
- **Change ID:** `container-deploy-skeleton`
- **PRD refs:** NFR-3
- **Unlocks:** S-13 (scheduled runs need a process that stays alive when the laptop is closed).
- **Prerequisites:** —
- **Parallel with:** F-01, and every slice in Streams A-D
- **Blockers:** —
- **Unknowns:**
  - Which host, concretely? The stack hand-off says a self-hosted container targeting Azure, but nothing is provisioned. — Owner: user. Block: no.
- **Risk:** Listed as ready because it depends on nothing, but deliberately not recommended first: it unlocks only a nice-to-have. Doing it early means maintaining a deployment through months of change before anything needs deploying. Sequenced here so it is visible, not urgent.
- **Status:** ready

## Slices

### S-01: First multilingual crawl

- **Outcome:** User can define a project with a start URL and crawl scope, run a check against it, and see which pages are missing one or more language variants.
- **Change ID:** `first-multilingual-crawl`
- **PRD refs:** US-01, FR-006, FR-007, FR-008, FR-011, FR-012, FR-013, FR-014, FR-024, FR-036, NFR-1
- **Prerequisites:** F-01
- **Parallel with:** F-02
- **Blockers:** —
- **Unknowns:**
  - How long does a full run of 400-1,200 URLs actually take? — Owner: user. Block: no. This slice is how the question gets answered; the PRD's Open Question 1 asks for a threshold, and a measurement is worth more than a guess.
  - Does deriving variant relationships from a site's own hreflang hold up on real client sites? — Owner: user. Block: no. Where derivation fails, the failure is itself a reportable finding, so a poor result is still a usable result.
- **Risk:** The largest slice on this roadmap, and deliberately so - it is the north star, and a smaller version would not prove anything the free tools do not already do. Politeness (rate and concurrency limits, robots) belongs inside it rather than in a foundation, because this is the first crawl to touch a live client site and NFR-1 says causing an incident is worse than the regression being hunted. Expect `/10x-plan` to split this into more than one change; that is the right outcome, not a sign the slice is wrong.
- **Status:** built

### S-02: hreflang graph and cross-variant parity

- **Outcome:** User can see hreflang declarations that are non-reciprocal, incomplete, or point at dead URLs, and see pages where one language variant regressed while its siblings did not.
- **Change ID:** `hreflang-and-variant-parity`
- **PRD refs:** US-01, FR-025, FR-026
- **Prerequisites:** S-01
- **Parallel with:** S-04, S-05, S-06, S-07, S-10
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Comparative findings are the product's reason to exist, and this is where "one variant is broken, five are fine" becomes a single reported problem rather than six independent URL reports. Sequenced immediately after the north star because it reuses the same variant mapping and adds no new infrastructure.
- **Status:** done

### S-03: Cross-variant content drift

- **Outcome:** User can see where language variants have diverged in substance - very different length, missing sections, or untranslated placeholder text left in production.
- **Change ID:** `cross-variant-content-drift`
- **PRD refs:** FR-027
- **Prerequisites:** S-02
- **Parallel with:** S-04, S-05, S-06, S-07, S-10
- **Blockers:** —
- **Unknowns:** — (resolved 2026-08-31)
  - ~~What counts as drift rather than an honest translation?~~ Answered in PRD Open Question 3: three independent rules in ascending order of noise — untranslated placeholder text, then structural missing sections, then word count last and extreme-only against a family median, requiring three or more members. The noisy signal no longer decides whether the other two are believed.
- **Risk:** Split out of S-02 precisely so this unknown did not block the parity work next to it. The PRD kept this requirement as must-have with the noise objection raised, and it stayed blocked until the objection was answered rather than overruled — planning it before deciding what drift means would have produced a check nobody trusts, which is the guardrail failure the PRD names as fatal. The staged shape is what makes it buildable: rule 1 can be trusted on day one whether or not rule 3 ever earns its keep.
- **Status:** done

### S-04: Crawl-level technical checks

- **Outcome:** User can see broken internal and external links, redirect chains, sitemap and robots problems, orphan pages, duplicate content, and certificate or security-header issues.
- **Change ID:** `crawl-technical-checks`
- **PRD refs:** FR-016, FR-017, FR-018, FR-019, FR-020, FR-030
- **Prerequisites:** S-01
- **Parallel with:** S-02, S-03, S-05, S-06, S-07, S-10
- **Blockers:** —
- **Unknowns:** —
- **Risk:** These checks are the part the PRD's own Socratic record admits is a rebuild of a mature existing tool, and they were kept as must-have with that objection acknowledged and overruled. Sequenced after the differentiator for exactly that reason. They read from data S-01 already collects, so they are cheap once the crawl exists - and they are the most parallelisable work on the roadmap, which matters when capacity is the constraint.
- **Status:** done

### S-05: SEO metadata checks

- **Outcome:** User can see missing, duplicated or out-of-range titles and meta descriptions, canonical tag problems, and pages carrying a noindex directive in production.
- **Change ID:** `seo-metadata-checks`
- **PRD refs:** FR-021, FR-022, FR-023
- **Prerequisites:** S-01
- **Parallel with:** S-02, S-03, S-04, S-06, S-07, S-10
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Small and self-contained; reads from crawled markup S-01 already has. A noindex accidentally shipped to production is among the most expensive regressions a client site can suffer and among the cheapest to detect, so the effort-to-value ratio here is the best on the roadmap.
- **Status:** done

### S-06: Browser-observed checks

- **Outcome:** User can see JavaScript console errors, Core Web Vitals and performance scores for a representative sample of pages, and image weight problems.
- **Change ID:** `browser-observed-checks`
- **PRD refs:** FR-015, FR-028, FR-029
- **Prerequisites:** S-01
- **Parallel with:** S-02, S-03, S-04, S-05, S-07, S-10
- **Blockers:** —
- **Unknowns:**
  - Does adding page rendering to a run break the run-duration property S-01 measured? — Owner: user. Block: no.
- **Risk:** This is where rendering pages in a real browser enters the product, and it is introduced here rather than in a foundation because this is the first slice that needs it. Performance is sampled rather than per-page by explicit PRD decision - measuring every URL would take hours and destroy the primary success criterion. The rendering capability this slice establishes is what makes S-08 possible at all.
- **Status:** proposed

### S-07: Run history and comparison

- **Outcome:** User can view a project's run history and compare a run against the previous one, seeing what changed rather than everything that is wrong.
- **Change ID:** `run-history-and-comparison`
- **PRD refs:** US-02, FR-037, FR-038
- **Prerequisites:** S-01
- **Parallel with:** S-02, S-03, S-04, S-05, S-06, S-10
- **Blockers:** —
- **Unknowns:** —
- **Risk:** The second half of the domain rule - separating what changed from accumulated known state - and the thing that makes a go-live decision possible rather than just a list of problems. Cannot come earlier: it needs at least two stored runs to demonstrate anything. Cheap once S-01 stores runs, since it adds comparison rather than collection.
- **Status:** done

### S-08: Visual regression with baselines

- **Outcome:** User can promote a snapshot to be a project's baseline, see which pages differ from it and where, review differences side by side, and mask volatile regions so they stop reporting.
- **Change ID:** `visual-regression-baselines`
- **PRD refs:** US-02, FR-031, FR-032, FR-033, FR-034, FR-035
- **Prerequisites:** S-06, S-07
- **Parallel with:** S-09, S-10
- **Blockers:** —
- **Unknowns:**
  - ~~How long is a snapshot kept?~~ Answered in PRD Open Question 5: the pinned baseline never expires; beyond it only the three most recent runs keep their images. Retention binds the bytes, not the history.
  - With per-finding muting ruled out, are masked regions enough to keep visual noise tolerable? (Open Question 2) — Owner: user. Block: no.
- **Risk:** The most expensive subsystem in the product and the one most likely to be abandoned, which is why it is sequenced late rather than early despite answering the user's most-stated pain. The retention answer removes the reason it was blocked, but not the reason it is last: it still needs S-06 (rendering) and S-07 (run comparison), neither of which is built.
- **Status:** proposed

### S-09: Correlated findings

- **Outcome:** User can see findings that share an underlying cause reported as one explained problem, rather than as many unrelated symptoms on the same page.
- **Change ID:** `correlated-findings`
- **PRD refs:** US-01, FR-040
- **Prerequisites:** S-02, S-04, S-05
- **Parallel with:** S-08, S-10
- **Blockers:** —
- **Unknowns:**
  - What operationally counts as "the same underlying cause"? The PRD states the rule but not the test for it. — Owner: user. Block: no. This is a design decision to make while planning, not an external dependency.
- **Risk:** This is the domain rule itself - the decision the product makes that no other tool makes for the user. It cannot come earlier because correlation needs several kinds of finding to correlate; with only one check type there is nothing to relate. Sequenced immediately after enough check slices exist to make it meaningful. If this slice does not produce findings that feel smarter than the raw list, the product is a formatter over other tools.
- **Status:** done

### S-10: Roles, invites and client access

- **Outcome:** User can invite a Team-member to the tenant and a Client-viewer to a single project, assign team members to specific projects, and be sure a client sees only their own project.
- **Change ID:** `roles-invites-and-client-access`
- **PRD refs:** FR-001, FR-003, FR-004, FR-005, FR-010, NFR-2
- **Prerequisites:** F-01
- **Parallel with:** S-02, S-03, S-04, S-05, S-06, S-07, S-08, S-09
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Completes the account model F-01 opened. Sequenced deliberately late: no check the product performs needs roles to function, and the PRD flagged account work as the classic way this kind of project spends a month before checking a single page. Fully parallel with every checking slice, so it is available whenever capacity allows without ever sitting on the critical path.
- **Status:** proposed

### S-11: Client-readable report

- **Outcome:** User can generate a report from a stored run that a non-technical client contact can read.
- **Change ID:** `client-readable-report`
- **PRD refs:** FR-041
- **Prerequisites:** S-09, S-10
- **Parallel with:** S-12, S-13, S-14
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Nice-to-have by PRD priority, demoted there because the user declined "hand a client a credible report" as a primary success criterion. Depends on S-09 so the report describes explained problems rather than raw findings, and on S-10 so there is a client identity to scope it to. Worth noting this needs a second vocabulary - findings written for someone who does not read HTTP status codes.
- **Status:** proposed

### S-12: Quality trend history

- **Outcome:** User can see scores and issue counts tracked over time, revealing drift rather than only last-run state.
- **Change ID:** `quality-trend-history`
- **PRD refs:** FR-039 — **partly met.** This slice delivers the issue-counts
  half only. FR-039's "scores" are Core Web Vitals and page performance scores
  (`prd.md:62`, `prd.md:247`), which **S-06 `browser-observed-checks`** produces
  and which does not exist yet. FR-039 must stay open when S-12 closes, and S-06
  is its unrecorded prerequisite for the remainder — the roadmap's original
  prerequisite list for S-12 (S-07 alone) was incomplete for the full
  requirement.
- **Prerequisites:** S-07 (met) — and **S-06 for the scores half**, unbuilt.
- **Parallel with:** S-08, S-09, S-10, S-11, S-13, S-14
- **Blockers:** —
- **Unknowns:**
  - ~~Same retention conflict as S-08.~~ Answered in PRD Open Question 5, and answered generously for this slice: run metadata and findings are rows measured in kilobytes and are kept indefinitely, so the trend this slice draws needs no window at all. Only images expire.
- **Risk:** Was blocked on the same question as S-08, and resolving that one question did promote both — which is why the roadmap called it the highest-leverage open question. What remains is ordinary sequencing: S-07 must exist before there is run history to trend.
- **Status:** done

### S-13: Scheduled and staging runs

- **Outcome:** User can schedule recurring runs for a project without triggering them by hand, and run checks against a staging or password-protected environment before it goes public.
- **Change ID:** `scheduled-and-staging-runs`
- **PRD refs:** FR-042, FR-043
- **Prerequisites:** F-02, S-01
- **Parallel with:** S-08, S-09, S-10, S-11, S-12, S-14
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Needs F-02 because a schedule requires a process that outlives a laptop session. Note the tension the PRD already records: scheduled runs produce results nobody sees unless someone opens the dashboard, and notifications were explicitly declined. The value here is bounded by that decision.
- **Status:** proposed

### S-14: Assisted finding prioritisation

- **Outcome:** User can have findings ranked by which matter most.
- **Change ID:** `assisted-finding-prioritisation`
- **PRD refs:** FR-044
- **Prerequisites:** S-09
- **Parallel with:** S-08, S-10, S-11, S-12, S-13
- **Blockers:** —
- **Unknowns:**
  - ~~What bounds the cost?~~ Answered in PRD Open Question 4: the bound is structural, not monetary. One call per run over S-09's correlated problems rather than raw findings, cached against the run, with a monthly call ceiling as a backstop. Cost scales with runs, not with pages.
- **Risk:** Last by design. The PRD narrowed this from explaining findings and suggesting fixes down to ranking alone, on the reasoning that a finding needing help to explain it is a badly written finding. Depends on S-09 because ranking symptoms is far less useful than ranking explained problems — a dependency the cost answer now leans on, since it is S-09's correlation that keeps the input to tens of items rather than hundreds.
- **Status:** proposed

## Backlog Handoff

| Roadmap ID | Change ID                       | Suggested issue title                                       | Ready for `/10x-plan` | Notes                                          |
| ---------- | ------------------------------- | ----------------------------------------------------------- | --------------------- | ---------------------------------------------- |
| F-01       | tenant-scoped-owner-signin      | Tenant-scoped records and Owner sign-in                     | done                  | Recommended first — unlocks the north star     |
| F-02       | container-deploy-skeleton       | Container deploy skeleton                                   | yes                   | Unlocks only a nice-to-have; not urgent        |
| S-01       | first-multilingual-crawl        | First multilingual crawl with missing-variant findings      | done                  | Needs F-01. The north star                     |
| S-02       | hreflang-and-variant-parity     | hreflang graph validation and cross-variant parity          | done                  | Needs S-01                                     |
| S-03       | cross-variant-content-drift     | Content drift between language variants                     | done                  | Blocked — define drift vs honest translation   |
| S-04       | crawl-technical-checks          | Crawl-level technical checks                                | done                  | Needs S-01. Highly parallelisable              |
| S-05       | seo-metadata-checks             | SEO metadata checks                                         | done                  | Needs S-01. Best effort-to-value ratio         |
| S-06       | browser-observed-checks         | Console errors, sampled performance, image weight           | yes                   | Needs S-01. Introduces page rendering          |
| S-07       | run-history-and-comparison      | Run history and run-over-run comparison                     | done                  | Needs S-01                                     |
| S-08       | visual-regression-baselines     | Visual regression with baselines and masked regions         | no                    | Blocked — snapshot retention window            |
| S-09       | correlated-findings             | Correlated findings — one explained problem per cause       | done                  | Needs S-02, S-04, S-05. The domain rule        |
| S-10       | roles-invites-and-client-access | Roles, invites and client access                            | yes                   | Needs F-01. Parallel with all checking work    |
| S-11       | client-readable-report          | Client-readable report from a stored run                    | no                    | Needs S-09, S-10                               |
| S-12       | quality-trend-history           | Quality trend history                                       | done                  | Needs S-07. Counts half; scores need S-06      |
| S-13       | scheduled-and-staging-runs      | Scheduled runs and staging environments                     | no                    | Needs F-02, S-01                               |
| S-14       | assisted-finding-prioritisation | Assisted finding prioritisation                             | no                    | Blocked — no spend cap defined                 |

## Open Roadmap Questions

1. **What run duration makes the primary criterion testable?** The primary success bar is that a check is "fast enough that it actually gets run", but no threshold was set and the matching requirement was declined. — Owner: user. Block: roadmap-wide (measured by S-01, not decided in advance).
2. **What mechanism delivers the no-false-positive-fatigue guardrail?** Per-finding muting was offered and declined; masked regions cover visual noise only, so every non-visual check must get its signal quality from conservative detection alone. — Owner: user. Block: S-03, S-08, S-09.
3. **Will content drift between variants be noise by default?** Honest translations legitimately differ in length. — Owner: user. Block: S-03.
4. **What bounds the cost of assisted prioritisation?** The only recurring spend in a zero-spend product, and the cap was declined. — Owner: user. Block: S-14.
5. **How long are runs and snapshots kept?** A bounded footprint is required; baselines and trends need history. The window satisfying both is unresolved. — Owner: user. Block: S-08, S-12. *(Highest leverage — resolving this alone promotes two slices.)*
6. **Is full-scope run time compatible with a go-live gate at all?** Crawling 1,200 URLs, rendering pages and sampling performance may be structurally incompatible with a check run casually before every launch. — Owner: user. Block: roadmap-wide (partially answered by S-01, then again by S-06).
7. **What does an unauthenticated visitor see at a gated route?** Unspecified in the PRD. — Owner: user. Block: none — resolve during F-01.
8. **Which host, concretely?** A self-hosted container targeting Azure is declared as intent; nothing is provisioned. — Owner: user. Block: F-02, S-13.

## Parked

- **Content and keyword SEO — rankings, backlinks, keyword research.** Why parked: PRD Non-Goals. The line between a crawler-based auditor and a rank-tracking suite, and the most likely direction for scope to creep.
- **Auto-remediation.** Why parked: PRD Non-Goals. The product reports; it never edits a client site. Also removes write access to client systems from the security surface.
- **Continuous uptime and availability monitoring.** Why parked: PRD Non-Goals. Checks run on demand or on a schedule, never always-on.
- **Real-user monitoring.** Why parked: PRD Non-Goals. Nothing is embedded in client sites.
- **Deployment-pipeline integration.** Why parked: PRD Non-Goals. Stated directly — the product is standalone and must not connect to any deployment process.
- **Notifications and alerting.** Why parked: PRD Non-Goals, declined. Worth revisiting alongside S-13, where scheduled runs produce results nobody is told about.
- **Per-finding muting, accepting or snoozing.** Why parked: PRD Non-Goals, declined. Related to Open Question 2.
- **Accessibility auditing.** Why parked: PRD Non-Goals, declined twice.
- **Third-party script weight tracking.** Why parked: PRD Non-Goals, declined twice.
- **Structured data validation.** Why parked: PRD Non-Goals. Dropped during shaping for permanent maintenance cost.
- **Platform-level multi-agency administration.** Why parked: PRD Non-Goals. The product serves one agency.
- **Public self-serve registration.** Why parked: PRD Non-Goals. Accounts are invite-only.
- **Explanation of findings and fix suggestion.** Why parked: PRD Non-Goals. Narrowed out of FR-044, which now covers ranking only.
- **High availability, compliance certification, horizontal scale, offline capability.** Why parked: PRD non-functional Non-Goals.
- **Observability tooling.** Why parked: no PRD requirement demands it, so no foundation opens for it. Revisit if operating scheduled runs proves opaque.

## Done

- **S-12: User can see scores and issue counts tracked over time, revealing drift rather than only last-run state.** — Archived 2026-09-05 → `context/archive/2026-09-04-quality-trend-history/`. Delivered the issue-counts half only; FR-039 stays open on S-06 for the scores half. Lesson: —.

- **S-07: User can view a project's run history and compare a run against the previous one, seeing what changed rather than everything that is wrong.** — Archived 2026-09-04 → `context/archive/2026-09-04-run-history-and-comparison/`. Lesson: an assertion that races its data passes on the wrong state.

- **S-09: User can see findings that share an underlying cause reported as one explained problem, rather than as many unrelated symptoms on the same page.** — Archived 2026-09-04 → `context/archive/2026-09-03-correlated-findings/`. Lesson: —.

- **S-04: User can see broken internal and external links, redirect chains, sitemap and robots problems, orphan pages, duplicate content, and certificate or security-header issues.** — Archived 2026-09-03 → `context/archive/2026-09-02-crawl-technical-checks/`. Lesson: a threshold that scales with the defect it hunts goes quiet exactly when it matters.

- **S-05: User can see missing, duplicated or out-of-range titles and meta descriptions, canonical tag problems, and pages carrying a noindex directive in production.** — Archived 2026-09-02 → `context/archive/2026-09-01-seo-metadata-checks/`. Lesson: —.

- **S-03: User can see where language variants have diverged in substance - very different length, missing sections, or untranslated placeholder text left in production.** — Archived 2026-09-01 → `context/archive/2026-08-31-cross-variant-content-drift/`. Lesson: —.

- **S-02: hreflang graph and cross-variant parity** — Archived 2026-08-31 → `context/archive/2026-08-25-hreflang-and-variant-parity/`. Lesson: a rule that reasons from absence must know whether the crawl finished.

- **F-01: (foundation) every record carries the tenant and project it belongs to, and an Owner can sign in and reach their own data.** — Archived 2026-08-24 → `context/archive/2026-08-21-tenant-scoped-owner-signin/`. Lesson: —.
