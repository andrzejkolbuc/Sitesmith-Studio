# Lessons Learned

> Append-only register of recurring rules and patterns. Re-read at start by /10x-frame, /10x-research, /10x-plan, /10x-plan-review, /10x-implement, /10x-impl-review.

## Trace every finding to the site's own assertion

- **Context**: Any detection rule in `src/server/crawl` that turns crawled data into a finding about a client's site.
- **Problem**: Four times now a rule has reported a defect on a client site that was not there: `x-default` read as a language, any two-letter path segment read as a locale, a truncated crawl's own ceiling reported as eighteen dead pages, and redirect aliases counted as distinct siblings. Each looked specific and cited real URLs.
- **Rule**: Every finding must be traceable to something the site itself asserted. If it depends on our inference or on how we collected the data, it is a claim about us, not about the client — and must not be reported as a defect on their site.
- **Applies to**: frame, plan, implement, impl-review

## Grouping by shared evidence is not grouping by shared cause

- **Context**: Anything that relates findings to each other — correlation, deduplication, ranking, or a report that says two problems are the same problem.
- **Problem**: The obvious key for "these findings are related" is the evidence they have in common. Measured on a real run, correlating findings that share a URL — with the URLs each finding already reports — put **66 of 67 findings into one group spanning all 533 pages**. Three wide findings did it: a single dead footer link names every page that points at it, so it is adjacent to everything. The grouping was not slightly too generous; it was total, and it would have shipped as "one problem" on a site with five.
- **Rule**: Relate findings on a key the *site* asserted about its own structure, not on evidence they happen to share. Ask which role a URL plays — the thing that is wrong, or the page that emits it — and correlate on the second only. A finding with no page that emits it (a sitemap or robots reconciliation) must be excluded structurally, because it is a statement about the corpus and will otherwise bridge everything it mentions. And prefer set equality to similarity: "the same families" needs no number, "similar enough families" needs one.
- **Applies to**: plan, implement, impl-review
