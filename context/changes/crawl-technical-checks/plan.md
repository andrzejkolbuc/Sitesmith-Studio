# Crawl-level technical checks (S-04) Implementation Plan

## Overview

Roadmap item S-04 turns six must-have requirements into ten new finding types and one
change to a shipped rule: broken internal and external links and redirect chains (FR-016),
sitemap↔crawl reconciliation (FR-017), robots.txt rules blocking indexable pages (FR-018),
orphan pages (FR-019), duplicate titles and near-identical content across URLs (FR-020),
and security header and certificate problems (FR-030).

The phases are ordered by what each costs the client's site. Phases 1–3 add no outbound
requests at all. Phases 4–7 add two per run. Phases 8–9 change the load profile and touch
the page-identity path proven against a live site three weeks ago, so they come last and
nothing else waits on them.

## Current State Analysis

`src/server/crawl/` holds a working crawl-and-detect pipeline with 14 rules. What matters
for this slice:

- **The crawl computes eight per-page fields and persists five.** `links`, `content`,
  `metadata` and `xRobotsTag` are consumed in-process by `detectMissingVariants` and then
  discarded when `result.pages` goes out of scope. `run.ts:163-170` writes the other five.
- **Rules are pure and synchronous.** `detectMissingVariants(options): Finding[]`
  (`findings.ts:120`) takes `DetectOptions` and does no I/O. There is no rule registry and
  no rule interface — a rule is a comment banner and a loop pushing onto a shared array.
  Roughly 90 test call-sites invoke the detector synchronously.
- **All fetching lives in one call site.** `crawler.ts:239` is the only `fetch()` in the
  repo, wrapped in a concurrency ceiling, an inter-request delay, a consecutive-failure
  abort and a failure-rate abort — deliberately inside the loop so no caller can opt out.
- **`inScope` (`crawler.ts:117-136`) is the entire frontier policy**: same-origin plus
  operator-configured include/exclude paths. robots.txt is not consulted, not fetched, and
  has never existed in this codebase. Neither has sitemap.xml.
- **Links are extracted without a scope filter** despite `crawler.ts:57` claiming
  otherwise, so external URLs are already in memory — they are simply never enqueued.
- **`redirect: "follow"`** means no page ever carries a 3xx status, and a second route to
  an already-recorded page is discarded at `crawler.ts:315`, taking the alias→target edge
  with it.
- **There is no link table and no reverse index**, so "which pages link to X" is currently
  unanswerable at any price.

## Desired End State

A run against a client site reports, beside the existing multilingual findings: every dead
internal and external link named once with the pages that link to it; redirect chains and
loops; sitemap entries that fail and live pages the sitemap omits; robots.txt rules
contradicting the site's own sitemap; orphan pages; URLs serving duplicate titles,
descriptions or content; and certificate and security-header contradictions.

Verified by the Phase 10 real-site proof: a full crawl of yazaki-emea.com at existing
pacing, with every new finding judged by hand and a per-type before/after table written
into `change.md`.

### Key Discoveries

- `run.ts:190-196` already runs a post-crawl phase over the whole page set (variant
  grouping). The link graph, sitemap and robots artefacts hook in beside it.
- `CrawlResult` already carries two non-page facts (`abortedReason`, `reachedPageLimit`)
  that `run.ts:204` folds into `crawlComplete` — the precedent for site-level crawl output
  reaching pure rules.
- `canonical_missing` (`findings.ts:868-891`) is a two-pass corpus rule that carries the
  corpus-level fact into each finding's detail. That is the exact shape FR-017 wants.
- Rule 7 (`findings.ts:552-631`) is already a `Map<digest, members[]>` group-by, not a
  pairwise comparison. The family scoping is a loop bound, not an algorithmic constraint.
- `pagesInvolved` in `summarise.ts:66-133` falls back to `one(finding.url)`, so a
  site-wide finding without a case silently reports zero pages. Every finding in this
  slice except the certificate one is site-wide.
- `MAX_METADATA_CHARS = 1000` (`metadata.ts:77`) is the established cap for any string
  retained per page, with the reasoning written against the 2,000-page ceiling.

## What We're NOT Doing

- **Not obeying robots.txt.** Reporting was pre-assigned to this slice; honouring it as a
  crawl constraint was declined deliberately in `first-multilingual-crawl/plan.md:58-60`
  and stays declined. FR-018's formulation depends on continuing not to obey, and that
  dependency is recorded in Phase 6.
- **Not sending a distinct user-agent.** Declined in S-01, still declined, unchanged here.
- **Not building a similarity ratio for "near-identical" content.** Deferred in writing,
  the way S-03 deferred word count. Any future proposal must state its number *and* its
  measured firing rate over the 533-page real crawl, with every pair it would report
  judged by hand, before it is planned. Phase 1 ships exact-digest matching only.
- **Not reporting a missing security header against a baseline list.** A missing CSP is our
  standard, not the site's assertion. Phase 3 reports only self-contradiction.
- **Not using internal links as FR-018's trigger.** "Blocked by robots.txt but linked from
  N pages" fires on `/search`, `/cart`, `/login`, faceted navigation and print views —
  the canonical *correct* uses of `Disallow`. Rejected explicitly, not by omission.
- **Not persisting the link graph.** Built in memory, consumed by the rules, discarded —
  matching the precedent S-05 set for metadata. A durable `page_links` table belongs to
  whichever slice first needs run-over-run link comparison.
- **Not adding a per-run findings cap or a suppression mechanism.** Both are real gaps
  (PRD Open Question 2 is still open) but neither is in scope here. Volume is instead an
  explicit acceptance criterion in Phase 10.
- **Not crawling sitemap URLs as a discovery channel.** The sitemap is reconciled against
  the link-following crawl, not merged into the frontier. Merging would change what the
  2,000-page ceiling means and what every absence-reasoning rule sees.

## Implementation Approach

Three structural moves carry the whole slice.

**Site-level artefacts reach the rules as data.** `CrawlResult` widens to carry a parsed
robots.txt, a parsed sitemap, a TLS observation and the re-verification outcomes;
`DetectOptions` widens to match. Rules stay pure and synchronous. Every fetch stays inside
`crawl()`, under the pacer.

**The link graph is built once, in memory, in the post-crawl phase**, beside variant
grouping — before `result.pages` goes out of scope. Both FR-016's internal half and
FR-019 read it.

**Findings name the thing that is wrong, once.** A dead page linked from site-wide
navigation is one finding listing its linkers, not one per linking page. This follows
rule 5's argument that per-edge reporting makes the worst sites the least readable, and it
is the main defence against the volume risk this slice carries.

