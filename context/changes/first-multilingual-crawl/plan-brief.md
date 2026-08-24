# First Multilingual Crawl — Plan Brief

> Full plan: `context/changes/first-multilingual-crawl/plan.md`
> Roadmap item: `context/foundation/roadmap.md` § S-01 (the north star)

## What & Why

Let an Owner define a crawlable project, run a check against it in the background, and see which
pages are missing a language variant. This is the north star: the smallest end-to-end flow whose
success proves the product idea holds, and the first finding it makes that no free tool makes.
It also answers, by measurement, the run-duration question the requirements have been unable to
settle.

## Starting Point

F-01 landed tenancy, sign-in and a read-only project list. Everything the crawl needs is absent:
`projects` has four columns and no notion of a start URL; there are no runs, pages or findings
tables; and nothing in the app can run for longer than a request. The scoping pattern
(`tenantProcedure` + `tenantScope`) and a working test database are inherited and mandatory.

## Desired End State

An Owner creates a project with a start URL and expected locales, triggers a run, and watches it
complete. The run reports which pages are missing one or more language variants, with evidence
for each. The crawl never exceeds its configured request ceiling and stops itself if the target
site starts failing.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Where the crawl runs | In-process background job; run row is the state | No new infrastructure, identical in dev and in the container F-02 will add, and FR-036 needs the run row anyway. | Plan |
| Interrupted runs | Marked `interrupted` on boot | Resuming needs substantial state for a case that should be rare on a single-operator tool. | Plan |
| Protecting the client site | Concurrency cap, inter-request delay, abort on failure burst | NFR-1 is launch-gating and this is the first code to touch someone else's production site. | Plan |
| robots.txt and user-agent | Both declined | Deliberate, not overlooked; recorded so it reads as a decision. | Plan |
| Data model | `runs` + `pages` + `findings` | Findings become first-class immediately, which every later slice reads rather than re-derives. | Plan |
| Variant mapping | Project declares locales; grouping derived per run | Without a declared expectation nothing can be missing — a vanished locale would look like one that never existed. | Plan |
| What "missing" means | All four rules, the fourth narrowed to locale-shaped URLs | Unnarrowed it would fire on every monolingual page, and false-positive fatigue is the named fatal failure. | Plan |
| Discovery | Follow links from the start URL | Finds what a user would reach; sitemap reconciliation is S-04. | Plan |
| UI depth | Minimal: create, trigger, read | Keeps the slice centred on the crawl; forms are addable later without rework. | Plan |
| Testing | Fixture site served in-process | Stubbing fetch would leave concurrency, delay and abort — the NFR-1 machinery — untested. | Plan |

## Scope

**In scope:** project crawl configuration; `runs`/`pages`/`findings` schema; link-following
crawler with politeness controls; hreflang-derived variant grouping; four missing-variant rules;
run lifecycle with on-demand trigger and stale-run sweep; a fixture site; minimal create/trigger/
results UI.

**Out of scope:** robots.txt; distinct user-agent; sitemap discovery; resuming interrupted runs;
every other check type (S-02 to S-06); run comparison (S-07); crawl-config forms; scheduling
(S-13); queue-backed or multi-instance execution.

## Architecture / Approach

A trigger inserts a run row and starts an async task without awaiting it. The crawler walks the
site breadth-first within scope, enforcing a concurrency ceiling and inter-request delay inside
the fetch loop, persisting each page as it goes. When the crawl finishes, grouping runs over the
recorded hreflang declarations and the four rules emit findings. The run row advances through
`queued` → `running` → `done` / `failed` / `interrupted`, and every table carries `tenantId` so
`tenantScope` applies.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Crawl schema | Project config plus runs, pages, findings | Findings shape is guessed slightly ahead of the checks that fill it |
| 2. Crawl engine + fixture | Fetch, discovery, politeness, abort — tested | The only code that can damage a client's site |
| 3. Grouping & findings | The domain rule, in four forms | Real-world hreflang is messier than any fixture |
| 4. Run orchestration | Trigger, background execution, stale sweep | Background work in a framework with no job model |
| 5. Project and results UI | The first visible payoff | Thin by design; easy to over-build |

**Prerequisites:** F-01 (done — tenancy, sign-in, scoped project table), running Postgres
container, working test database.
**Estimated effort:** five phases; phases 2 and 3 carry most of the difficulty. Nothing is
visible until phase 5.

## Open Risks & Assumptions

- **Nothing is visible until phase 5.** Four phases verified only by tests. Deliberate — wiring a
  UI to an unproven crawler means debugging two things at once — but it is the pattern that makes
  side projects feel stalled.
- **hreflang derivation on real sites is unproven.** The roadmap flagged this and it stays open
  until phase 3's manual check. Where derivation fails the failure is itself reportable, so a
  poor result is still a usable result.
- **The rule-4 narrowing is a judgement call.** If real sites still produce unreadable volume,
  the rule needs revisiting before more check types land on top of it. Phase 3's manual criteria
  test exactly this.
- **In-process execution does not survive to multiple instances.** Acceptable now; scheduled runs
  (S-13) may force a queue later.
- **Run duration is unknown and may be bad.** Phase 4 measures it. Do not tune before there is a
  number.

## Success Criteria (Summary)

- An Owner creates a project, triggers a run, and reads real missing-variant findings.
- The crawl stays under its configured ceiling and aborts rather than hammering a failing site.
- A full run against a real client site completes and its duration is recorded.
