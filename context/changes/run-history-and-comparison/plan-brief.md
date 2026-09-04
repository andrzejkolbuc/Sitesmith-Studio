# Run History and Run-Over-Run Comparison — Plan Brief

> Full plan: `context/changes/run-history-and-comparison/plan.md`
> Research: `context/changes/run-history-and-comparison/research.md`

## What & Why

Roadmap slice **S-07**. A user can view a project's run history and see any run's findings
annotated against the run before it — new, still present, or resolved. This is the second half of
the product's domain rule: S-09 collapses many symptoms into one explained problem, S-07
separates what *changed* from accumulated known state. Together they are what turns a list of
problems into a go-live decision.

## Starting Point

Runs, pages and findings are already stored, and were deliberately stored *for* this slice — the
`findings` table's own doc comment says so. What is missing is identity and trust: a finding has
no key that survives a run boundary, and a run records nothing about whether it can be compared
at all. `execute()` computes crawl completeness and scope narrowing today and throws both away.
The API exposes only `latestRun`, and the test fixture serves a frozen site, so a two-run test is
currently impossible to write.

## Desired End State

The project page lists every run. Selecting one shows its findings, each marked new, still
present, or resolved against its predecessor, with resolved findings in their own section. Where
the two runs were not produced under the same conditions — different scope, a truncated crawl, or
a run predating this feature — no comparison is shown and the view says which precondition
failed.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Diff granularity | Findings, not correlated problems | `CorrelatedProblem.key` resolves through `variantGroupKey`, which shifts when a family's smallest crawled member changes — identity would move for reasons about our crawl | Research |
| Where it computes | Server-side tRPC, per request, never persisted | One round trip instead of two full finding sets; keeps a young rule improvable, per the same reasoning that keeps correlation read-time | Plan |
| Outcomes reported | New / still present / resolved | FR-037 asks for "what changed" in both directions; without "resolved" a user cannot confirm a fix worked | Plan |
| Incomparable runs | Refuse, and name the failed precondition | Matches how every absence-reasoning rule here fails; a warned-but-shown "312 resolved" is the exact shape of the four false-positive incidents in `lessons.md` | Plan |
| Run metadata | Completeness columns + a jsonb scope snapshot | Queryable and explainable — the refusal message needs to name *which* precondition failed, which an opaque hash cannot | Plan |
| Identity fallback | Type + sorted `subject` from `evidenceRoles` | Reuses an exhaustive, tested mapping, so a rule added later gets workable identity rather than a silent gap | Plan |
| Existing runs | Incomparable; no backfill | Their conditions were never observed; the 472 → 2 scope change on a real project is a live counterexample to backfilling from current config | Plan |
| History UI | Run list + adjacent-pair diff | Satisfies FR-038 and FR-037 exactly; arbitrary pair comparison doubles the comparability surface for scope FR-037 does not ask for | Plan |
| Fixture strategy | Request-time overrides layer | Costs nothing to tests that don't use it — the fixture header records six added pages once pushing a politeness test past its timeout | Plan |
| Retention assumption | Unbounded history | PRD Open Question 5 was resolved 2026-08-31: run metadata and findings are kept indefinitely; only snapshots are bounded | Research |

## Scope

**In scope:** run comparability metadata on the run row; a per-type finding identity projection
over all 24 rule types; the comparability guard and diff engine; run history and comparison tRPC
procedures; a fixture that can change between runs; the history list and annotated results view;
real-site proof.

**Out of scope:** arbitrary run-pair comparison; backfilling old runs; persisting the diff;
diffing correlated problems; a durable `page_links` table (S-04's deferral — a findings diff does
not need it); an e2e journey for the two-run flow (the e2e fixture server has no mutation
channel); FR-039 trend history (S-12); finding suppression (PRD Open Question 2, still open).

## Architecture / Approach

Four layers in dependency order. A run records what it did (`crawlComplete`, `reachedPageLimit`,
a `scope` snapshot — all nullable, where null means *not recorded*). A finding gains an identity
derived from what the site asserted, with population and observation metadata excluded — the dead
URL is identity, the pages linking to it are not. A server-side module then decides comparability
and matches two runs' findings on that identity. The view reads one procedure and renders three
states, or the refusal.

The governing principle throughout: a run diff is a claim about two of *our* observations, so
where a difference cannot be attributed to the site it must not be reported at all.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Run comparability metadata | Runs record completeness, ceiling and scope | Nullable-as-silence must not be "fixed" to `notNull` |
| 2. Finding identity across runs | Per-type identity for all 24 types, plus the relocated evidence module | The risk concentrator: a wrongly included field makes a standing problem look resolved |
| 3. The comparison, server-side | Guard, diff, two procedures, mutable fixture | Fixture overrides becoming a second source of truth that drifts from `SITE` |
| 4. Run history and the diff in the view | Run list, three-state annotation, refusal state | Panel polling and run selection interacting badly while a crawl is live |
| 5. Real-site proof | Two runs on a real client site, judged by hand | An unchanged site reporting anything as changed |

**Prerequisites:** none beyond what is shipped; S-01 and S-09 are both in.
**Estimated effort:** ~3–4 sessions across five phases.

## Open Risks & Assumptions

- **Family-level identity inherits `variantGroupKey`'s stability envelope.** Four types key on it,
  and a family that gains or loses its lexicographically smallest crawled member will report those
  findings as resolved and re-raised. Stated as a limit in the module header rather than hidden;
  the alternative (keying on the member set) churns strictly more often.
- **The 24-type identity table is a judgement per type.** Phase 2's stability tests exist to catch
  a wrong call, but a type whose volatile fields were misclassified will fail quietly until a real
  site exercises it — which is why Phase 5 exists.
- **The feature shows nothing until a project has two post-deploy runs.** Accepted as the cost of
  not backfilling.
- **`evidence.ts` must stay dependency-free**, since it is bundled for the client through
  `summarise.ts`. An innocent import from `findings.ts` would pull the crawler into the browser.

## Success Criteria (Summary)

- Two runs over a site nobody changed report zero new and zero resolved findings.
- A page that breaks between runs is reported as exactly one new finding, and its repair as
  exactly one resolved.
- Narrowing a project's crawl scope produces a stated refusal, not a large resolved count.