## Critical Implementation Details

**Ordering inside `detectMissingVariants` is semantically load-bearing.** Rule 6 populates
`collapsed` before rules 2/3 read it; rule 5 populates `describedByFamily` before rule 4.
New rules that must defer to an existing one do it through a shared `Set` declared in the
enclosing scope, and must be placed after the rule that populates it. Phase 2's
`link_broken` defers to `hreflang_target_failed` and `canonical_target_broken`, so it goes
after rule 13.

**Both sides of every URL comparison pass through `normaliseUrl`.** It clears the entire
query string and the trailing slash. A sitemap listing `?page=1..20` collapses to a single
URL, so nineteen "missing from the crawl" findings would be an artifact of our own
normalisation. Dedupe after normalising and quote the raw value as evidence.

**Phase 9 changes the fetch call's redirect mode.** `crawler.test.ts:212-280` pins the
served-URL identity behaviour that `page-identity-under-redirects` established and proved
on a live site. Those tests must keep passing unchanged; the hop record is additive.

---

## Phase 1: Duplicate content across URLs

### Overview

FR-020's content clause, plus closing the monolingual gap in the shipped title rule. No new
requests, no new fields, no new numbers.

### Changes Required

#### 1. Site-wide duplicate content rule

**File**: `src/server/crawl/findings.ts`

**Intent**: Add rule 15, `content_duplicated`: group every page by `content.textDigest`
across the whole corpus and report each digest carried by two or more URLs. This is rule 7's
group-by with the family loop removed and the ≥2-languages gate dropped — that gate is
precisely what suppresses the same-language case FR-020 asks for.

**Contract**: New `FINDING_TYPES.CONTENT_DUPLICATED = "content_duplicated"`. Emits
`url: null`, `detail: { digest, textLength, urls: string[] }`. Guards, each already
defended elsewhere in the file: `crawlComplete` (the finding's substance is a list of every
URL carrying the content, and a truncated run can hold one member of a pair and not the
other); `isError`; `textDigest !== null` (inherits `MIN_COMPARABLE_CHARS` free);
`content.isolated === true` on every member; and suppression of sets already explained by
rule 7's `identical_to_siblings` or resolved by a canonical pointing from one member to
another.

The `isolated` guard matters more here than in rule 8. Across arbitrary URLs, templates
differ — a listing page declines isolation while an article page isolates — so comparing an
isolated `<main>` digest against a whole-body fallback digest compares different regions,
and any finding from it would be a claim about our extraction rather than the site.

#### 2. Unlocalised bucket in `metadata_duplicated`

**File**: `src/server/crawl/findings.ts`

**Intent**: Rule 10 currently `continue`s on a page whose locale nothing established, which
makes it silent on any monolingual site — the site shape S-04's prerequisite chain implies.
Group those pages into their own comparison set rather than skipping them.

**Contract**: The `byValue` key becomes `JSON.stringify([field, language ?? "", value])`,
and the emitted `detail.language` distinguishes the unlocalised bucket explicitly rather
than reporting an empty string as if it were a language. Localised pages keep their current
grouping exactly, so the cross-locale double-report with rule 7 that S-05 scoped this rule
to avoid is not reintroduced. Update the rule's doc comment: the existing paragraph argues
correctly that a page with no established language cannot duplicate another *in that
language*, and that argument no longer covers the case where neither page has one.

#### 3. UI and summary plumbing

**Files**: `src/app/(app)/projects/[id]/summarise.ts`,
`src/app/(app)/projects/[id]/run-panel.tsx`

**Intent**: Add the `pagesInvolved` case reading `detail.urls`, the `FINDING_LABEL` entry,
and an `Evidence` renderer showing the shared content's length and the URLs carrying it.

**Contract**: Without the `pagesInvolved` case the finding reports zero pages; without the
`Evidence` case `e2e/journeys/first-crawl.spec.ts` fails the build on raw JSON.

#### 4. Tests

**Files**: `src/server/crawl/site-shapes.test.ts`, `test/fixtures/site.ts`,
`src/server/crawl/findings.test.ts`, `src/app/(app)/projects/[id]/summarise.test.ts`

**Intent**: A `describe` block for duplicate content and one for the unlocalised bucket,
each with positives, negatives and guard-boundary cases, written before the rules are run
against them.

**Contract**: Negatives are non-negotiable — two pages with different content; two pages
below `MIN_COMPARABLE_CHARS`; a family already reported by rule 7; a pair where one
canonicalises to the other; a page that failed. Fixture pages for a same-language duplicate
pair and for two unlocalised pages sharing a title, with a line added to the fixture's
site-map comment.

### Success Criteria

#### Automated Verification

- Type checking passes: `npm run typecheck`
- Linting and formatting pass: `npm run check`
- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- A same-language duplicate content pair produces exactly one `content_duplicated` finding
- Two unlocalised pages sharing a title produce a `metadata_duplicated` finding
- Existing `metadata_duplicated` behaviour on localised pages is unchanged
- A family already reported by `content_untranslated` produces no `content_duplicated`
- Mutation check: inverting the `isolated` guard fails at least one test

#### Manual Verification

- Both findings render readably in the run panel with no raw JSON
- The unlocalised bucket reads as "no language established", not as a blank language

**Implementation Note**: Pause for manual confirmation before Phase 2.

---

## Phase 2: Link graph and broken internal links

### Overview

FR-016's internal half, plus the re-verification pass that closes the transient-502 scar.

### Changes Required

#### 1. Re-verification of transient failures

**File**: `src/server/crawl/crawler.ts`

**Intent**: A page recorded with a 5xx or a network error gets one confirming re-fetch after
the main crawl completes, through the same pacer. The recorded status becomes the second
observation. This closes an open scar — a page that answered 200 on five consecutive
re-fetches was once recorded 502 and reported, "a true observation at crawl time and a false
statement about the site" — and it hardens every existing rule, not just this slice's.

**Contract**: A pass inside `crawl()` after the worker loop drains, over pages where
`fetchError !== null || httpStatus >= 500` — the same predicate the politeness aborts
already use for a transient failure. 404s are reported on first observation and are not
re-fetched. `CrawlResult` gains `reverified: { url, first, second }[]` so a rule can say
the failure was confirmed twice. Skip the pass entirely when the crawl aborted.

#### 2. In-memory reverse link index

**File**: `src/server/crawl/run.ts`

**Intent**: Build the reverse index in the post-crawl phase, beside variant grouping, before
`result.pages` goes out of scope. Not persisted — matching S-05's precedent that detection is
in-memory and the finding's detail carries the evidence.

