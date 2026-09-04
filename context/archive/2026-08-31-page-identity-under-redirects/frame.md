# Frame Brief: Page identity under redirects

> Framing step before /10x-plan. This document captures what is *actually*
> at issue, separated from what was initially assumed.

## Reported Observation

A finding against yazaki-emea.com reads:

```
19 pages in this set do not all point at each other
  /bg/careers — does not link to /de/careers (de)
  /bg/careers — does not link to /es/careers (es)
  …
```

Verified false by fetching the page. `/bg/careers` returns 200 from
`/bg/karieri` and declares eleven alternates including `de → /de/karriere`. Its
hreflang is correct and complete. Four such findings exist, all under
`/careers`.

## Initial Framing (preserved)

- **User's stated cause**: redirect aliases are recorded as separate pages, so
  `/bg/careers` and `/bg/karieri` both become members of the same family.
- **User's proposed direction**: record `response.url` instead of the requested
  `url` at `src/server/crawl/crawler.ts:236`.
- **Pre-dispatch narrowing**: both the false finding *and* the inflated page
  count matter; a page is "the URL it finally lands on"; the spread beyond the
  `/careers` families has not been looked at.

## Dimension Map

The observation could originate at any of these:

1. **Recording** — the crawler stores the URL it requested, not the one it
   landed on. ← initial framing
2. **Deduplication** — the frontier decides "already seen" from the requested
   URL, before any fetch, so two aliases are two visits.
3. **Grouping** — union-find joins whatever URLs the hreflang graph connects; it
   has no notion that two of them are the same page.
4. **Rule comparison** — rule 5 asks "does this page declare *this sibling
   URL*", not "does this page declare *this language*".
5. **URL canonicalisation** — `normaliseUrl` settles spelling (scheme, hash,
   query, trailing slash) and knows nothing about redirects.

## Hypothesis Investigation

| Hypothesis | Evidence | Verdict |
| --- | --- | --- |
| 1. Recording keeps the requested URL | `crawler.ts:236` returns `url`, not `response.url`, after fetching with `redirect: "follow"`. `/bg/careers` → `/bg/karieri` confirmed live. | **STRONG** |
| 2. Dedup keys on the requested URL | `crawler.ts:324–326` checks and fills `seen` at enqueue time, before any request. Both aliases enter the frontier and both are fetched. | **STRONG** |
| 3. Grouping cannot tell aliases apart | `variants.ts` unions on declared targets only. Correct given its inputs — it is being handed two URLs and told they are different pages. | WEAK — consequence, not cause |
| 4. Rule compares URLs, not languages | `findings.ts` rule 5 tests `member.declares.has(sibling.url)`. Would misfire on any family holding two URLs for one locale, redirects or not. | WEAK — real latent flaw, but not what fired here |
| 5. `normaliseUrl` is insufficient | It handles scheme, hash, query and trailing slash (`crawler.ts:72–90`). A redirect is a server fact, not a spelling difference; no canonicaliser could know it without asking. | NONE — working as designed |

**The pressure test changed the answer.** Testing hypothesis 1 on its own
surfaced that it is *insufficient and unsafe alone*:

- The run holds **569 rows and 569 distinct URLs**. That uniqueness is
  incidental — it holds only because `seen` dedupes on the requested URL.
- `pages` has **no unique constraint** on `(runId, url)` — only plain indexes
  (`schema.ts:293–295`).
- So recording the final URL without also fixing dedup inserts `/bg/careers` and
  `/bg/karieri` as **two rows carrying the same URL**, and the grouping
  back-fill (`run.ts`, `WHERE runId AND url`) updates both.

The proposed one-line change would trade a duplicate-URL problem for a
duplicate-row one, in a table with nothing to catch it.

## Narrowing Signals

- **"A page is the URL it finally lands on."** Decisive. It rules out treating
  each alias as its own page, and makes identity — not reporting — the subject.
- **Both the finding and the page count matter.** Rules out fixing rule 5 alone:
  that would silence the false finding while leaving 569 an overcount.
- **77 of 569 stored pages sit in the `/careers` cluster**, where the aliasing
  concentrates. A 14-page random sample found 1 alias, so the distortion is
  real but uneven — not a uniform inflation that could be waved away.

## Cross-System Convention

Crawlers conventionally treat the post-redirect URL as the resource and the
requesting URL as an edge into it. Nothing in this codebase does that yet:
`CrawledPage` carries a single `url` field with no notion of "asked for" versus
"arrived at".

Worth knowing: **FR-016 already commits to reporting redirect chains**, assigned
to slice S-04. That is a different job — S-04 *reports* redirects as findings;
this change stops them *distorting identity*. They touch the same data, so
recording the final URL is groundwork S-04 will need rather than a conflict with
it.

## Reframed Problem Statement

> **The actual problem to plan around is**: the crawl has no concept of page
> identity separate from the URL it happened to request, and that assumption is
> baked into three places at once — what gets recorded, what gets deduplicated,
> and what the rules compare.

The initial framing named the right defect but the wrong scope. Changing where
identity is *recorded* without changing where it is *deduplicated* moves the
duplication rather than removing it, and does so into a table with no constraint
to catch it. Identity has to be established once and applied consistently at
every point that currently assumes "the URL we asked for".

Rule 5's URL-versus-language comparison is a genuine second defect, but it is
not what produced this finding and should not be folded into the same
statement — it would misfire on a site with two canonical URLs for one locale
and no redirects at all.

## Confidence

**HIGH** — every hypothesis was tested against code and live data rather than
inference; the user's identity position is decisive; and the pressure test
falsified the simplest version of the fix rather than confirming it.

## What Changes for /10x-plan

Plan for page identity, not for a field assignment. The plan must decide where
identity is established, how the frontier avoids fetching two routes to the same
page, and what happens to rows already written when a later alias resolves to a
page already stored — and it must state whether rule 5's URL comparison is in
scope or deferred.

## References

- `src/server/crawl/crawler.ts:236` — records the requested URL
- `src/server/crawl/crawler.ts:324–326` — dedup at enqueue, pre-fetch
- `src/server/crawl/crawler.ts:72–90` — `normaliseUrl`
- `src/server/db/schema.ts:293–295` — page indexes, no uniqueness
- `src/server/crawl/findings.ts` — rule 5 sibling-URL comparison
- `context/foundation/prd.md:206` — FR-016, redirect chains (S-04)
- `context/foundation/lessons.md` — "Trace every finding to the site's own
  assertion"; this observation is its fourth instance
- Live evidence: `/bg/careers` → `/bg/karieri`, `/fr/careers` →
  `/fr/carrieres`, `/de/careers` → `/de/karriere`, all 200 with correct hreflang
