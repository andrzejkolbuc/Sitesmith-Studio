# Crawl-level technical checks (S-04) — Plan Brief

> Full plan: `context/changes/crawl-technical-checks/plan.md`
> Research: `context/changes/crawl-technical-checks/research.md`

## What & Why

Roadmap item S-04 adds the crawl-level checks a client expects from a site auditor: broken
links, redirect chains, sitemap and robots problems, orphans, duplicates, and certificate
issues. The roadmap's own risk note concedes these are a rebuild of a mature existing tool
and keeps them must-have anyway, which sets the bar: the value comes from these findings
sitting beside the multilingual ones in one run, not from the checks themselves.

## Starting Point

A working crawl-and-detect pipeline with 14 rules. It computes eight per-page fields and
persists five — links, content, metadata and the `X-Robots-Tag` header are used in-process
and discarded. Rules are pure and synchronous, with no registry and no confidence field.
robots.txt and sitemap.xml have never been fetched by any code at any point; both were
deferred to this slice in writing, twice. The crawler follows redirects automatically, so no
page ever carries a 3xx status, and it does not consult robots.txt at all.

## Desired End State

A run reports, beside the existing multilingual findings: every dead internal and external
link named once with the pages linking to it; redirect chains and loops; sitemap entries that
fail and live pages the sitemap omits; robots.txt rules contradicting the site's own sitemap;
orphan pages; URLs serving duplicate titles, descriptions or content; and certificate and
security-header contradictions. Proven by a hand-judged crawl of a real client site.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Slice scope | All six requirements, one change, ten phases | User overruled the research's three-way split; phases still ordered by cost so risky work can't block cheap wins | Plan |
| Phase ordering | By what each part costs the client's site | The axis NFR-1 cares about and the one S-01's single open criterion sits on | Research |
| FR-020 monolingual gap | Unlocalised pages become their own comparison bucket | Smallest change that closes it; keeps rule 10's language reasoning intact so no cross-locale double-report returns | Plan |
| Near-identical content | Exact digest only; similarity ratio deferred in writing | Threshold-free, reuses a fingerprint already computed per page — the move that replaced a threshold twice and caught the real defects both times | Research + Plan |
| Link graph storage | In-memory reverse index, not persisted | Matches S-05's precedent that detection is in-memory and the finding's detail carries the evidence | Plan |
| Broken-link shape | One finding per broken target, listing its linkers | A dead nav link is 1 finding, not 500 — per-edge reporting makes the worst sites least readable | Plan |
| FR-030 headers | Self-contradiction only; no baseline list | A missing CSP is our standard, not the site's assertion — the failure `lessons.md` exists to prevent | Plan |
| Transient failures | Re-verify 5xx and network errors once; 404s reported first-shot | Targets the observed scar, and reuses the codebase's own definition of a transient failure | Plan |
| FR-018 formulation | Sitemap lists it ∧ robots.txt disallows it | Two opposing assertions by the same publisher — replaces "intended", which is a claim about a human's mental state | Research |
| robots.txt obedience | Report only; keep not obeying | Honours a decision recorded twice rather than reversing it silently, and FR-018 depends on it | Plan |
| External links | Own budget, fully isolated from run-wide aborts | Today a burst of dead third-party hosts would abort the crawl of the client's site | Plan |

## Scope

**In scope:** All six requirements — FR-016, FR-017, FR-018, FR-019, FR-020, FR-030. Ten new
finding types, one change to the shipped `metadata_duplicated` rule, two new parsers
(robots.txt, sitemap), a TLS probe, an in-memory link graph, a re-verification pass, and a
per-host external request budget.

**Out of scope:** Obeying robots.txt as a crawl constraint. A distinct user-agent. A
similarity ratio for near-identical content. Reporting missing security headers against a
baseline list. Internal links as FR-018's trigger. Persisting the link graph. A per-run
findings cap or suppression mechanism. Sitemap-based crawl discovery.

## Architecture / Approach

Three structural moves. **Site-level artefacts reach the rules as data** — `CrawlResult`
widens to carry the parsed robots.txt, sitemap, TLS observation, alias record and
re-verification outcomes, and `DetectOptions` widens to match, so rules stay pure and
synchronous and every fetch stays inside `crawl()` under the pacer. **The link graph is built
once in memory** in the post-crawl phase beside variant grouping, before `result.pages` goes
out of scope. **Findings name the thing that is wrong, once** — the main defence against the
volume risk this slice carries.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Duplicate content | Site-wide exact-digest rule + unlocalised bucket | Rule may ship correct and silent |
| 2. Link graph + internal links | Reverse index, broken-target rule, re-verification pass | Volume if the finding shape is wrong |
| 3. Headers + certificate | Named header capture, TLS probe, two rules | Quieter than clients expect |
| 4. robots.txt | Parser from scratch, plumbed to rules | Precedence and wildcard edge cases |
| 5. Sitemap | Parser, index/gzip handling, comparison pipeline | URL identity — the sharpest FP risk |
| 6. Reconciliation + blocked pages | FR-017 both directions, FR-018 as R1 | Redirected sitemap locs read as failures |
| 7. Orphans | Sitemap ∧ no inbound link | Absence reasoning on a truncated crawl |
| 8. External links | Pacer extraction, per-host budget, 429 handling | First traffic to non-client hosts |
| 9. Redirect chains | `redirect: "manual"`, hop record, alias restore | Touches the proven identity path |
| 10. Real-site proof | Hand-judged crawl, per-type table | Any false finding blocks the slice |

**Prerequisites:** S-01 (built). Access to yazaki-emea.com for Phase 10 at existing pacing.
No schema change, so no migration and no database access beyond the usual test databases.

**Estimated effort:** ~8–10 sessions. Phases 1–3 are each a session or less; 4, 5, 8 and 9
are the substantial ones.

## Open Risks & Assumptions

- **FR-018 depends on the crawler continuing not to obey robots.txt.** If obedience is ever
  adopted, blocked pages vanish from the crawl and the rule's stronger extension goes dark.
  Recorded in the rule's own doc comment.
- **Exact content matching may ship correct and silent.** It found nothing on the one real
  site tested. That is a reason to say so in Phase 10 rather than discover it there — and not
  a reason to let "exact will be too quiet" smuggle a ratio back in.
- **Phase 9 changes the redirect mode on the one code path proven against a live site**, and
  `page-identity-under-redirects` still has two manual criteria open. The hop record is
  additive and the existing identity tests must pass unchanged.
- **Volume is the slice's largest untreated risk.** Ten new rules land with no per-run cap and
  no suppression mechanism; readability is an explicit Phase 10 criterion instead.
- **S-01's criterion 2.9 stays open** — a real client crawling "without errors in its
  monitoring" cannot be checked from this side. This is the first slice since S-01 to add
  outbound requests, so it is the first that cannot write "NFR-1 is not engaged".

## Success Criteria (Summary)

- A run against a real client site reports dead links, sitemap and robots contradictions,
  orphans, duplicates and certificate problems alongside the existing multilingual findings.
- No false positive in any of the ten new rules, judged by hand against the live site.
- The findings list is still something an operator would read to the end.