**Contract**: `Map<targetUrl, sourceUrl[]>` built from `page.links`, each target passed
through `normaliseUrl`, restricted to in-scope targets for this phase. Threaded into
`DetectOptions` as `linksTo`. `DetectOptions` gains `linksTo` and `reverified` as **required**
fields, following the reasoning `crawlComplete` is required rather than optional: a caller
that forgets should get the safe behaviour, not the confident-and-wrong one.

#### 3. The broken internal link rule

**File**: `src/server/crawl/findings.ts`

**Intent**: Add rule 16, `link_broken`: one finding per dead internal target, listing every
page that links to it.

**Contract**: `FINDING_TYPES.LINK_BROKEN = "link_broken"`. Emits `url: null`,
`detail: { target, httpStatus, fetchError, confirmed: boolean, linkedFrom: string[] }`.
`confirmed` records whether the failure survived re-verification. Placed after rule 13 and
suppressing any target already named by `hreflang_target_failed` or
`canonical_target_broken` through a shared `Set`, following the `collapsed` discipline —
those rules make a more specific claim about the same URL, and reporting both is the
double-report half of `findings.ts` exists to prevent. No `crawlComplete` gate: this rule
reasons from a status we observed, not from absence.

#### 4. Correct the `links` doc comment

**File**: `src/server/crawl/crawler.ts`

**Intent**: `crawler.ts:57` documents `links` as "Absolute, in-scope URLs linked from this
page." No scope filter is applied; scoping happens at enqueue time. Phase 8 depends on the
real behaviour, so the comment should say what the field holds.

#### 5. Tests

**Files**: `src/server/crawl/site-shapes.test.ts`, `test/fixtures/site.ts`,
`src/server/crawl/crawler.test.ts`, `src/app/(app)/projects/[id]/summarise.test.ts`

**Contract**: Rule cases: a 404 target linked from three pages produces one finding naming
three linkers; a target already reported by `canonical_target_broken` produces none; a
healthy target produces none; a target that failed once and succeeded on re-verification
produces none. Crawler cases: the re-verification pass re-fetches a 5xx and not a 404, and
is skipped on an aborted crawl. The hostile-site fixture already models flapping and is the
right home for the re-verification case.

### Success Criteria

#### Automated Verification

- Type checking passes: `npm run typecheck`
- Linting and formatting pass: `npm run check`
- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- A 404 linked from three fixture pages yields one finding naming all three
- A flapping 5xx that recovers on re-verification yields no finding
- A target already reported by `canonical_target_broken` yields no `link_broken`
- The re-verification pass issues no requests on an aborted crawl

#### Manual Verification

- A long linker list truncates readably rather than flooding the panel
- Re-verification does not noticeably lengthen a run on a healthy site

**Implementation Note**: Pause for manual confirmation before Phase 3.

---

## Phase 3: Security headers and certificate

### Overview

FR-030. The header half is free — the headers are already in hand at the fetch call site and
merely discarded. The certificate half needs a probe the HTTP client cannot provide.

### Changes Required

#### 1. Capture named security headers

**File**: `src/server/crawl/crawler.ts`

**Intent**: Read a closed list of security headers at the existing call site and retain them
as capped strings, exactly as `xRobotsTag` is. Not the `Headers` object — the doc comment at
`crawler.ts:74-86` explains why an unbounded structure must not be multiplied by the
two-thousand-page ceiling, and that reasoning is unchanged.

**Contract**: `CrawledPage.securityHeaders: Record<string, string>` holding only
`strict-transport-security`, `content-security-policy`, `x-frame-options`,
`x-content-type-options`, `referrer-policy` and `permissions-policy`, each capped at
`MAX_METADATA_CHARS`. Absent headers are absent keys, not empty strings — the distinction
carries the site's silence honestly. The `catch` path sets the empty value. Every hand-built
`CrawledPage` literal in the tests gains the field.

#### 2. TLS probe module

**File**: `src/server/crawl/tls.ts` (new)

**Intent**: One `node:tls` handshake per origin yielding the peer certificate. A separate
module beside `url.ts` because it is transport-layer and shares nothing with markup
extraction; `crawler.ts` is untouched by it.

**Contract**: `probeCertificate(origin): Promise<CertificateObservation | null>` returning
issuer, subject, `validFrom`, `validTo`, `subjectAltNames`, and an authorisation-error
string. One connection per origin, not per page, so the cost against the politeness budget is
a single handshake. Called from `crawl()` before the worker loop; the result rides
`CrawlResult` into `DetectOptions`. Returns `null` on a plain-http origin and on any
connection error, so a probe failure is silence rather than a finding about the client.

#### 3. The two rules

**File**: `src/server/crawl/findings.ts`

**Intent**: Rule 17 `certificate_problem` and rule 18 `security_header_contradiction`, both
reporting only what the site itself asserted.

**Contract**: `certificate_problem` emits `url: null`,
`detail: { kind, origin, validTo, daysRemaining, issuer }` with `kind` in
`"expired" | "expiring_soon" | "hostname_mismatch" | "untrusted_chain"`. The
`expiring_soon` window is 30 days, and it is defended by an external anchor rather than by
taste: Let's Encrypt issues 90-day certificates and auto-renews at 30 days remaining, so a
certificate inside that window on an automated site has already missed a renewal. The finding
quotes `validTo` regardless, so the reader can judge the window themselves.

`security_header_contradiction` emits `url: null`,
`detail: { kind, header, value, affectedUrls }` with `kind` in
`"malformed" | "hsts_absent_on_https_only"`. Two cases only. A malformed value is the site
publishing something that cannot mean what it says. `hsts_absent_on_https_only` fires when
every crawled http URL redirected to https and no page carries an HSTS header — the site
asserted https-only by its own redirects and did not tell browsers to remember it. **A merely
absent CSP, X-Frame-Options or Referrer-Policy is not a finding**: that would be our standard
rather than the site's assertion, which is the failure `lessons.md` was written after four
false-positive classes to prevent.

#### 4. UI, summary and tests

**Files**: `summarise.ts`, `run-panel.tsx`, `site-shapes.test.ts`, `test/fixtures/site.ts`

**Contract**: The fixture's `Page.headers` field (added by S-05 for `X-Robots-Tag`) already
carries arbitrary response headers, so header shapes need no fixture type change. The TLS
probe is not exercised by the fixture server — its unit tests drive
`probeCertificate` against a locally generated self-signed certificate, and against a
plain-http origin to assert silence.

### Success Criteria

#### Automated Verification

