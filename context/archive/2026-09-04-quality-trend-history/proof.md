# Real-site proof — quality trend history

The grid populated from a real client project, read by hand, on 2026-09-05.

## The project

**Tecalliance** — `https://www.tecalliance.net/`, scoped to `/` and `/company`,
expected locale `en`. Two pages, about seven seconds a run. Chosen because it is
the cheapest real target the account has: a full run costs the client's site two
requests.

Project id `a03c07cc-0f5b-499a-a7bc-fd5c9fff43df`.

## The two plotted runs

| Run                                    | Started (local)  | Pages | Findings | Complete | Rules recorded |
| -------------------------------------- | ---------------- | ----- | -------- | -------- | -------------- |
| `9e27c95e-961e-45cc-bd8e-9c73c63bb6b9`  | 2026-09-05 08:15 | 2     | 1        | yes      | 24             |
| `d7fe42fb-ecca-47fe-821f-e3257b789f1f`  | 2026-09-05 16:31 | 2     | 1        | yes      | 24             |

Both ran under the same scope snapshot
(`includePaths: ["/", "/company"]`, `excludePaths: []`, `locales: ["en"]`), both
completed without hitting the page ceiling, and both recorded the same 24-rule
set. Nothing about the site was touched between them.

## The grid as rendered

```
Trend                                                    2 comparable checks

CHECK                                              5 wrz      5 wrz
                                                   08:15      16:31
Pages missing a title or description                   1          1
Canonical tags that disagree                           0          0
Pages declaring no canonical URL                       0          0
Canonical pointing somewhere broken                    0          0
Certificate problems                                   0          0
One page's content at several URLs                     0          0
Variants that do not contain the same things           0          0
Content that was never translated                      0          0
Language links that disagree                           0          0
Declared variant is broken                             0          0
Declared variant was never reached                     0          0
Links to a page that does not load                     0          0
Links to other sites that are gone                     0          0
One title or description on several pages              0          0

and 10 more checks that have not changed

Only checks run under the same settings appear here, so a change in a row
describes the site rather than a change we made.
```

Every row is flat, which is the whole test: the site did not change between the
two runs, so the product must claim it did not change.

## Is every plotted cell attributable to the site?

Yes, for these two runs, and the check is cheap to make here because there is
only one non-zero cell.

- **`Pages missing a title or description` = 1, both runs.** The finding is
  `metadata_missing` on `https://www.tecalliance.net/company`, field
  `description`. That page publishes no meta description. This is the site's own
  assertion — its markup, or the absence of it — and not an inference of ours.
- **The zeros.** Twenty-three rules ran and found nothing. Each zero says "this
  rule was part of both runs and neither run produced a finding", which is a
  claim about the site under a rule that demonstrably ran, not about our
  coverage. Both runs carry the same recorded rule set, so no cell in this grid
  is *not checked* — the case where a zero would have been a lie about us does
  not arise here.
- **No cell is a claim we cannot trace.** There is no derived index, no score,
  and no cell whose value depends on how we collected the data rather than on
  what the site published.

## Runs excluded, and why

The project has **ten** runs. **Eight** are not plotted.

| Run                    | Started          | Why excluded                                   |
| ---------------------- | ---------------- | ---------------------------------------------- |
| `ab973f4b` interrupted | 2026-09-04 08:36 | `not_recorded` — predates the S-07 columns      |
| `f6acd038`             | 2026-09-04 09:11 | `not_recorded` — predates the S-07 columns      |
| `72173488`             | 2026-09-04 09:38 | `not_recorded` — predates the S-07 columns      |
| `267dde13`             | 2026-09-04 09:39 | `not_recorded` — predates the S-07 columns      |
| `e9e0fe05`             | 2026-09-04 14:42 | `not_recorded` — no `ruleSet` (predates S-12 p1) |
| `b8ccd9db`             | 2026-09-04 14:42 | `not_recorded` — no `ruleSet`; also `/company` only |
| `eee32fc5`             | 2026-09-04 14:44 | `not_recorded` — no `ruleSet` (predates S-12 p1) |
| `82cb8472`             | 2026-09-04 14:46 | `not_recorded` — no `ruleSet` (predates S-12 p1) |

Nothing was backfilled, which is the decision the plan made and S-07 made before
it: we do not know which rules produced those runs, and inventing an answer would
be exactly the claim about ourselves that the column exists to prevent. Eight of
ten excluded is the expected shape on the day this ships, and it decays — every
run from here on qualifies.

Worth noting that `ab973f4b` is the interrupted 472-page run. It is excluded
twice over, and under the reference rule the plan was amended with (see below) a
future interrupted run drops out of the series without taking the series with it.

## Two things the proof changed

1. **Reference selection.** The plan had the aggregate take the newest run as the
   reference. A run is not comparable to itself when it was truncated, so a
   single interrupted crawl would have emptied a project's whole trend. The
   reference is now the most recent run that is sound on its own terms — still
   `comparability()` and not a second definition. Decided with the user during
   Phase 3.
2. **Same-day column headers.** Read by hand, both columns of this very grid
   said `5 wrz` and nothing else: two checks on one day are the ordinary case,
   and the reader could not tell the columns apart or match them to the run
   history above. The header now carries the time under the date, in the
   run history's own format. Found here, fixed here.

## Verdict

The grid says what it should about a site nobody touched: nothing moved. The one
non-zero row is traceable to a page that publishes no meta description. The eight
excluded runs are excluded for reasons the product can name, and the section says
so rather than showing an empty frame.

FR-039 is recorded in `context/foundation/roadmap.md` as **partly met** — the
issue-counts half — with S-06 named as the prerequisite for the scores half.
