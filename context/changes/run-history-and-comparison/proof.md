# Run comparison against real client sites

Phase 5 of `plan.md`. The fixture proves the mechanism; this is the part that
decides whether the slice is honest. The load-bearing assertion is the negative
one: two runs over a site nobody changed must report nothing as new and nothing
as resolved.

Runs were driven at each project's own stored pacing — two requests at a time,
500ms apart — through the same `runToCompletion` path the interface uses.

## yazaki-emea.com — two consecutive runs, nothing changed between them

| | run 1 | run 2 |
| --- | --- | --- |
| run id | `547cac73` | `68770541` |
| status | done | done |
| pages crawled | 533 | 533 |
| findings | 67 | 67 |
| `crawlComplete` | true | true |
| `reachedPageLimit` | false | false |
| duration | 354s | 355s |
| scope | `{locales: [en, de], includePaths: [], excludePaths: []}` | identical |

**Comparability:** `{ comparable: true }`

**Result:** 67 findings, **67 still present, 0 new, 0 resolved.**

Nothing was reported as changed, so there is nothing to explain and criterion
5.6 is satisfied vacuously — which is the outcome that was wanted. Across 533
pages, 24 rule types and 67 findings on a site with ten language variants, the
comparison invented no change at all. Every field the identity projection
excludes as observation or population — link counts, HTTP statuses, member
lists, certificate dates — held its finding still.

The duration difference between the two runs was one second, and the pacing was
the projects' stored defaults throughout, so criterion 5.8 holds: the runs are
indistinguishable from any previous crawl of this site from the site's side.

## tecalliance.net — the scope-change refusal

The incident this guard exists for, reproduced deliberately: on 2026-09-04 this
project's `includePaths` were narrowed and its page count collapsed from 472 to
2. A comparison that ignored the change would have called several hundred
findings fixed.

| | run 1 | run 2 |
| --- | --- | --- |
| run id | `e9e0fe05` | `b8ccd9db` |
| pages / findings | 2 / 1 | 2 / 1 |
| `crawlComplete` | true | true |
| scope `includePaths` | `["/", "/company"]` | `["/company"]` |

**Comparability:** `{ comparable: false, reason: "scope_changed" }`

The project's `includePaths` were restored to `["/", "/company"]` afterwards.

**One thing this pair does not show.** Because the project was already narrowed
before the test, narrowing it further changed the page count from 2 to 2, and a
diff ignoring the guard would have reported **0 resolved, 0 new** here. The
guard is proven to fire on a scope change; the magnitude of the harm it prevents
is not demonstrated by this particular pair. The 472 → 2 collapse that motivated
it is recorded in the session that found it, not reproduced here — reproducing
it would have meant a full-site crawl of a client site to prove a point the
guard already refuses on.

## The interface, at real volume

Read in the browser against the development database.

**yazaki, 533 pages / 67 findings, comparable pair.** No refusal banner, **zero
`New` markers**, no "No longer reported" section, five correlated problems. The
view is quiet in exactly the places the data says nothing changed, which is the
readability property criterion 5.9 asks about: a run where nothing changed does
not look like a run where everything did.

**Pre-comparison runs.** Every run recorded before this slice has null
comparability metadata and renders the `not_recorded` refusal — "The previous
run finished before this check could record what it covered, so there is nothing
safe to compare against. The next run will have a baseline." — with the run's
own findings still listed underneath. This is the no-backfill decision working
as intended on real data.

**Scope-change refusal.** Rendered as "Not compared — the scope changed", with
its sentence, above the run's own findings.

**Comparable pair on Tecalliance.** Two runs at the same scope: no refusal, no
markers, the single standing finding reads as still present.

**Single-run project.** No history list, no refusal, no markers — renders
exactly as it did before this slice.

**Run selection.** Selecting an older run moves the panel's statistics to that
run and re-evaluates the comparison against *its* predecessor. Starting a check
while viewing history clears the selection and follows the new run, and the
start control stays disabled while the latest run is live regardless of what is
being viewed.

## A defect found by this phase

The run history list did not refresh. A row for a crawl in progress is wrong the
moment it is fetched — it reports nought pages of a run that is still counting —
and nothing invalidated the query afterwards, so the row read "Crawling · 0
pages" indefinitely after the run had finished.

Fixed by polling the history off its own data: the interval asks again while the
list itself still shows an active run, and stops once a refetch brings back a
settled row. Keying it on the latest run instead would stop one fetch too early
and leave the stale row on screen.

Found only by watching a real run finish in the browser, which is the argument
for this phase existing.

## Lessons

The real-site runs surfaced no new rule about comparison — they confirmed the
design rather than correcting it, which is why `lessons.md` gains nothing from
this section.

One lesson was captured from the implementation rather than from these runs, and
is recorded in `context/foundation/lessons.md`: an assertion that races the data
it describes passes on the transient state and fails on the settled one. It cost
a bisect here and would recur every time an asynchronous section is added to the
results view.