- Type checking passes: `npm run typecheck`
- Linting and formatting pass: `npm run check`
- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- A malformed HSTS value produces one `security_header_contradiction`
- A site with no CSP and no other contradiction produces no finding
- An https-only fixture without HSTS produces `hsts_absent_on_https_only`
- `probeCertificate` returns null on a plain-http origin and on a connection error
- An expired self-signed certificate produces `kind: "expired"`

#### Manual Verification

- The certificate finding reads as a fact about the site, not as a security opinion
- A well-configured real site produces no security-header findings

**Implementation Note**: Pause for manual confirmation before Phase 4.

---

## Phase 4: robots.txt fetch and parser

### Overview

The first of the two site-control channel fetches. Parser and plumbing only — no rules yet,
so the phase is verifiable on its own.

### Changes Required

#### 1. The parser

**File**: `src/server/crawl/robots.ts` (new)

**Intent**: Parse a robots.txt body into user-agent groups and evaluate a path against them.
Written from scratch: nothing in `metadata.ts` transfers, because `X-Robots-Tag` is an
*indexing* directive — page-level, comma-separated — while robots.txt is a *crawling*
directive with line-oriented groups and pattern matching. Conflating them yields a rule wrong
in both directions.

**Contract**: `parseRobots(body): RobotsFile` and
`matchRule(robots, path, userAgent): MatchedRule | null`. Group selection is
case-insensitive, longest-match-wins on the user-agent token, `*` as fallback, and a group
only applies when no more specific one matches. Rules support `*` and `$` wildcards.
Precedence is most-specific-match wins with `Allow` breaking ties, per RFC 9309. An empty
`Disallow:` means allow-all. `Sitemap:` directives are collected group-independently and may
point off-origin. `#` starts a comment. Every matched rule retains its verbatim line and line
number, because the findings quote them.

Follow the closed-vocabulary discipline of `metadata.ts:196-223`: the set of known
*directives* is closed, the set of crawler names is open.

**A path that cannot be evaluated must report as not-evaluated, never as not-matching.**
`normaliseUrl` has already dropped the query string, so a rule like `Disallow: /*?sessionid=`
cannot be judged against a stored URL. Returning "no match" would be a claim about our
normalisation.

#### 2. Fetch and plumbing

**Files**: `src/server/crawl/crawler.ts`, `src/server/crawl/findings.ts`

**Intent**: Fetch `/robots.txt` once at the start of `crawl()`, through the pacer, and carry
the parsed result to the rules.

**Contract**: `CrawlResult.robots: RobotsFile | null`, `null` on any non-200 or fetch error.
`DetectOptions` gains `robots` as a required field. A 404 is silence, never a finding — the
absence of a robots.txt is not a defect.

#### 3. Tests

**Files**: `src/server/crawl/robots.test.ts` (new), `test/fixtures/site.ts`

**Contract**: Parser cases sourced from RFC 9309 and Google's documented behaviour, written
before the parser is run against them: longest-match group selection; `googlebot` beating `*`;
`Allow` winning a tie at equal specificity; `$` anchoring; an empty `Disallow`; comments;
a `Sitemap:` outside any group; a body that is HTML because the server returns a soft 404.
The fixture server serves a `/robots.txt` shape.

### Success Criteria

#### Automated Verification

- Type checking passes: `npm run typecheck`
- Linting and formatting pass: `npm run check`
- Unit tests pass: `npm run test:unit`
- `googlebot` group wins over `*` when both match
- `Allow` wins a same-specificity tie against `Disallow`
- A query-bearing pattern reports as not-evaluated rather than not-matching
- A missing robots.txt yields `robots: null` and no finding
- Crawl behaviour is unchanged: the same fixture crawl visits the same pages as before

#### Manual Verification

- The parser's output on yazaki-emea.com's real robots.txt matches a hand reading of it

**Implementation Note**: Pause for manual confirmation before Phase 5.

---

## Phase 5: Sitemap fetch and parser

### Overview

The second site-control fetch, and the phase carrying the slice's sharpest false-positive
risk — URL identity between what the site published and what the crawl recorded.

### Changes Required

#### 1. The parser

**File**: `src/server/crawl/sitemap.ts` (new)

**Intent**: Fetch and parse the site's sitemap into a normalised URL set, retaining the raw
`<loc>` as evidence. Regex extraction rather than an XML dependency, following the argument
`metadata.ts:19-24` and `content.ts` both make: a real DOM would be a dependency, a startup
cost, and a second definition of what a document says.

**Contract**: `parseSitemap(body, sitemapUrl): SitemapEntry[]` where an entry holds the raw
loc, the normalised URL (or null when it could not be normalised), and the sitemap it came
from. Handles `<urlset>` and `<sitemapindex>`, recursing into children with a bounded
fan-out — a child-count and total-URL cap mirroring `MAX_PAGES`, so a malformed index cannot
run away. XML entities and `<![CDATA[…]]>` decoded before normalisation. A `.xml.gz` body is
gunzipped via `node:zlib` with a decompressed-size cap; `politeness-under-stress` already
flagged the absent response-size cap as the obvious next hardening, and a gzip bomb is that
risk with a multiplier.

**Discovery order is a provenance decision.** Prefer the `Sitemap:` directives from Phase 4's
robots.txt — that is the site's own declaration. Fall back to `/sitemap.xml`, which is a
convention we guess at. Record which channel supplied it. **A 404 at the guessed path is not
evidence the site has no sitemap** and must not become a finding.

#### 2. The comparison pipeline

**File**: `src/server/crawl/sitemap.ts`

**Intent**: Produce the two comparison sets FR-017 needs, with the identity traps handled
once here rather than in each rule.

