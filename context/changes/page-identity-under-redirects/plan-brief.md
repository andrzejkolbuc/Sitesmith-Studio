# Page identity under redirects — Plan Brief

> Full plan: `context/changes/page-identity-under-redirects/plan.md`
> Frame brief: `context/changes/page-identity-under-redirects/frame.md`

## What & Why

The crawl has no concept of page identity separate from the URL it happened to
request, and that assumption is baked into three places at once — what gets
recorded, what gets deduplicated, and what the rules compare. On a real client
site it produced four findings accusing pages of not linking to siblings they
link to correctly.

## Starting Point

`/bg/careers` serves 200 from `/bg/karieri`, and both are stored as separate
pages. The `/careers` family swells to 19 members, and rule 5 reports each
member for failing to link to URLs that are themselves aliases. Page URLs are
unique per run today only because the frontier deduplicates on the requested
URL — there is no constraint enforcing it.

## Desired End State

A page is the URL the server served. Two routes to it produce one row, one
family member, one entry in the page count. Rule 5 asks whether a page declares
a *language*, so it stays quiet when a family legitimately holds two URLs for
one locale.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| What is a page | The URL it finally lands on | Aliases are routes to a page, not pages | Frame |
| Scope | Both the false finding and the inflated count | Fixing the rule alone leaves 569 an overcount | Frame |
| Dedup strategy | Discard after the fetch | One code path, no extra requests; handles chains and loops because the server always answers | Plan |
| Alias record | Drop silently | An alias is a route; recording it means a column nothing consumes until S-04 | Plan |
| Rule 5 | In scope, separate phase | Identity alone leaves it live for any site with two canonical URLs per locale; separate phase keeps attribution clear | Plan |
| Uniqueness | Unique index on `(runId, url)` | The defect existed because an invariant was assumed rather than enforced | Plan |
| Relative hrefs | Fixed in the same phase | Same root cause; leaving it means the identity fix is half done | Plan |
| Existing run | Kept, re-crawled after | The before/after is the clearest proof, and deleting evidence of a bug is a bad habit | Plan |

## Scope

**In scope:** recording the served URL; post-fetch deduplication; relative
hreflang and link resolution; a unique index on `(runId, url)`; redirect support
in the fixture; rule 5 comparing languages rather than URLs; a verification
re-crawl.

**Out of scope:** reporting redirects as findings (FR-016, slice S-04);
remembering which aliases were requested; pre-flighting URLs with HEAD;
`normaliseUrl`; deleting the existing yazaki run.

## Architecture / Approach

Identity is established at one point — the moment a response returns — and
everything downstream uses it. The existing pre-fetch dedup stays (it still
saves a request when two links spell the same URL); a second check after the
response stops an alias being *recorded* twice. The unique index lands in the
same phase as that check, never earlier, or an alias-heavy crawl would start
failing inserts.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Page identity in the crawl | Served URL recorded, aliases discarded, relative hrefs resolved correctly, uniqueness enforced | The unique index landing before the dedup would break alias-heavy crawls |
| 2. Rule 5 asks about languages | A family with two URLs per locale stays quiet | No real failing case exists — the test must be constructed |
| 3. Verify against yazaki | Before/after proof on the site that found it | Needs a real-site run, so it cannot be closed from here alone |

**Prerequisites:** the yazaki project and its existing run stay in the
development database; a dev server free of Next's dev lock for phase 3.
**Estimated effort:** ~1–2 sessions across three phases.

## Open Risks & Assumptions

- **An alias still costs a request.** Roughly 77 in yazaki's `/careers` cluster
  now produce no page. Deliberate: the alternative doubles requests against
  every client site.
- **The page ceiling now bounds recorded pages, not requests**, so a heavily
  aliased site makes more requests than the ceiling implies. Still bounded by
  the frontier.
- **Phase 2 has no real failing case.** Every observed instance was caused by
  aliases, so its test is constructed rather than reproduced — weaker evidence
  than phases 1 and 3.
- **Phase 3 depends on a real site.** It closes from evidence you gather, not
  from anything the suite can assert.

## Success Criteria (Summary)

- A redirected page is recorded once, under the URL the server served, with its
  relative hrefs resolved against that URL.
- Re-crawling yazaki-emea.com drops the 4 false `/careers` findings, keeps the 8
  genuine divergences, and reports fewer than 569 pages.
- No finding names a page that turns out, on inspection, to be fine.
