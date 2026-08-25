# Test Plan — Sitesmith Studio

> Phased test rollout. Section 3 is the state table `/10x-test-plan` reads on
> every invocation; the rest is strategy and, as phases land, cookbook.

## 1. Strategy

Three principles govern every test this rollout adds.

**1. Cost × signal.** The question for each test is *what is the cheapest test
that gives a real signal for this risk?* Not "what would be most thorough".
A browser test that a unit test would have caught is a slow test with the same
signal. Do not promote to end-to-end because it feels safer.

**2. User concerns are evidence.** A risk the team has lived through carries the
same weight as a requirement line. Several risks below trace to failures found
during implementation rather than to any document.

**3. Risks are scenarios, not code locations.** Section 2 cites *why a risk was
raised* — a requirement, an interview answer, a directory with heavy churn. It
never asserts which file holds the failure. That anchor is `/10x-research`'s
output, produced fresh per rollout phase against current code. A plan that names
files goes stale the first time someone moves one.

**A fourth, specific to this project.** Every detection rule shipped so far was
tested against a fixture written by the same author who decided what the rule
should do. Such a test can only confirm what its author already believed — it
cannot discover that the belief was wrong. Tests for detection logic must take
their expectations from somewhere the implementation did not: a real site's
shape, a requirement, or a case written before the rule was adjusted.

## 2. Risk map

Impact and likelihood are coarse (High / Medium / Low) — the goal is a
defensible order, not false precision.

| #  | Risk (failure scenario) | Impact | Likelihood | Source (evidence) |
|----|-------------------------|--------|------------|-------------------|
| R1 | A finding fires on something that is not a problem, the operator stops reading findings, and the product becomes shelfware | High | High | PRD guardrail "no false-positive fatigue — the developer stops reading them and the product is dead"; interview Q3; implementation found rule 1 firing 7× where 2 was correct, and a broken variant reported twice under two names |
| R2 | A check degrades the client site it is checking | High | Medium | PRD NFR-1 "causing a client incident is a worse outcome than the regression being hunted"; interview Q3; hot-spot `src/server/crawl/` — 10 commits/30d; has never run against a real site |
| R3 | A newly added query forgets tenant scoping and one client's data reaches another's session | High | Medium | PRD NFR-2, stated as a binary commitment; archived impl-review finding F2 (the scoping helper accepted any column); 13 roadmap slices remain, each adding routers |
| R4 | A user cannot complete sign in → create project → run check → read findings because a UI surface broke | High | High | Interview Q4; zero test files under `src/app/`; nine user-visible behaviours verified by hand once during implementation and never since |
| R5 | An account in a legitimate but partial state crashes instead of explaining itself | Medium | Medium | Archived impl-review finding F1 — reproduced live, fixed, no automated guard; roadmap S-10 introduces invites and more partial states |
| R6 | Password verification accepts a wrong password or rejects a correct one | High | Low | Security-critical path with zero committed tests; verified once by a throwaway script that was deleted. Abuse lens: authentication |
| R7 | Sign-in reveals which email addresses hold accounts | Medium | Low | Invite-only access model; the deliberate timing defence in the authorize path has no test. Abuse lens: enumeration |

### Risk Response Guidance

Response intent for downstream phases. `/10x-research` verifies or corrects each
row against real code; none of it is a code anchor.

| Risk | What would prove protection | Must challenge | Context needed | Likely cheapest layer | Anti-pattern to avoid |
|------|------------------------------|----------------|----------------|----------------------|------------------------|
| R1 | A site shape the rules have never seen produces the findings a human would agree with — and stays silent where a human would | That the existing fixture represents real sites. It was written to make chosen rules pass | How each rule derives its expectation; where locale is inferred vs declared; what a family is | Table-driven unit tests over many small site shapes | The oracle problem: asserting what the current code returns. Expectations must come from the requirement or a real site, never from running the rule and recording the output |
| R2 | A site that is slow, flapping, or hostile causes the run to stop rather than escalate — and the run always terminates | That "aborts on 5 consecutive failures" covers the shapes that actually occur. Intermittent failure never accumulates consecutively | How concurrency, delay and abort interact under latency; whether the page ceiling and timeout compose | Integration against an adversarial fixture server | Testing only the clean abort. The dangerous case is degradation that never trips a threshold |
| R3 | A caller holding another tenant's identifier is refused by every read path, including ones added later | That the scoping helper is sufficient. It is a convention; the raw client stays reachable | Which procedures read tenant-owned rows; how ownership is established per procedure | Integration through the API caller with two seeded tenants | Testing only the procedures that exist today. The risk is the router written next month |
| R4 | A user completes the whole journey in a real browser and reads a finding they could act on | That passing server tests imply a working interface. Every failure found by hand this session was visual | Session and form mechanics; how progress reaches the browser; what a finding renders as | End-to-end in a real browser | Asserting DOM structure instead of what the user can see and do. Coupling to markup makes the test break on every restyle |
| R5 | An account missing its tenant is told what is wrong and offered a way out, on every gated surface | That the one fixed case is the only partial state. Invites will create more | Which states are reachable; what each gated surface does when identity is incomplete | End-to-end, reusing the journey harness | Testing the fixed case only, rather than the class of "identity present but incomplete" |
| R6 | A correct password verifies, a wrong one does not, and a malformed stored value fails closed rather than throwing | That round-tripping one password is sufficient evidence | The digest format and its parameters; what happens to values written by an older parameter set | Unit tests, no database | Testing only hash-then-verify. The interesting cases are corrupt, truncated, and foreign-format digests |
| R7 | An unknown address and a wrong password are indistinguishable in both message and timing | That returning the same string is enough. Timing is the other channel | Where the deliberate timing defence sits and what it compensates for | Unit test on timing symmetry, plus a browser assertion on the message | Asserting the message alone. That silently permits a timing regression |