**Contract**: A `reconcile(entries, pages, inScope)` helper returning entries absent from the
crawl, pages absent from the sitemap, and entries excluded from comparison with the reason.
Order: entity-decode, normalise, dedupe *after* normalising, partition by origin, apply
`inScope`, and do not case-fold paths. Cross-origin locs become a factual observation ("the
sitemap declares N URLs on a different origin"), never a per-page defect — a sitemap on
`www.` against a crawl on the apex would otherwise report *every* page absent.

#### 3. Fetch and plumbing

**Files**: `src/server/crawl/crawler.ts`, `src/server/crawl/findings.ts`

**Contract**: `CrawlResult.sitemap: SitemapDocument | null`; `DetectOptions` gains `sitemap`
as a required field. All fetches share the pacer.

#### 4. Tests

**Files**: `src/server/crawl/sitemap.test.ts` (new), `test/fixtures/site.ts`

**Contract**: A sitemap index with two children; a gzipped sitemap; entity-encoded and CDATA
locs; a cross-origin sitemap; a sitemap whose locs differ only by query string, asserting
they collapse to one entry and are not reported nineteen times; a loc under an excluded path.

### Success Criteria

#### Automated Verification

- Type checking passes: `npm run typecheck`
- Linting and formatting pass: `npm run check`
- Unit tests pass: `npm run test:unit`
- A sitemap index resolves both children into one entry set
- A gzipped sitemap parses; one exceeding the size cap is refused without throwing
- Locs differing only by query string collapse to a single entry
- A cross-origin sitemap produces an observation, not per-page defects
- A missing sitemap yields `sitemap: null` and no finding

#### Manual Verification

- The parser's entry count on yazaki-emea.com's real sitemap matches its declared contents

**Implementation Note**: Pause for manual confirmation before Phase 6.

---

## Phase 6: Sitemap reconciliation and robots-blocked pages

### Overview

FR-017 and FR-018 — the rules consuming Phases 4 and 5.

### Changes Required

#### 1. Sitemap reconciliation rules

**File**: `src/server/crawl/findings.ts`

**Intent**: Rule 19 `sitemap_url_failed` and rule 20 `page_missing_from_sitemap`, the two
directions of FR-017.

**Contract**: `sitemap_url_failed` emits `url: null`,
`detail: { sitemapSource, entries: { raw, normalised, httpStatus, fetchError }[] }`. It
reports a sitemap entry the crawl recorded as failing. It is gated on `crawlComplete`.

**The redirect trap has no precedent yet and must be handled here.** The crawl records the
URL the server *served*, and discards a response that redirects to an already-recorded page.
So a sitemap loc that 301s to a canonical URL was fetched successfully, is healthy, and never
appears under its own name. Deriving failure from absence would report the site's own tidy
redirects as broken sitemap entries — the alias false positive re-emerging in a third
setting. Resolve it by consulting Phase 9's requested-URL record where available, and until
then by reporting only entries the crawl recorded with an explicit failure status, never
entries merely absent.

`page_missing_from_sitemap` emits `url: null`,
`detail: { sitemapSource, urls: string[], sitemapEntryCount }` — the corpus-level fact
carried into the detail, following `canonical_missing`'s shape. **It does not need
`crawlComplete`**: it reasons from the sitemap's completeness plus a positive observation
that we fetched the page and it returned 200, so truncation can only make it quieter, never
wrong. Exclusions, or it fires on pages a sitemap is correct to omit: non-200 pages, pages
carrying `noindex` on either channel, and pages whose canonical points elsewhere.

#### 2. Robots-blocked indexable pages

**File**: `src/server/crawl/findings.ts`

**Intent**: Rule 21 `robots_blocks_indexable`, formulated as R1 — the site's sitemap lists a
URL that the site's own robots.txt disallows. Two direct, opposing assertions by the same
publisher on the same host, statable entirely in quotation.

**Contract**: Emits `url: null`,
`detail: { rule, ruleLine, userAgentGroup, sitemapSource, urls: string[] }`. **FR-016 asks
which robots.txt *rules* block pages — the rule is the subject and the pages are the
evidence**, so a single `Disallow: /` matching 400 sitemap URLs is one finding listing them,
not 400 findings.

Evaluate against the `googlebot` group falling back to `*`, mirroring how `ROBOTS_META_NAMES`
already privileges `robots`/`googlebot`/`bingbot`. This reads backwards at first — we send no
distinct user-agent, so on paper our group is `*` — but the finding is a claim about the
site's instruction to *search engines*, not about what we were permitted to fetch, and
Googlebot ignores `*` entirely when a `googlebot` group exists. A site with
`User-agent: googlebot / Disallow: /` and a permissive `*` is catastrophically blocked in the
way that matters, and evaluating `*` would report nothing. The group name and verbatim rule
line go in the detail so the reader sees which audience the site was addressing.

**This rule depends on the crawler continuing not to obey robots.txt.** Record that in the
rule's doc comment: if obedience is ever adopted, the R2-style extension goes dark silently.
No `crawlComplete` gate — the rule reads sitemap ⋈ robots.txt and does not consult the crawl
at all, so it survives a truncated or aborted run.

#### 3. UI, summary and tests

**Contract**: Three `pagesInvolved` cases, three labels, three `Evidence` renderers. Rule
tests include the negatives: a sitemap and robots that do not overlap; a `Disallow` matching
a URL the sitemap does not list; a noindex page absent from the sitemap; a page whose
canonical points elsewhere and is absent from the sitemap.

### Success Criteria

#### Automated Verification

- Type checking passes: `npm run typecheck`
- Linting and formatting pass: `npm run check`
- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- A `Disallow` matching four sitemap URLs produces one finding listing four
- A `googlebot` group is preferred over a permissive `*`
- A noindex page absent from the sitemap produces no finding
- `page_missing_from_sitemap` still reports on a truncated crawl
- `sitemap_url_failed` reports nothing on a truncated crawl

#### Manual Verification

- The blocked-pages finding reads as the site contradicting itself, not as our judgement
- The three findings together do not swamp the existing eight on a real crawl

**Implementation Note**: Pause for manual confirmation before Phase 7.

---

## Phase 7: Orphan pages

### Overview

FR-019, consuming Phase 2's link graph and Phase 5's sitemap.

### Changes Required

#### 1. The rule

**File**: `src/server/crawl/findings.ts`

**Intent**: Rule 22 `page_orphaned`: a URL the sitemap lists and the crawl fetched
successfully, with no inbound internal link from anywhere on the site.

**Contract**: Emits `url: null`, `detail: { sitemapSource, urls: string[] }`. **Gated on
`crawlComplete`** — this is an absence-reasoning rule, and the guard exists because a
truncated run once reported its own page ceiling as eighteen defects on a live client site,
naming URLs that all returned 200. Exclude the start URL, which is reachable by definition
and has no inbound link by construction.

#### 2. UI, summary and tests

**Contract**: Negatives: a page linked from exactly one other page; a page absent from the
sitemap and unlinked (not an orphan by the requirement's wording — it is simply not
published); the start URL.

### Success Criteria

#### Automated Verification

- Type checking passes: `npm run typecheck`
- Linting and formatting pass: `npm run check`
- Unit tests pass: `npm run test:unit`
- A sitemap-listed page with no inbound link is reported
- A page linked once is not reported
- The start URL is never reported
- No orphan findings are produced on a truncated crawl

#### Manual Verification

- Orphan findings on the fixture site match a hand reading of its link structure

**Implementation Note**: Pause for manual confirmation before Phase 8.

---

## Phase 8: External link checking

### Overview

FR-016's external half. The first traffic this product sends to hosts that are not the
client, and the first work requiring the politeness model to change rather than be inherited.

### Changes Required

#### 1. Extract the pacer

**File**: `src/server/crawl/crawler.ts`

**Intent**: `claimSlot`/`nextSlotAt` are closures private to `crawl()`. The external sweep
needs the same guarantee, so the limiter becomes a value the crawl owns and can lend, rather
than state hidden inside one function.

**Contract**: A limiter object exposing slot acquisition, constructed once per crawl and
passed to both the main loop and the external sweep. `crawler.ts`'s opening comment — that a
caller cannot opt out of the concurrency ceiling — must remain true after the change: the
limiter is not exported from the module.

#### 2. Per-host budget for external requests

**File**: `src/server/crawl/external.ts` (new)

**Intent**: Check unique external URLs after the main crawl, under a budget the same-origin
model never needed.

**Contract**: Unique normalised external URLs only. HEAD first with a GET fallback for hosts
that reject HEAD. A per-host concurrency cap and delay in addition to the global pacer, since
the global delay bounds total rate but nothing today bounds load on one third party. `429` and
`Retry-After` respected — currently a 429 is neither a burst failure nor a rate failure, so
the crawl would keep requesting from a host explicitly asking it to stop.

**External failures are isolated from the run-wide abort counters.** Today those counters are
global, so five consecutive dead third-party hosts would abort the crawl of the client's site.
A separate failure budget for the sweep, whose exhaustion ends the sweep and is reported as an
incomplete external check — never as a defect on the client.

A response-size cap applies here, where third-party bodies are being fetched.

#### 3. The rule

**File**: `src/server/crawl/findings.ts`

**Intent**: Rule 23 `link_external_broken`, mirroring rule 16's shape.

**Contract**: Emits `url: null`,
`detail: { target, httpStatus, fetchError, confirmed, linkedFrom: string[] }`. Re-verified on
5xx and network errors, matching Phase 2. Reports nothing when the external sweep did not
complete — an unchecked link is not a broken one.

#### 4. Tests

**Files**: `src/server/crawl/external.test.ts` (new), `test/fixtures/hostile-site.ts`

**Contract**: The adversarial fixture is the right home: a host returning 429 with
`Retry-After`; a host rejecting HEAD but answering GET; a host that never responds; a burst of
dead hosts asserting the main crawl is unaffected. Keep these out of `test/fixtures/site.ts` —
mixing them would let a change to what a rule means quietly alter the conditions under which
politeness is judged.

### Success Criteria

#### Automated Verification

- Type checking passes: `npm run typecheck`
- Linting and formatting pass: `npm run check`
- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- Each unique external URL is requested at most once per run
- A 429 with `Retry-After` defers rather than retrying immediately
- A host rejecting HEAD is retried with GET
- A burst of dead external hosts does not abort the main crawl
- An incomplete external sweep produces no `link_external_broken` findings
- The limiter is not exported from `crawler.ts`

#### Manual Verification

- A real run's external check completes in a duration proportionate to its unique external URLs
- No third-party host receives a burst that a reasonable operator would object to

**Implementation Note**: Pause for manual confirmation before Phase 9.

---

## Phase 9: Redirect chains and loops

### Overview

FR-016's remainder, and the highest-risk phase: it changes the fetch call's redirect mode,
which is the load-bearing behaviour `page-identity-under-redirects` established and proved
against a live site.

### Changes Required

#### 1. Manual redirect following

**File**: `src/server/crawl/crawler.ts`

**Intent**: `redirect: "follow"` means the runtime swallows the chain — `response.status` is
always the final hop's, so no page in any run carries a 3xx and a redirect is invisible in the
data model. Follow hops explicitly to record them.

**Contract**: `redirect: "manual"` with a hop loop recording, per hop, the requested URL, the
status and the `Location`. A hop cap detects loops as a structured outcome rather than as an
undifferentiated `fetchError` from the runtime's own 20-hop limit — which today counts as a
politeness failure and can abort the run. `CrawledPage` gains `redirectChain: Hop[]`, empty
for a direct 200.

**The identity invariants must survive intact.** The recorded page is still the URL the server
finally served; the pre-fetch `seen` and post-fetch `recorded` dedups both remain; the unique
index on `(runId, url)` is unchanged; and the page ceiling still counts recorded pages rather
than requests. `crawler.test.ts:212-280` pins this behaviour and must pass unchanged — the hop
record is purely additive.

#### 2. Restore the alias record

**File**: `src/server/crawl/crawler.ts`

**Intent**: A second route to an already-recorded page is discarded at `crawler.ts:315`,
taking the alias→target edge with it — 36 such aliases on the real client site. Those edges
are FR-016's evidence. `page-identity` dropped them because recording them "means a column
nothing consumes until S-04"; this is that slice, so restoring the record honours the decision
rather than reversing it.

**Contract**: `CrawlResult.aliases: { requested, served }[]`. In memory only, consistent with
the link graph. Threaded into `DetectOptions`.

#### 3. The rule

**File**: `src/server/crawl/findings.ts`

**Intent**: Rule 24 `redirect_chain`, reporting chains longer than one hop and loops.

**Contract**: Emits `url: null`, `detail: { kind, hops: { url, status }[], linkedFrom }` with
`kind` in `"chain" | "loop"`. A single hop is not a finding — one redirect is normal site
behaviour, and reporting it would flood every site that canonicalises `www.` or forces https.
**A chain arising only from our own normalisation is not a finding**: `normaliseUrl` drops the
query string and the trailing slash, so a `/path` → `/path/` hop must be recognised as our
identity definition meeting the site's, not as the site's defect. This is the same trap that
produced the recorded alias false positive, under a third name.

#### 4. Tests

**Files**: `src/server/crawl/crawler.test.ts`, `test/fixtures/site.ts`,
`src/server/crawl/site-shapes.test.ts`

**Contract**: The fixture already has `/redirect-hub` → `/moved/page` → `/final/page` from the
page-identity work, which is a two-hop chain and the natural positive case. Add a loop.
Negatives: a single hop; a trailing-slash-only hop; the existing identity tests unchanged.

### Success Criteria

#### Automated Verification

- Type checking passes: `npm run typecheck`
- Linting and formatting pass: `npm run check`
- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- End-to-end tests pass: `npm run test:e2e`
- Every existing page-identity test in `crawler.test.ts` passes unchanged
- A two-hop chain produces one `redirect_chain` finding naming both hops
- A redirect loop is reported as `kind: "loop"`, not as a fetch error
- A single hop produces no finding
- A trailing-slash-only difference produces no finding
- A fixture crawl still records the same page count as before this phase

#### Manual Verification

- A run against the fixture reports the same pages, statuses and existing findings as before
- Chain findings read as the site's redirects, never as our normalisation

**Implementation Note**: Pause for manual confirmation before Phase 10.

---

## Phase 10: Real-site proof

### Overview

No code. The acceptance phase every rule slice in this project has ended with — a full crawl
of a real client site, with every new finding judged by hand.

### Changes Required

#### 1. Run and record

**File**: `context/changes/crawl-technical-checks/change.md`

**Intent**: Crawl yazaki-emea.com at the project's existing pacing (two requests at a time,
500ms apart), compare against the previous run by finding type, and write the result into
`change.md` as a per-type before/after table, following the S-05 precedent.

