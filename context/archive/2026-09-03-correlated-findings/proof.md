# Real-site proof: correlated findings on yazaki-emea.com

**Run**: `29fa2fc7-b48f-4f3f-9136-ef00ccb3c0e9` — 533 pages, 67 findings, 2026-09-03
**Rule as shipped**: `src/app/(app)/projects/[id]/correlate.ts` at `39222c7`
**Method**: the shipped `correlate()` run against the stored run's rows, unmodified. The harness was
temporary and has been removed.

## The prediction, made before implementation

The research probe (`research.md`, 2026-09-03) predicted **five problems and three uncorrelated
findings — eight list entries from sixty-seven** — after the internal/external guard was applied. It
is recorded here as a prediction rather than a target: the number is only good if the five are right,
and counting groups cannot tell you that.

**The rule produced exactly that.** No divergence to explain.

## Before

| findings | type |
| ---: | --- |
| 34 | `metadata_duplicated` |
| 22 | `link_broken` |
| 8 | `variant_diverged` |
| 1 | `page_missing_from_sitemap` |
| 1 | `page_orphaned` |
| 1 | `link_external_broken` |
| **67** | **six of twenty-four rule types** |

## After

**5 problems + 3 uncorrelated findings = 8 list entries.**

| # | shape | findings | folded types | families | origin pages |
| --- | --- | ---: | --- | ---: | ---: |
| 1 | `one-family` | 28 | `variant_diverged`×8, `link_broken`×20 | 1 | 2 |
| 2 | `family-set` | 20 | `metadata_duplicated`×20 | 6 | 60 |
| 3 | `family-set` | 10 | `metadata_duplicated`×10 | 5 | 50 |
| 4 | `family-set` | 4 | `metadata_duplicated`×4 | 2 | 4 |
| 5 | `family-set` | 2 | `link_broken`×2 | 51 | 102 |

Uncorrelated: `page_missing_from_sitemap` (452 URLs), `page_orphaned` (71 URLs),
`link_external_broken` (`yazaki-group.com/global`).

## The verdict on each: would one edit fix all of these?

### 1. Twenty-eight findings, two pages — **yes**

Origin is one variant family, two members:
`/de/karriere/previous-career-pages/karriere-3` and `/fr/carrieres/previous-career-pages/carrieres-3`.
Between them they emit twenty dead links and account for eight diverged variants. The language
switcher on those two pages builds sibling URLs by swapping the locale prefix while keeping the
source language's path slug — `/bg/karriere/…` where Bulgarian's real path is `/bg/karieri/…`.

One template, one edit, and **two different check types folded into one problem** — which is FR-040's
actual claim, demonstrated on a client site rather than on a fixture.

### 2. Twenty findings, sixty pages — **yes**

Six families: the homepage and five legal pages, in ten languages. Every one of the sixty carries the
site's default title *and* description for its language, so the rule fires twice per locale. The
cause is single: the legal-page template publishes no metadata of its own and falls through to the
site default. The remedy is content in ten languages, but the defect is one template.

### 3. Ten findings, fifty pages — **yes**

Five news articles, in ten languages, sharing one description per language. Each locale's description
is a correct translation of the same text, which is what rules out "ten separate editorial mistakes":
the five articles were published from one description and then translated together.

### 4. Four findings, four pages — **yes**

The careers page and its archived `previous-career-pages` copy share both title and description, in
German and French. The archive was cloned from the live page and never re-titled.

### 5. Two findings, one hundred and two pages — **yes**

Two dead `/dev/` test pages, one linked from every German page and one from every French page. They
grouped because the German and French navigations occupy **the same fifty-one families** — the site's
own hreflang tags are what say the German nav and the French nav are the same nav. An agency artefact
left in a shared layout: one cause, one edit.

This is also the group that would have been wrong without the guard. See below.

**Five of five confirmed. No verdict was softened, and no group was split or merged after seeing the
output.**

## The correlation the rule refused

`link_external_broken` for `yazaki-group.com/global` is emitted from 502 pages spanning the same
fifty-one families as problem 5. Without the internal/external guard it would have folded into
problem 5, and the product would have told the reader that one edit fixes three things — when one of
the three is a page on somebody else's site that they cannot edit at all.

A shared layout is a shared *location*, not a shared *cause*. The guard is structural rather than a
threshold, so it cannot go quiet on a site with a worse footer.

## What this does not prove

Following the S-05 honesty clause: correctly silent is not the same as validated.

- **Eighteen of twenty-four rule types did not fire on this run**, so their evidence roles are
  covered by unit tests and by nothing else. The role split for `redirect_chain`, `content_duplicated`,
  `security_header_contradiction` and the canonical family has never met real data.
- **The `same-pages` shape never fired.** Every one of the 533 pages carried a family key, so the
  fallback path — the one a monolingual client would live on — is exercised only by shape tests.
- **One site is one site.** These five problems are five shapes, not the space of shapes.
- **The rule was designed after looking at this run.** The shapes in `correlate.test.ts` had their
  expectations written first, and one of them was wrong and is recorded as such in place; but the
  choice of *axis* was made with this data visible. A second client site is the real test of it.