## 3. Phased rollout

Status vocabulary: `not started` → `change opened` → `researched` → `planned` →
`implementing` → `complete`. This table is machine-read; do not reword the
status values.

| # | Phase | Goal — what protection it proves | Risks | Test types | Status | Change folder |
|---|-------|----------------------------------|-------|------------|--------|---------------|
| 1 | Harness and commands | A user can complete the whole journey in a real browser, and the suite can be run in useful slices rather than all-or-nothing | R4 | End-to-end (browser), test-command split | complete | `context/changes/testing-harness-and-commands/` |
| 2 | Auth and abuse behaviours | Identity holds under misuse: wrong passwords fail, partial accounts are explained, another tenant's identifier opens nothing, and sign-in leaks nothing about who has an account | R3, R5, R6, R7 | Unit, integration, end-to-end | complete | `context/changes/auth-and-abuse-behaviours/` |
| 3 | Detection-rule confidence | The rules agree with human judgement across site shapes they have never seen, and stay silent where a human would | R1 | Table-driven unit tests | complete | `context/changes/detection-rule-confidence/` |
| 4 | Politeness under stress | A slow, flapping or hostile site causes the run to stop rather than escalate, and every run terminates | R2 | Integration against an adversarial fixture | complete | `context/changes/politeness-under-stress/` |

**Order rationale.** Phase 1 first because it covers the widest untested surface
per test and because the harness it builds is reused by Phases 2 and 3 — and
because the split commands were an explicit ask, and they are cheap. Phase 2
next because it is security-critical and inexpensive once a harness exists.
Phase 3 before Phase 4 because R1 outranks R2 on likelihood: a noisy tool is
abandoned quietly, whereas an impolite crawler announces itself.

**Deliberately not first:** Phase 4 needs an adversarial fixture that is more
work than it looks, and R2's likelihood stays theoretical until the crawler has
met a real site.

## 4. Stack

| Layer | Choice | Note |
|-------|--------|------|
| Runner | vitest | Configured. Integration tests use a real Postgres in a `-test` database, created by `test/global-setup.ts`. `fileParallelism: false` — the suite shares one database |
| Browser | Playwright — **to be added in Phase 1** | Decided during this rollout. Roughly 300 MB of browsers and slower runs, accepted because every failure found by hand during implementation was visual, and because one criterion (progress without a reload) is unverifiable without a real browser |
| Fixtures | `test/fixtures/site.ts` | An HTTP server of deliberately imperfect multilingual pages. Each page exists to make one rule fire, or — for the monolingual page — to prove one stays silent |
| Database | Postgres in Docker | `npm run db:start` / `db:status` / `db:stop`, shell-agnostic |

**Test-base profile at rollout start:** sparse. 47 tests across 4 files, all
under `src/server/`. `src/app/` has none.

**Stack grounding tools (current session):**
- Docs: Context7 available — for Playwright and vitest API specifics; checked 2026-08-25
- Search: none available in current session
- Runtime/browser: Playwright MCP and Chrome DevTools MCP available — directly relevant, since the in-app browser pane never composites and could not verify polling; checked 2026-08-25
- Provider/platform: none relevant — no CI and no deployment yet; checked 2026-08-25

## 5. Commands

The split is part of Phase 1. Target shape:

| Command | Scope | Needs |
|---------|-------|-------|
| `npm run test` | Everything | Postgres, browsers |
| `npm run test:unit` | Pure logic — no database, no network | Nothing |
| `npm run test:integration` | Database and fixture-server tests | Postgres |
| `npm run test:e2e` | Browser journeys | Postgres, browsers, dev server |
| `npm run test:watch` | Re-run on change | Depends on filter |

The distinction that matters is not speed but *what must be running*. A
contributor with no Docker should still be able to run `test:unit` and get a
real signal.

## 6. Cookbook

Filled in as phases land. Each entry names a pattern by the behaviour it
protects, not by the file it lives in.

- **End-to-end user journey** — TBD, Phase 1. Pattern for "a user completes sign
  in → create → run → read", asserting what the user can see and do rather than
  markup.
- **Auth behaviour under misuse** — TBD, Phase 2. Pattern for wrong credentials,
  partial accounts, and cross-tenant identifiers.
- **Detection rule with an independent oracle** — TBD, Phase 3. Pattern for
  asserting a rule against an expectation that did not come from the rule.
- **Adversarial crawl fixture** — TBD, Phase 4. Pattern for slow, flapping and
  hostile responses.

## 7. Negative space — what this rollout will not test

Recorded so the absence reads as a decision rather than an oversight.

- **Accessibility, third-party script weight, structured data.** Ruled out by
  the requirements' non-goals; testing them would test features that do not exist.
- **Notifications and severity triage.** Same — both were declined during shaping.
- **Visual regression of this product's own interface.** The product performs
  visual regression on *client sites*; snapshot-testing its own pages would be
  brittle and catch little.
- **Schema migrations.** Push-based schema, no production deployment. There is
  nothing to migrate and nothing to corrupt.
- **Load and performance of the crawler.** Run duration is a measurement to take
  against a real site, not a threshold to assert. Asserting a number the code
  currently produces would be an oracle problem in the performance dimension.
