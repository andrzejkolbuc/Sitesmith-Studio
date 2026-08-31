# Lessons Learned

> Append-only register of recurring rules and patterns. Re-read at start by /10x-frame, /10x-research, /10x-plan, /10x-plan-review, /10x-implement, /10x-impl-review.

## Trace every finding to the site's own assertion

- **Context**: Any detection rule in `src/server/crawl` that turns crawled data into a finding about a client's site.
- **Problem**: Four times now a rule has reported a defect on a client site that was not there: `x-default` read as a language, any two-letter path segment read as a locale, a truncated crawl's own ceiling reported as eighteen dead pages, and redirect aliases counted as distinct siblings. Each looked specific and cited real URLs.
- **Rule**: Every finding must be traceable to something the site itself asserted. If it depends on our inference or on how we collected the data, it is a claim about us, not about the client — and must not be reported as a defect on their site.
- **Applies to**: frame, plan, implement, impl-review