**Contract**: The table carries every finding type, old and new, across the 2026-08-31,
2026-09-01, 2026-09-02 and this run's columns. Every new finding is spot-checked live before
it is believed. **Any finding that turns out to be false blocks the slice.**

Two defects are known in advance and **must** appear, or a rule has failed rather than the
site being clean: the 34 `metadata_duplicated` findings across 114 pages must persist
unchanged, and the crawl must still record 533 pages.

**Do not blur "correctly silent" into "validated".** S-05's own caveat applies with more
force here, because this slice ships ten rules at once: state per rule whether it produced a
true positive, or was correct to stay quiet, and say which it was.

### Success Criteria

#### Automated Verification

- Full suite passes: `npm run test:all`
- The crawl completes without aborting

#### Manual Verification

- Page count is 533, unchanged from the three prior runs
- The 34 `metadata_duplicated` findings persist unchanged
- Every new finding is spot-checked live and judged true
- No false positive is found in any of the ten new rules
- The run duration is within the 305–412s band of prior runs, plus a stated allowance for
  the external sweep and re-verification
- **Readability**: ten new rules have not swamped the existing fourteen; the findings list is
  still something an operator would read to the end
- Per-rule verdict recorded — true positive, or correctly silent — with no blurring

---

## Testing Strategy

