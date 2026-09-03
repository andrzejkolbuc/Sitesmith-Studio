---
date: 2026-09-02T23:12:27+02:00
researcher: Andrzej Kolbuc
git_commit: 053b3e607171e2e68962238b93715b5af3f5cf90
branch: master
repository: Sitesmith-Studio
topic: "S-04 crawl-technical-checks: what the six requirements actually require, given what S-01/S-03/S-05 already ship"
tags: [research, codebase, crawl, findings, robots, sitemap, links, redirects, tls, duplicates]
status: complete
last_updated: 2026-09-02
last_updated_by: Andrzej Kolbuc
---

# Research: S-04 crawl-technical-checks

**Date**: 2026-09-02T23:12:27+02:00
**Researcher**: Andrzej Kolbuc
**Git Commit**: `053b3e6`
**Branch**: master
**Repository**: Sitesmith-Studio

## Research Question

What does S-04 actually require building — FR-016 (broken internal and external links,
redirect chains and loops), FR-017 (sitemap↔crawl reconciliation), FR-018 (robots.txt
rules blocking pages intended to be indexable), FR-019 (orphan pages), FR-020 (duplicate
titles and near-identical content across URLs), FR-030 (security header and certificate
problems) — given what S-01, S-03 and S-05 already collect and compute? And how should six
unrelated implementations be phased or split?

## Summary

**Six requirements, four unrelated implementations, and one axis that separates them
cleanly: what each costs the client's site.** Three of the six can be built with *no new
outbound requests at all*; two more need exactly two cheap requests; the remainder —
external link checking, redirect chains, and the certificate probe — is the first work
since S-01 to change the load this product places on someone else's infrastructure. That is
the recommended split, proposed in full at the end.

Five findings drive everything else:

1. **The crawl computes far more than it keeps.** `CrawledPage` carries eight fields;
   `run.ts` persists five columns. `links`, `content`, `metadata` and `xRobotsTag` are
   computed for every page, consumed in-process, then discarded. The only durable copy of
   any of it is whatever a rule chose to quote into a finding's `detail` blob. FR-019 and
   FR-020 are storage-or-in-memory-index questions before they are rule questions.

2. **Rules are strictly pure, and there is no seam for an impure one.**
   `detectMissingVariants` is one 970-line *synchronous* function holding 14 inline rule
   blocks. No registry, no rule interface, no severity or confidence field. Everything S-04
   needs to fetch — sitemap, robots.txt, external links, a TLS handshake — must be fetched
   in the crawl phase and handed to the rules as data.

3. **The crawler does not obey robots.txt, and that is what makes FR-018 buildable.**
   Frontier admission is same-origin plus operator-configured include/exclude paths, full
   stop. Disallowed pages are crawled today with full markup. FR-018 therefore needs no
   reconciliation channel — but the advantage is contingent, and the plan must record the
   dependency rather than inherit it.

4. **FR-020's duplicate-title clause is already shipped, with one real gap.**
   `metadata_duplicated` covers titles *and* descriptions, validated at 34 findings over
   114 of 533 pages with no false positive. But it skips every page whose locale is null —
   so on a monolingual site it finds nothing, and FR-020 sits in a slice whose only
   prerequisite is S-01.

5. **"Near-identical" and "intended to be indexable" both have threshold-free
   formulations, and this project has found that move twice before.** Each time a threshold
   was proposed, an exact-equality proxy caught the same real defects.

## Detailed Findings

### 1. What the crawl already has, and what it throws away

`CrawledPage` — [crawler.ts:51-89](src/server/crawl/crawler.ts:51) — carries `url` (the
**served** URL after redirects, normalised), `httpStatus`, `hreflangTargets`, `links`,
`content` (a `ContentSummary`), `metadata` (a `PageMetadata`), `xRobotsTag`, `fetchError`.

