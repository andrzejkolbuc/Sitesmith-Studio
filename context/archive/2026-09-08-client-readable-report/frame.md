# Frame Brief: Client-readable report (S-11)

> Framing step before /10x-plan. This document captures what is *actually*
> at issue, separated from what was initially assumed.

## Reported Observation

From `context/foundation/roadmap.md:284-293`, S-11 / FR-041:

> "User can generate a report from a stored run that a non-technical client contact can read."

Marked nice-to-have. Prerequisites recorded as S-09 and S-10, both now done.
Unknowns recorded as "—". Risk note flags "a second vocabulary — findings
written for someone who does not read HTTP status codes."

## Initial Framing (preserved)

- **User's stated cause or approach**: S-11 is one slice — a reporting/presentation
  layer over content that already exists, unblocked and ready to build.
- **User's proposed direction**: build it next; the change folder was opened and
  researched against this reading.
- **Pre-dispatch narrowing**: the leading gap is **the artifact** — "nothing leaves
  the app… the current words might be fine". **Nobody has asked for it** — "anticipated,
  not observed". Among content gaps, only **per-finding wording** would make it not
  worth shipping; the correlated-problem explanation layer and finding ranking
  explicitly would not.

## Dimension Map

1. **Demand** — the framing assumes a client wants a handed-over artifact.
2. **Delivery** — nothing leaves the app; assumes the artifact must be *generated*
   server-side (PDF pipeline, standalone HTML, tokenised link).   ← initial framing
3. **Vocabulary** — per-finding wording leaks status codes, header names, `hreflang`,
   `robots.txt`; assumes a parallel client vocabulary is required.
4. **Prerequisite** — the roadmap says S-11 needs S-09 "so the report describes
   explained problems" and S-10 "so there is a client identity to scope it to".
5. **Durability** — a handed-over artifact is a point-in-time claim that outlives its
   data and cannot caveat itself afterwards.

## Hypothesis Investigation

| Hypothesis | Evidence | Verdict |
| --- | --- | --- |
| **1. Demand** — a real, observed need is driving this | User: nobody has asked; anticipated only. `prd.md:302` demotes FR-041 to nice-to-have; `prd.md:86` records "I can hand a client a credible report without extra work" **declined** as a primary success criterion | **NONE** |
| **2. Delivery** — the artifact must be generated server-side | FALSE as stated. View is one linear column, no tabs/virtualisation (`run-panel.tsx:314-503`); settled runs are static, polling stops off-active (`run-panel.tsx:180-186`); design system is already ink-on-paper, no dark mode (`globals.css:24-44`); Next has no print opinion — a print stylesheet is ordinary CSS in an already-global file (`src/app/layout.tsx:1`). **But** snapshot images and the difference view are behind React state (`visual-panel.tsx:330-331,401`) so a default print contains **zero pictures**, and five truncation caps are computed in TS before render (`summarise.ts:17`, `parity.ts:57`, `trend.ts:143,152`) | **WEAK** (mechanism cheap; assumption false) |
| **3. Vocabulary** — per-finding wording blocks a client reader | Type labels are central and already near-lay (`finding-labels.ts:9-40`). The technical register lives in an 845-line, 29-case inline-JSX switch (`run-panel.tsx:944-1789`) with a default case that prints raw JSON (`:1783`); ~2/3 of cases leak status codes, header names, pixel geometry | **STRONG** |
| **4. Prerequisite** — S-09 and S-10 gate this slice | **S-09 NOT REQUIRED.** It supplies grouping, not explanation; `roadmap.md:386` parks explanation entirely. Its only prose is three sentences that *refuse* to name a defect (`run-panel.tsx:671-682`), and "page family" is jargon S-09 introduces. The view already degrades cleanly to the raw list (`run-panel.tsx:435-449`). **S-10 NOT REQUIRED** for a file the Owner hands over: `assertProjectAccess` is a no-op on the Owner path (`trpc.ts:303-324`, Owner has `assignedProjectIds === null`); the Owner read path is F-01's `tenantProcedure`/`tenantScope`. S-10 is **REAL** only for the in-app-page or shared-link shapes | **STRONG** (against the stated dependency) |
| **5. Durability** — an artifact asserts what the data cannot support | **Verified directly.** `reachedPageLimit` appears in **zero** `.tsx` files — no reader-facing surface at all. `run.ts:594` sets status `DONE` unless `abortedReason`, which a ceiling hit does not set, so a truncated run is badged **"Complete"** (`run-panel.tsx:40`) while `run.ts:290` marks `crawlComplete: false`, silencing rules across 24 gates in `findings.ts` — including the north-star `missing_locale` (`findings.ts:350`) | **STRONG** |

## Narrowing Signals

- **"Nobody has asked."** Combined with `prd.md:86` (criterion declined) and FR-041's
  nice-to-have status, dimension 1 has no supporting evidence. This does not forbid
  building it; it caps what it should cost.