### Unit Tests

- Rule shapes in `site-shapes.test.ts`, one `describe` per rule, expectations written before
  the rule is run against them and sourced from outside the implementation. Where a rule
  disagrees, the rule is wrong and the expectation stands.
- Parser-level tests in `robots.test.ts` and `sitemap.test.ts` against RFC 9309 and the
  sitemap protocol, not against our own output.
- Every rule carries explicit negatives and guard-boundary cases stating which guards it
  deliberately lacks.

### Integration Tests

- `run.test.ts` covers persistence of the new finding types and the link between a finding and
  its page.
- Fixture crawls in `findings.test.ts` exercise each rule end-to-end over real HTTP.

### Manual Testing Steps

1. Run the fixture crawl and confirm each new finding renders with no raw JSON.
2. Compare the parser output for yazaki-emea.com's real robots.txt and sitemap against a hand
   reading of each.
3. Run the full real-site crawl and complete the Phase 10 table.

## Performance Considerations

The run is delay-bound, not CPU-bound: 533 pages × 500ms is a ~267s floor regardless of
concurrency. Anything read off HTML already in hand — the link graph, security headers, the
content group-by — is effectively free.

Three phases add requests. Phase 2's re-verification costs one request per transient failure,
which is rare on a healthy site. Phases 4 and 5 cost two plus any child sitemaps. Phase 3's
TLS probe is one handshake per origin. Phase 8 is the only one that can meaningfully lengthen
a run, and its cost is proportional to unique external URLs — which is why it is capped,
deduped and reported as incomplete rather than allowed to run away.

Every added fixture page is paid for by every test that crawls the fixture site, and
`run.test.ts`'s excluded-path test runs at real pacing. This slice adds more fixture pages
than any before it. Raise that test's budget; do not remove the pacing.

## Migration Notes

No schema change and no migration. `findings.type` is `varchar(64)` and `detail` is `jsonb`,
so new finding types need neither — check each new type slug against the 64-character cap. The
link graph, sitemap, robots file, alias record and TLS observation all live in memory for the
duration of a run, following the precedent S-05 set when it declined to persist metadata.

## References

