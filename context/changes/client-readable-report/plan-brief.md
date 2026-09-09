# Client-readable report (S-11) — Plan Brief

> Full plan: `context/changes/client-readable-report/plan.md`
> Frame brief: `context/changes/client-readable-report/frame.md`
> Research: `context/changes/client-readable-report/research.md`

## What & Why

> **The problem to plan around**: the product cannot state, at run level and in a client's register,
> what it actually checked — so any artifact that leaves the app will confidently understate the
> client's problems.

A run that stops at the 2,000-page ceiling is badged "Complete", silences rules across 24 gates
including the north-star `missing_locale`, and would therefore produce a *shorter, cleaner-looking*
report. This plan makes coverage explicit first, then builds the artifact on top of it.

## Starting Point

The results view already refuses to overstate coverage in its *sampled* subsystems — rendering and
visual comparison each state what they measured, and say why in code comments. The crawl never got
the same treatment: `crawlComplete` and `reachedPageLimit` exist only to serve run-*pair*
comparability, and `reachedPageLimit` has zero references in any component. Finding vocabulary splits
in two — type labels are already central and near-lay, while the technical register lives in an
845-line inline-JSX switch.

## Desired End State

A signed-in user opening a run sees a plain statement of what the check covered, and a truncated run
says so in the badge. From that run they open a report view written in a second register, print it
from the browser, and hand the PDF to a client contact — with the coverage statement carried into the
document, so the artifact cannot claim more than the check did.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| What problem this slice solves | Coverage disclosure, then the artifact | Producing the artifact is cheap; the unaddressed risk is understating what was checked | Frame |
| Delivery mechanism | Browser print of a report route | No pipeline, dependency, token or env var needed; the app already renders a linear document | Frame |
| Stated prerequisites S-09, S-10 | Dropped | S-09 supplies grouping not explanation; S-10's project check is a no-op on the Owner path | Frame |
| Ranking / severity | Excluded | User excluded it; no ordering axis exists in the data | Frame |
| Correlated-problem explanation | Excluded | Naming a defect the site never asserted is what the code deliberately refuses to do | Frame |
| Coverage statement scope | One run-level block | Creates the single portable statement an artifact needs | Plan |
| The "Complete" badge | Derive the label from completeness | Fixes the misread with no status-enum or comparability change | Plan |
| Second vocabulary depth | Report-only labels + sentences | Bounded to 29 sentences; operator view untouched | Plan |
| Artifact composition | Caps lifted, images in, resolved findings in, operator chrome out | A printed "and 3 more" is unrecoverable; chrome is noise on paper | Plan |
| Shipping | One plan, all phases together | User's call, against the recommendation to ship the correctness fix first | Plan |

## Scope

**In scope:**
- A run-level coverage model derived from existing columns, in operator and client registers
- A truthful status label for a run that stopped at the page ceiling
- A parallel client vocabulary — 29 labels and sentences — with an exhaustiveness guard
- A report route under `(app)` and the print stylesheet

**Out of scope:**
- Severity, ranking, confidence; correlated-problem explanations
- Refactoring the 845-line `Evidence` switch
- PDF pipeline, tokenised link, standalone HTML, new env var
- Any new tRPC procedure or schema change
- Fixing the read-time reproducibility of correlation and comparison

## Architecture / Approach

Three phases in dependency order. Phase 1 adds a pure `coverage.ts` module alongside the existing
`performanceState()` / `visualState()` pattern and renders it on the results page. Phase 2 adds a
parallel `client-vocabulary.ts` with no consumer yet. Phase 3 adds a route under
`src/app/(app)/projects/[id]/report/[runId]/` that renders its **own** tree from the existing
procedures — which is what makes expanded figures and un-capped lists fall out for free instead of
requiring surgery on `visual-panel.tsx`. Authorization is inherited structurally from the `(app)`
layout plus `assertProjectAccess`; no new authorization code is written.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Run coverage statement | Coverage model, honest badge, coverage block on the results page | Treating a `null` column as `false` would produce the exact overstatement the plan exists to prevent |
| 2. Client vocabulary | 29 client labels and sentences, plus client-register coverage | Two vocabularies can drift; mitigated by an exhaustiveness test over `FINDING_TYPES` |
| 3. Report view | Report route, print stylesheet, E2E journey | Print fidelity is only verifiable by hand; the grayscale performance band has no shape fallback today |

**Prerequisites:** None. S-09 and S-10 were investigated and do not bind for this shape. No host or
F-02 dependency — nothing is generated server-side.
**Estimated effort:** ~3 sessions, one per phase.

## Open Risks & Assumptions

- **The correctness fix ships with the nice-to-have.** You chose a single unit over an independently
  shippable Phase 1, so the ceiling-badge fix waits on vocabulary and print work.
- **Two vocabularies must be kept in sync by a test, not by structure.** A shared renderer was
  offered and declined to keep the operator view untouched; the exhaustiveness guard is what makes
  that safe.
- **A printed report is not reproducible.** Correlation and comparison are computed at read time, and
  snapshot pixels expire after 3 runs, so regenerating the same report later can legitimately differ.
  This plan does not address it; the coverage statement narrows the harm but does not remove it.
- **`ruleSet` records rules declared, not exercised**, and cannot detect a changed rule. "We checked
  for X" is a weaker claim than it appears, even with coverage disclosed.
- **Print fidelity has no automated check.** Page breaks, image rendering and grayscale legibility
  are manual criteria in Phase 3.

## Success Criteria (Summary)

- A run that stopped at the page ceiling no longer presents as a complete check, anywhere a reader
  looks — and a clean run is not made to look qualified
- Every finding type has a client label and sentence, enforced by a test that fails when a new
  detection rule is added without wording
- The report prints to a PDF a non-technical client contact can read: no clipped tables, no operator
  chrome, images present, and legible in grayscale