- **"The artifact, not the audience"** — and the print investigation showed the artifact
  is the *cheap* half. The framing's hidden assumption ("generate" implies a server-side
  pipeline) is what made this look expensive.
- **Explanation and ranking are not deal-breakers.** This retires both hidden slices the
  research flagged, and simultaneously removes the roadmap's stated reason for depending
  on S-09.
- **Tension worth recording**: the user said current words "might be fine" (Q1) but also
  that per-finding wording is the one content gap that would sink it (Q3). Read together:
  wording is necessary but not the *leading* gap. The plan should not treat "reword 29
  finding types" as the whole slice.
- **`findings.ts:516` records a real prior incident** in its own comment: a 20-page
  truncated run produced eighteen findings naming pages that return 200 — "the tool
  reported its own limit as the client's defect." That is this exact failure, already
  observed once, and the fix was to silence the rule — which is what makes a truncated
  run look *cleaner*.

## Cross-System Convention

The codebase already solved this problem — for the *sampled* subsystems only. Rendering
and visual comparison both state their coverage in the reader's face:
`performance.ts:78-83` ("Never 'no problems found': that sentence, on a section that
looked at twelve pages of five hundred, is the product overstating what it did"),
`visual.ts:11-16` ("a visual section reading 'no problems found' on a project nobody has
told what the site should look like would be the product's most confident lie"),
`retention.ts:66-71` (expired snapshots update rather than delete, so "expired" stays
distinguishable from "never taken").

The **crawl** has no equivalent, because `crawlComplete` and `reachedPageLimit` were added
to serve `comparability()` (`comparison.ts:78-127`), which needs a *pair* of runs. A
single-run artifact has no pair and inherits none of it. The leading hypothesis matches
the convention the product already holds itself to everywhere else — it is being applied
where it was skipped, not invented.

Two further properties make the existing disclosures non-portable: they are **sectional**
(each panel carries its own coverage line, which works only because the reader sees all
sections at once) and they are written in an **operator register** ("No browser was
available during this run") that is meaningless or alarming to a client contact.

## Reframed Problem Statement

> **The actual problem to plan around is**: the product cannot state, at run level and in
> a client's register, what it actually checked — so any artifact that leaves the app will
> confidently understate the client's problems.

Producing an artifact is the cheap part (a print stylesheet, plus opening two
interaction-gated regions). Rewording findings is real but bounded. The unaddressed part
is that a handed-over report strips away the co-located, operator-register, section-level
coverage statements that currently keep the in-app view honest — while the crawl-level
coverage facts have no reader surface at all. A run that hit the 2,000-page ceiling reads
"Complete", fires fewer rules, and would produce a *shorter, cleaner* report. That is
`lessons.md`'s first rule inverted: the absence of a finding becomes a claim about us that
the artifact presents as a claim about them, to the reader least equipped to notice.

The initial framing was not wrong about the gap — nothing does leave the app. It was wrong
about the cost centre, and about what blocks the slice.

## Confidence

**HIGH.** The load-bearing claim was verified directly in this session, not taken from a
sub-agent: `reachedPageLimit` has zero `.tsx` references, `run.ts:594` badges a ceiling hit
`DONE`, and `run.ts:290` marks it `crawlComplete: false`. Two independent agents reached
consistent conclusions on the vocabulary and correlation findings without being shown each
other's work. The reframe matches a convention the codebase already states four times in
its own comments.

## What Changes for /10x-plan

Plan the **run-level coverage statement** first — it is the precondition for any artifact
leaving the app, and it improves the signed-in view on the way past. Then per-finding
vocabulary, then delivery as a print stylesheet plus an expand-before-print fix. Drop S-09
and S-10 as prerequisites for the artifact shape; they bind only if the report becomes a
route. Given no observed demand, scope this as a small slice, not a reporting subsystem —
and do not plan a ranking dimension or a correlated-problem explanation layer, both of
which the user has explicitly excluded.

## References

- Source: `src/server/crawl/run.ts:290,594,600`; `src/server/crawl/findings.ts:350,516`;
  `src/server/crawl/comparison.ts:78-127`; `src/server/crawl/retention.ts:66-71`
- Disclosure convention: `src/app/(app)/projects/[id]/performance.ts:78-83`;
  `src/app/(app)/projects/[id]/visual.ts:11-16`
- Delivery: `src/app/(app)/projects/[id]/run-panel.tsx:314-503,180-186`;
  `src/app/(app)/projects/[id]/visual-panel.tsx:330-331,401`; `src/styles/globals.css:24-44`
- Prerequisites: `src/server/api/trpc.ts:303-324`;
  `src/app/(app)/projects/[id]/correlate.ts:129-254`; `context/foundation/roadmap.md:289-293,386`
- Related research: `context/changes/client-readable-report/research.md`
- Investigation: 2 rounds, 6 read-only sub-agents (run data model, finding vocabulary,
  access and isolation, delivery mechanics; then print-path viability, prerequisite and
  durability)