- Research: `context/changes/crawl-technical-checks/research.md`
- Lessons: `context/foundation/lessons.md`
- The rule template end to end: `src/server/crawl/findings.ts:1005-1088` (rule 14)
- The corpus-rule shape FR-017 follows: `src/server/crawl/findings.ts:868-891`
- The group-by Phase 1 rewires: `src/server/crawl/findings.ts:552-631`
- Identity behaviour Phase 9 must preserve: `src/server/crawl/crawler.test.ts:212-280`
- Prior real-site proof phase: `context/archive/2026-09-01-seo-metadata-checks/plan.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Duplicate content across URLs

#### Automated

- [x] 1.1 Type checking passes: `npm run typecheck`
- [x] 1.2 Linting and formatting pass: `npm run check`
- [x] 1.3 Unit tests pass: `npm run test:unit`
- [x] 1.4 Integration tests pass: `npm run test:integration`
- [x] 1.5 A same-language duplicate content pair produces exactly one `content_duplicated` finding
- [x] 1.6 Two unlocalised pages sharing a title produce a `metadata_duplicated` finding
- [x] 1.7 Existing `metadata_duplicated` behaviour on localised pages is unchanged
- [x] 1.8 A family already reported by `content_untranslated` produces no `content_duplicated`
- [x] 1.9 Mutation check: inverting the `isolated` guard fails at least one test

#### Manual

- [x] 1.10 Both findings render readably in the run panel with no raw JSON
- [x] 1.11 The unlocalised bucket reads as "no language established", not as a blank language

### Phase 2: Link graph and broken internal links

#### Automated

- [ ] 2.1 Type checking passes: `npm run typecheck`
- [ ] 2.2 Linting and formatting pass: `npm run check`
- [ ] 2.3 Unit tests pass: `npm run test:unit`
- [ ] 2.4 Integration tests pass: `npm run test:integration`
- [ ] 2.5 A 404 linked from three fixture pages yields one finding naming all three
- [ ] 2.6 A flapping 5xx that recovers on re-verification yields no finding
- [ ] 2.7 A target already reported by `canonical_target_broken` yields no `link_broken`
- [ ] 2.8 The re-verification pass issues no requests on an aborted crawl

#### Manual

- [ ] 2.9 A long linker list truncates readably rather than flooding the panel
- [ ] 2.10 Re-verification does not noticeably lengthen a run on a healthy site

### Phase 3: Security headers and certificate

#### Automated

- [ ] 3.1 Type checking passes: `npm run typecheck`
- [ ] 3.2 Linting and formatting pass: `npm run check`
- [ ] 3.3 Unit tests pass: `npm run test:unit`
- [ ] 3.4 Integration tests pass: `npm run test:integration`
- [ ] 3.5 A malformed HSTS value produces one `security_header_contradiction`
- [ ] 3.6 A site with no CSP and no other contradiction produces no finding
- [ ] 3.7 An https-only fixture without HSTS produces `hsts_absent_on_https_only`
- [ ] 3.8 `probeCertificate` returns null on a plain-http origin and on a connection error
- [ ] 3.9 An expired self-signed certificate produces `kind: "expired"`

#### Manual

- [ ] 3.10 The certificate finding reads as a fact about the site, not as a security opinion
- [ ] 3.11 A well-configured real site produces no security-header findings

### Phase 4: robots.txt fetch and parser

#### Automated

- [ ] 4.1 Type checking passes: `npm run typecheck`
- [ ] 4.2 Linting and formatting pass: `npm run check`
- [ ] 4.3 Unit tests pass: `npm run test:unit`
- [ ] 4.4 `googlebot` group wins over `*` when both match
- [ ] 4.5 `Allow` wins a same-specificity tie against `Disallow`
- [ ] 4.6 A query-bearing pattern reports as not-evaluated rather than not-matching
- [ ] 4.7 A missing robots.txt yields `robots: null` and no finding
- [ ] 4.8 Crawl behaviour is unchanged: the same fixture crawl visits the same pages as before

#### Manual

- [ ] 4.9 The parser's output on yazaki-emea.com's real robots.txt matches a hand reading of it

### Phase 5: Sitemap fetch and parser

#### Automated

- [ ] 5.1 Type checking passes: `npm run typecheck`
- [ ] 5.2 Linting and formatting pass: `npm run check`
- [ ] 5.3 Unit tests pass: `npm run test:unit`
- [ ] 5.4 A sitemap index resolves both children into one entry set
- [ ] 5.5 A gzipped sitemap parses; one exceeding the size cap is refused without throwing
- [ ] 5.6 Locs differing only by query string collapse to a single entry
- [ ] 5.7 A cross-origin sitemap produces an observation, not per-page defects
- [ ] 5.8 A missing sitemap yields `sitemap: null` and no finding

#### Manual

- [ ] 5.9 The parser's entry count on yazaki-emea.com's real sitemap matches its declared contents

### Phase 6: Sitemap reconciliation and robots-blocked pages

#### Automated

- [ ] 6.1 Type checking passes: `npm run typecheck`
- [ ] 6.2 Linting and formatting pass: `npm run check`
- [ ] 6.3 Unit tests pass: `npm run test:unit`
- [ ] 6.4 Integration tests pass: `npm run test:integration`
- [ ] 6.5 A `Disallow` matching four sitemap URLs produces one finding listing four
- [ ] 6.6 A `googlebot` group is preferred over a permissive `*`
- [ ] 6.7 A noindex page absent from the sitemap produces no finding
- [ ] 6.8 `page_missing_from_sitemap` still reports on a truncated crawl
- [ ] 6.9 `sitemap_url_failed` reports nothing on a truncated crawl

#### Manual

- [ ] 6.10 The blocked-pages finding reads as the site contradicting itself, not as our judgement
- [ ] 6.11 The three findings together do not swamp the existing eight on a real crawl

### Phase 7: Orphan pages

#### Automated

- [ ] 7.1 Type checking passes: `npm run typecheck`
- [ ] 7.2 Linting and formatting pass: `npm run check`
- [ ] 7.3 Unit tests pass: `npm run test:unit`
- [ ] 7.4 A sitemap-listed page with no inbound link is reported
- [ ] 7.5 A page linked once is not reported
- [ ] 7.6 The start URL is never reported
- [ ] 7.7 No orphan findings are produced on a truncated crawl

#### Manual

- [ ] 7.8 Orphan findings on the fixture site match a hand reading of its link structure

### Phase 8: External link checking

#### Automated

- [ ] 8.1 Type checking passes: `npm run typecheck`
- [ ] 8.2 Linting and formatting pass: `npm run check`
- [ ] 8.3 Unit tests pass: `npm run test:unit`
- [ ] 8.4 Integration tests pass: `npm run test:integration`
- [ ] 8.5 Each unique external URL is requested at most once per run
- [ ] 8.6 A 429 with `Retry-After` defers rather than retrying immediately
- [ ] 8.7 A host rejecting HEAD is retried with GET
- [ ] 8.8 A burst of dead external hosts does not abort the main crawl
- [ ] 8.9 An incomplete external sweep produces no `link_external_broken` findings
- [ ] 8.10 The limiter is not exported from `crawler.ts`

#### Manual

- [ ] 8.11 A real run's external check completes in a duration proportionate to its unique external URLs
- [ ] 8.12 No third-party host receives a burst that a reasonable operator would object to

### Phase 9: Redirect chains and loops

#### Automated

- [ ] 9.1 Type checking passes: `npm run typecheck`
- [ ] 9.2 Linting and formatting pass: `npm run check`
- [ ] 9.3 Unit tests pass: `npm run test:unit`
- [ ] 9.4 Integration tests pass: `npm run test:integration`
- [ ] 9.5 End-to-end tests pass: `npm run test:e2e`
- [ ] 9.6 Every existing page-identity test in `crawler.test.ts` passes unchanged
- [ ] 9.7 A two-hop chain produces one `redirect_chain` finding naming both hops
- [ ] 9.8 A redirect loop is reported as `kind: "loop"`, not as a fetch error
- [ ] 9.9 A single hop produces no finding
- [ ] 9.10 A trailing-slash-only difference produces no finding
- [ ] 9.11 A fixture crawl still records the same page count as before this phase

#### Manual

- [ ] 9.12 A run against the fixture reports the same pages, statuses and existing findings as before
- [ ] 9.13 Chain findings read as the site's redirects, never as our normalisation

### Phase 10: Real-site proof

#### Automated

- [ ] 10.1 Full suite passes: `npm run test:all`
- [ ] 10.2 The crawl completes without aborting

#### Manual

- [ ] 10.3 Page count is 533, unchanged from the three prior runs
- [ ] 10.4 The 34 `metadata_duplicated` findings persist unchanged
- [ ] 10.5 Every new finding is spot-checked live and judged true
- [ ] 10.6 No false positive is found in any of the ten new rules
- [ ] 10.7 Run duration is within the prior band plus a stated allowance for the new requests
- [ ] 10.8 Readability: ten new rules have not swamped the existing fourteen
- [ ] 10.9 Per-rule verdict recorded — true positive, or correctly silent — with no blurring