The `pages` table — [schema.ts:262-311](src/server/db/schema.ts:262) — has `id`,
`tenantId`, `runId`, `url`, `httpStatus`, `locale`, `variantGroupKey`, `hreflangTargets`,
`fetchError`, `createdAt`. The insert at [run.ts:163-170](src/server/crawl/run.ts:163)
writes five columns.

**So `links`, `content`, `metadata` and `xRobotsTag` never reach the database.** S-05 chose
this deliberately ("Not persisting metadata. No columns, no migration. Detection is
in-memory and the finding's `detail` carries the evidence"). The pattern generalises: a
robots.txt body and a parsed sitemap can be fetched once, held in memory, passed into the
detector, and quoted into `detail`. **No migration is required for FR-017, FR-018, FR-020
or the security-header half of FR-030.**

**Two headers are read, not one.** [crawler.ts:244](src/server/crawl/crawler.ts:244) reads
`content-type`; [crawler.ts:262](src/server/crawl/crawler.ts:262) reads `x-robots-tag`. The
doc comment at [crawler.ts:74-86](src/server/crawl/crawler.ts:74) states why the `Headers`
object is not retained: it "would multiply an unbounded structure by the two-thousand-page
ceiling". **That is the exact precedent FR-030's header half should follow** — name the
specific headers wanted as fixed capped string fields. `Strict-Transport-Security`,
`Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`
and `Permissions-Policy` are all sitting on the response at line 244 and dropped.

**Links are extracted but not scope-filtered, despite the comment saying so.**
[crawler.ts:57](src/server/crawl/crawler.ts:57) documents `links` as "Absolute, in-scope
URLs"; [extractLinks at crawler.ts:160-173](src/server/crawl/crawler.ts:160) applies no
scope filter at all. Scoping happens at enqueue time
([crawler.ts:373-378](src/server/crawl/crawler.ts:373)). **External links are already in
memory today** and simply never enqueued. FR-016's external half needs no new extraction —
only retention and a fetch phase. The comment should be corrected as part of this work.

Not captured at all: `rel="nofollow"`, anchor text, `<img src>`, `<script src>`, and
`<link>` hrefs other than `rel=alternate`/canonical.

**There is no link table and no reverse index.** Nothing can answer "which pages link to X"
at any price without new storage or an in-memory index built before `result.pages` goes out
of scope. That is FR-019's precondition.

### 2. The rules architecture

`detectMissingVariants` — [findings.ts:120](src/server/crawl/findings.ts:120) — takes
`DetectOptions { pages, expectedLocales, inScope, crawlComplete }` and returns `Finding[]`.
**Synchronous.** Roughly 90 test call-sites call it synchronously.

There is no rule registry and no rule interface. A rule is a `// ── Rule N: … ──` banner
plus a loop pushing onto a shared array, sharing closures with its neighbours. Ordering is
semantically load-bearing: rule 6 runs before rules 2/3 because it populates `collapsed`;
rule 5 runs before rule 4 because it populates `describedByFamily`.

**Adding a finding type is a ten-touchpoint checklist**, of which three are the ones people
forget:

- `pagesInvolved` in [summarise.ts:66-133](src/app/(app)/projects/[id]/summarise.ts:66) —
  its `default` returns `one(finding.url)`, so a site-wide finding that omits a case
  **silently reports zero pages**. Every FR-017/018/019/020 finding is site-wide by nature.
- The `Evidence` switch in
  [run-panel.tsx:526-935](src/app/(app)/projects/[id]/run-panel.tsx:526) — its `default`
  dumps raw JSON, and `e2e/journeys/first-crawl.spec.ts:177-196` fails the build if a
  rendered finding starts with `{"`.
- Every hand-built `CrawledPage` literal in the tests must gain any new field.

No schema change is needed per rule: `findings.type` is `varchar(64)` and `detail` is
`jsonb`. Watch the 64-character cap.

**Confidence is structural, not a field.** Grepping for `confidence|severity|priority`
returns nothing relevant. Trustworthiness is expressed three ways: narrowing a rule until it
cannot fire on a legitimate site; the `crawlComplete` gate on any rule reasoning from
*absence*; and roughly half of `findings.ts` being one rule deferring to another to avoid
double-reporting. S-04 must decide, explicitly, how a broken-internal-link finding relates
to the existing `hreflang_target_failed` and `canonical_target_broken`.

**Site-wide rules are already supported**, two ways: family-scoped via `groupFamilies`, and
whole-corpus with no families at all. `metadata_duplicated`
([findings.ts:758-812](src/server/crawl/findings.ts:758)) and `canonical_missing`
([findings.ts:868-891](src/server/crawl/findings.ts:868)) are the two shapes to copy — the
latter is a two-pass corpus rule that carries the corpus-level fact into each finding's
detail, which is exactly what a sitemap-reconciliation rule wants.

### 3. FR-016 — broken links and redirect chains

**Internal broken links are nearly free.** An in-scope link that 404s was itself enqueued
and fetched, so its status is already a `pages` row. What is missing is only the attribution
— *which* page links to it — i.e. the link graph from §1.

**External links are the expensive half, and the politeness model was never designed for
them.** `claimSlot` ([crawler.ts:222-230](src/server/crawl/crawler.ts:222)) serialises
request *starts* globally; there is **no per-host accounting**, because the crawl is
same-origin by construction. Four specific hazards:

- **429 is invisible to every safety mechanism.** Failure is
  `fetchError !== null || httpStatus >= 500`
  ([crawler.ts:324](src/server/crawl/crawler.ts:324)). A 429 is neither a burst failure nor
  a rate failure — the crawl keeps hammering a host explicitly telling it to stop.
  Acceptable against a client site you were invited to crawl; a real hazard against
  strangers' hosts.
- **The abort counters are global to the run.** Five consecutive dead third-party hosts will
  abort the crawl of the client's site.
- **No response size cap** — flagged as "the obvious next hardening" in
  politeness-under-stress, and it becomes likely rather than theoretical once third-party
  bodies are fetched.
- **HEAD pre-flighting was rejected** by page-identity ("would double the requests made
  against a client's site, against NFR-1"). Using HEAD for *external* links is defensible —
  external hosts are not the client — but the argument must be made, not assumed.

**Redirect chains need a mechanism that does not exist.** The crawler uses
`redirect: "follow"` ([crawler.ts:239-242](src/server/crawl/crawler.ts:239)), so
`response.status` is always the final hop's and **no page in any run has a 3xx status**.
Worse, when a second route reaches an already-recorded page it is discarded outright
([crawler.ts:303-316](src/server/crawl/crawler.ts:303)) — 36 such aliases on the real client
site. That deleted alias→target edge *is* FR-016's evidence.

This is pre-negotiated rather than a conflict: page-identity's `frame.md` states that
recording the final URL is "groundwork S-04 will need", and aliases were dropped because
recording them "means a column nothing consumes **until S-04**". Reintroducing an alias
record honours that decision. But the mechanism — `redirect: "manual"` with a hand-rolled
hop loop and a hop cap for loops — touches the load-bearing identity logic and its tests,
and page-identity's own criteria 1.13 and 2.9 are still open. **Treat it as a careful
change, not a flag flip.** Note also that a redirect *loop* currently surfaces as an
undifferentiated `fetchError` from the runtime's own 20-hop limit, which counts as a
politeness failure and can abort the run.

**The unfixed scar directly under FR-016.** cross-variant-content-drift recorded a page that
answered 200 on five consecutive re-fetches being recorded 502 by the crawl and reported: "a
true observation at crawl time and a false statement about the site". FR-016 is a whole
slice of rules resting on one-shot HTTP status. **Re-verification before reporting is a
decision the plan must make explicitly.**

### 4. FR-017 and FR-018 — the site-control channel

**Nothing exists.** `grep` for `robots.txt` and `sitemap` across all source, test, script and
config returns zero hits; every hit is in `context/`. `git log -S` confirms it was never
otherwise. No XML dependency, no robots parser, no gzip helper imported. The
politeness-under-stress lead was false — that change delivered a failure-*rate* abort.

Both were deferred to S-04 **in writing, twice**: first-multilingual-crawl declined
robots.txt ("Robots validation arrives as a *finding* in S-04; honouring it as a *constraint*
is a separate decision") and sitemap discovery ("Link-following only. Sitemap reconciliation
is FR-017 in S-04"); S-05 re-affirmed it.

**The crawler does not obey robots.txt.** `inScope`
([crawler.ts:117-136](src/server/crawl/crawler.ts:117)) is same-origin plus
`excludePaths`/`includePaths` from the project row. So disallowed pages are crawled today
with full markup, status, canonical and both robots channels captured. Corroborated
operationally: the first real-site run had "the path `robots.txt` disallows excluded by
hand" — a human read it and transcribed it, because the crawler would otherwise have walked
in. **FR-018 can be built from crawl data plus one robots.txt fetch.** Record the
dependency: if obedience is ever adopted, FR-018 inverts into the hard world and goes silent.

**`parseRobotsHeader` is not reusable.** `X-Robots-Tag` and `<meta name="robots">` are
*indexing* directives — page-level, comma-separated, observable only after fetching.
robots.txt is a *crawling* directive — path-level, line-oriented `User-agent` groups with
`Allow`/`Disallow` patterns. Orthogonal; conflating them yields a rule wrong in both
directions. A parser must be written from scratch: group selection by user-agent
(longest-match-wins, `*` as fallback), `*`/`$` wildcards, most-specific-match precedence with
`Allow` winning ties, empty `Disallow:` meaning allow-all, `Sitemap:` collected
group-independently. What *does* transfer is the closed-vocabulary discipline of
[metadata.ts:196-223](src/server/crawl/metadata.ts:196) and rule 14's `indexingChannels` idea
— recording the channels that published directives and did *not* carry the defect, because
that explains why nobody noticed.

**FR-018's inference problem has a clean answer.** "Intended" is a claim about a human's
mental state; nothing observable is intent. The rescue is to replace intent with a
**contradiction between two things the same publisher asserted on the same host**. Ranked:

- **R1 — sitemap lists X ∧ robots.txt disallows X.** Two direct, opposing assertions.
  Statable entirely in quotation: the loc, the sitemap's source channel, the verbatim
  `Disallow` line and its `User-agent` group. **Depends on the crawl not at all**, so it is
  immune to `crawlComplete`, the page ceiling, redirect identity and `excludePaths` — it
  survives a truncated run. Has an external oracle: this is Google Search Console's "Indexed,
  though blocked by robots.txt". Ship this one, possibly alone.
- **R2 — Disallow matches X ∧ crawl fetched X at 200 ∧ X carries an explicit `index`/`all`
  directive.** Computable only because we don't obey. The requirement is `index` present,
  **never absence-of-`noindex`** — silence is not an assertion, and that constraint is what
  keeps it on the right side of lessons.md. Ranked lower because `content="index, follow"` is
  often an unconsidered template default (12/12 sampled pages on the real client).
- **R3 — Disallow matches X ∧ another page declares X as its hreflang alternate or canonical
  target.** Weakest; ship only if R1/R2 prove silent.
- **Rejected in writing: internal links as the trigger.** It fires on `/search`, `/cart`,
  `/login`, faceted nav and print views — the canonical *correct* uses of `Disallow`. It is
  also the formulation most likely to be reached for, since `page.links` is already
  collected. Reject it explicitly in "What We're NOT Doing".

**Which user-agent group to evaluate is a real decision that reads backwards.** We send no
distinct user-agent, so on paper our group is `*`. But FR-018 asks about *search indexing*,
and Googlebot ignores `*` entirely when a `googlebot` group exists — so a site with
`User-agent: googlebot / Disallow: /` and a permissive `*` is catastrophically blocked in the
way that matters, while evaluating `*` reports nothing. Evaluate `googlebot` falling back to
`*`, mirroring `ROBOTS_META_NAMES`, and put the group name and verbatim rule line in every
finding's detail.

**FR-017's URL-identity discipline.** `normaliseUrl`
([url.ts:20-39](src/server/crawl/url.ts:20)) clears the hash *and the entire query string*
and strips trailing slashes, and its own doc comment is the governing instruction: "Any
comparison between a URL the site published and a URL the crawl recorded has to pass both
sides through here". Six failure modes, in pipeline order: XML-entity-decode and CDATA first;
normalise; dedupe *after* normalising (a sitemap listing `?page=1..20` collapses to one URL —
reporting nineteen missing would be a pure artifact); **partition by origin before comparing**
(a sitemap on `www.` against a crawl on the apex produces zero matches and would report
*every* page absent); apply `inScope`; do not case-fold paths.

**And the redirect trap, which has no precedent yet.** A sitemap loc that 301s to a canonical
URL was fetched successfully, is perfectly healthy, and never appears in `result.pages` under
its own name. Deriving "sitemap URL failed" from absence would report the site's own tidy
redirects as broken entries — the alias false positive re-emerging in a third setting. Two
ways out: fetch each loc directly and report its actual status (stronger evidence, matches the
requirement's wording, costs requests that must share the pacer), or retain the crawler's
requested-URL set alongside the recorded set.

**Direction asymmetry is worth exploiting.** "Live pages absent from the sitemap" reasons from
the sitemap's completeness plus a *positive* crawl observation, so **it does not need
`crawlComplete`** — truncation can only make it quieter, never wrong. That is stronger footing
than most rules in `findings.ts`. It does need exclusions, or it fires on pages a sitemap is
correct to omit: non-200 pages, `noindex` pages, and pages whose canonical points elsewhere.

**One more provenance point:** the site's actual assertion is the `Sitemap:` directive in
robots.txt. `/sitemap.xml` is a convention we guess at — so a **404 there is not evidence the
site has no sitemap** and must not become a finding. Prefer the declaration, fall back to the
convention, record which channel supplied it, stay silent when neither yields one.

### 5. FR-019 — orphans

By the requirement's own wording ("reachable via sitemap but linked from nowhere") this needs
both channels: the sitemap from §4 and the link graph from §1. It is an absence-reasoning rule
and **must gate on `crawlComplete`** — this is precisely the guard written after a truncated
run reported its own page ceiling as eighteen defects on a live client site, naming URLs that
all return 200.

### 6. FR-020 — duplicates, mostly shipped, one real gap

**`metadata_duplicated`** ([findings.ts:734-816](src/server/crawl/findings.ts:734)) compares
title *and* description, exact and case-sensitive after `plainText` normalisation, keyed by
`JSON.stringify([field, language, value])` (deliberately JSON rather than a delimiter, because
any delimiter is one a page could publish), scoped **whole-site within a primary language
subtag**, emitting `url: null` with all URLs as peers. Real-site result: 34 findings over 114
of 533 pages, 12 on titles and 22 on descriptions, no false positive.

**It over-delivers on FR-020's title clause — and has one gap that matters here.**
[findings.ts:774](src/server/crawl/findings.ts:774) skips any page whose locale is null,
pinned by an explicit test
([site-shapes.test.ts:1528-1542](src/server/crawl/site-shapes.test.ts:1528)). Locale comes
from self-referential hreflang, a sibling's declaration, or a locale-shaped first path segment
— so **on a monolingual site with no hreflang and no `/en/` prefix, every locale is null and
the rule finds nothing.** That gap is correct within S-05's framing ("duplicate *in that
language*"), but FR-020's clause is "across URLs", unqualified, in a slice whose only
prerequisite is S-01. The 114/533 result is evidence about a multilingual site and is silent
about the monolingual case. **This is the highest-leverage call in the slice.**

**Exact-duplicate content across URLs is a rewiring, essentially free.** Rule 7
([findings.ts:552-631](src/server/crawl/findings.ts:552)) is already a
`Map<digest, members[]>` group-by, not a pairwise comparison — the family scoping is a loop
bound, not an algorithmic constraint — and `textDigest` is computed for every page at
[crawler.ts:269](src/server/crawl/crawler.ts:269) regardless of family membership. The
all-pairs figure (533×532/2 ≈ 142,000) is irrelevant. The change is: iterate `pages` instead of
`family.members`, and drop the ≥2-languages gate that currently suppresses exactly the
same-language case FR-020 wants. Zero new fields, zero new numbers.

Three guards to carry over, each already defended elsewhere: `isolated === true` on every
member (rule 8's guard — *more* important across URLs than within a family, because templates
differ and comparing an isolated `<main>` digest against a whole-body fallback compares
different regions); `MIN_COMPARABLE_CHARS`, inherited free via `textDigest === null`; and
suppression of sets the site has already resolved — two URLs serving identical content where
one canonicalises to the other is correct behaviour, and S-05's canonical machinery already
identifies it.

**Near-identical content is an algorithmic redesign, not a rewiring.** SHA-256 is avalanche by
construction: the existing fingerprint carries *zero* similarity information, and
[content.ts](src/server/crawl/content.ts) says so deliberately — "equality of digests means
equality of normalised text and nothing weaker". Nothing else in `ContentSummary` helps:
`blocks` is 5 bits, `markers` is 2, and comparing `textLength` *is* the deferred word-count
signal in another unit. A near-identical rule needs a new fingerprint (shingles + minhash, or
simhash) on a summary the plan constrains to fixed-size × 2000 pages, plus the similarity
threshold this project has refused twice.

### 7. FR-030 — security headers and certificates

**Two halves with completely different costs.** The header half needs no probe at all — the
headers are in hand at [crawler.ts:244](src/server/crawl/crawler.ts:244) and merely discarded.
Read them as named capped strings exactly as `xRobotsTag` is.

The certificate half cannot be reached from the current client. Native `fetch` (undici, via
Node 20+/Next 16) is the only HTTP client in the repo — no axios, no `node:https`, no
`node:tls` anywhere — and a WHATWG `Response` exposes no socket and no peer certificate.
Recommendation: a separate `node:tls.connect({ host, port: 443, servername })` →
`getPeerCertificate()` probe yielding issuer, subject, `valid_from`, `valid_to`,
`subjectaltname`. **One handshake per origin, not per page** — a single step costing nothing
against the politeness budget, in a clean new module with no changes to `crawler.ts`. Note it
is nonetheless a channel the politeness model has never governed, and FR-030 is the only
requirement here with no prior decision anywhere in `context/`.

## Code References

- `src/server/crawl/crawler.ts:51-89` — `CrawledPage`; eight fields, five persisted
- `src/server/crawl/crawler.ts:117-136` — `inScope`; the entire frontier policy, robots-free
- `src/server/crawl/crawler.ts:160-173` — `extractLinks`; no scope filter despite the comment
- `src/server/crawl/crawler.ts:222-230` — `claimSlot`; the pacer, private to `crawl()`
- `src/server/crawl/crawler.ts:239-273` — the only `fetch()` in the codebase
- `src/server/crawl/crawler.ts:303-316` — where alias pages are discarded
- `src/server/crawl/crawler.ts:324` — the failure definition; 429 is invisible to it
- `src/server/crawl/url.ts:20-39` — `normaliseUrl`; both sides of every comparison
- `src/server/crawl/content.ts:82-93` — `MIN_COMPARABLE_CHARS`, floor-vs-tuning-knob
- `src/server/crawl/findings.ts:552-631` — rule 7, the reusable hash group-by
- `src/server/crawl/findings.ts:734-816` — rule 10, FR-020's title clause, already shipped
- `src/server/crawl/findings.ts:868-891` — rule 11, the two-pass corpus shape FR-017 wants
- `src/server/crawl/findings.ts:1005-1088` — rule 14, both robots channels
- `src/server/crawl/metadata.ts:196-278` — closed-vocabulary discipline; `parseRobotsHeader`
- `src/server/crawl/variants.ts:251-271` — locale precedence, source of the FR-020 gap
- `src/server/crawl/site-shapes.test.ts:1528-1542` — the test pinning that gap
- `src/server/crawl/run.ts:43` — `MAX_PAGES = 2_000`, hardcoded, not per-project
- `src/server/crawl/run.ts:155-207` — the phase sequence; where S-04 hooks in
- `src/server/db/schema.ts:262-311` — the `pages` table; no links, metadata or headers
- `src/app/(app)/projects/[id]/summarise.ts:66-133` — `pagesInvolved`; omit a case, report zero pages
- `src/app/(app)/projects/[id]/run-panel.tsx:526-935` — the `Evidence` switch

## Architecture Insights

- **Politeness lives inside the fetch loop so callers cannot opt out.** Any new outbound
  request — sitemap locs, external links, TLS — either shares that pacer or documents why it
  is exempt. The pacer is currently a closure private to `crawl()`; sharing it means
  extracting it, which modifies the module whose whole purpose is that guarantee.
- **Site-level facts already reach the rules.** `CrawlResult` carries `abortedReason` and
  `reachedPageLimit`, which `run.ts` folds into `crawlComplete`. Widening it with a parsed
  sitemap, a parsed robots.txt and a TLS observation follows an existing precedent and keeps
  rules pure.
- **Suppression is the design discipline, not an afterthought.** Half of `findings.ts` is
  about *not* reporting things. S-03's research put it plainly: a content rule that ignores
  this "will be the seventh rule and the fifth false-positive class."
- **The oracle rule.** Expectations are written before a rule is run against a shape, and
  sourced from outside the implementation — "an expectation adjusted to match the output is
  just the output written twice." Four shipped rules were found wrong this way.
- **Every rule declares whose claim it rests on.** The S-05 template is a table: *Signal |
  Whose claim is it? | Oracle*. No oracle ⇒ a defended threshold or a deferral.

## Historical Context (from prior changes)

- `context/changes/first-multilingual-crawl/plan.md:58-63` — robots.txt and sitemap discovery
  both declined, both explicitly assigned here; a distinct user-agent also declined, still
  declined.
- `context/changes/page-identity-under-redirects/` — status `implemented`, two manual criteria
  (1.13, 2.9) still open. Aliases dropped because recording them "means a column nothing
  consumes until S-04". `frame.md:88-91` pre-negotiates the FR-016 coexistence.
- `context/archive/2026-08-25-politeness-under-stress/plan.md` — delivered the 30%
  failure-rate abort, *not* robots.txt. Known limits still open: no time budget, no response
  size cap.
- `context/archive/2026-08-25-detection-rule-confidence/` — the oracle discipline and
  `site-shapes.test.ts`. Confidence is a tiering convention, not a data model.
- `context/archive/2026-08-31-cross-variant-content-drift/` — word-count drift deferred
  ("entirely our inference… no external oracle at all"); the answer to a threshold was "not a
  threshold but a decomposition"; exact-digest matching chosen because "exact match needs no
  threshold". Also records the **transient-502 scar**, unfixed, now in FR-016's scope.
- `context/archive/2026-09-01-seo-metadata-checks/` — the length threshold measured against the
  real client (would fire on 5 of 12, "none of them a defect a human would name") and dropped;
  the stub descriptions it was meant to catch turned out to be duplicates anyway. The
  34-finding real-site result, and the honesty clause about not blurring "correctly silent"
  into "validated".
- **S-01 has exactly one open criterion, 2.9** — a real client site crawling "without errors in
  its monitoring", uncheckable from this side. It does not block (four slices shipped on top of
  S-01 in this state) but it **affects S-04 more than any of them**: 2.9 is the only unproven
  claim about the load this crawler places on someone else's infrastructure, and S-04 is the
  first slice since S-01 to add outbound requests at all. Every prior slice could truthfully
  write "no additional requests — NFR-1 is not engaged". S-04 cannot.

## Related Research

- `context/archive/2026-09-01-seo-metadata-checks/research.md` — the `normaliseUrl` comparison
  trap; the *Signal | Whose claim | Oracle* table; the three-place finding-type ritual.
- `context/archive/2026-08-31-cross-variant-content-drift/research.md` — Open Question 2 ("what
  defines substantially identical"), which FR-020 re-opens and which was answered "exact".

## Recommended phasing

**Split S-04 into three changes, along the axis of what each costs the client's site.** That
axis is the one NFR-1 cares about, the one S-01's single open criterion sits on, and it
happens to sort the six requirements cleanly.

**S-04a — no new outbound requests.** Security headers (FR-030 header half); duplicate content
across URLs by exact digest, plus the monolingual locale-null decision for
`metadata_duplicated` (FR-020); broken *internal* links via a link graph (FR-016 internal
half). Every finding traces to a site assertion, nothing new is fetched, and the slice can
write the same "NFR-1 is not engaged" line every prior slice wrote. Closes without the client's
monitoring access.

**S-04b — two cheap requests, one new channel.** robots.txt fetch and parser; sitemap fetch and
parser (index files, gzip, entity decoding, the `normaliseUrl` pipeline); FR-017 reconciliation
in both directions; FR-018 as R1 (sitemap ∧ Disallow); FR-019 orphans on top of S-04a's link
graph. Two requests per run is trivially inside the budget, so this also closes without
monitoring access.

**S-04c — the part that changes the load profile.** FR-016 external link checking (per-host
budget, 429 handling, isolation of external failures from the run-wide abort counters, a
response-size cap, and the HEAD argument); FR-016 redirect chains (`redirect: "manual"`, hop
recording, alias records — touching the just-proven identity path); FR-030's certificate probe.
This is the only part that needs a real conversation about load, and separating it means the
other five-sixths of the value is not held behind it.

**Defer explicitly, in writing, rather than by omission:** the near-identical-content
similarity ratio, as S-03 deferred word count — a signal that detaches cleanly and can be
attached later without touching S-04a. And record the entry requirement S-05 established: any
proposed threshold must state its number *and* its measured firing rate over the 533-page real
crawl, with every pair it would report judged by hand, **before** it is planned.

**Two things to carry into every phase:** the real-site proof phase as a code-free final step,
with a per-type before/after table written into `change.md`, a defect known in advance that
must appear, and any false finding blocking the slice. And **volume as a first-class acceptance
criterion** — there is no per-run findings cap and no suppression mechanism, and S-04 is the
highest-volume slice on the board.

## Open Questions

1. **Does the crawler start obeying robots.txt?** Reporting was pre-assigned here; honouring
   was explicitly declined and flagged as a separate decision. Make it in the open. FR-018 as
   formulated depends on continuing *not* to obey.
2. **Is one-shot HTTP status enough to call a link broken?** The transient-502 scar says no.
   Does FR-016 re-verify before reporting, and at what cost?
3. **Monolingual coverage for FR-020** — does `metadata_duplicated` keep its language scope,
   gain an unlocalised bucket, or grow a separate site-wide rule? Rule 7's locale guards exist
   to keep *untranslated-content* claims honest; they are not obviously right for a
   *duplicate-content* claim, where language is irrelevant to whether two URLs serve the same
   bytes. Deciding this deliberately, rather than by copying rule 7's guards along with its
   shape, is the single highest-leverage call in the slice.
4. **Are sitemap URLs crawled, or only reconciled?** This changes the request budget and
   interacts with the hardcoded 2,000-page ceiling.
5. **What suppresses a known-acceptable finding?** PRD Open Question 2 is still unresolved, and
   an external link that is permanently 403 to bots will be reported every run with no way to
   mute it.
6. **`MAX_PAGES` is hardcoded and not per-project**, which blocks a small bounded live probe
   going through `startRun` — the same wall S-01's real-site log hit.
