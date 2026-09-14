<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Container Deploy Skeleton

- **Plan**: `context/changes/container-deploy-skeleton/plan.md`
- **Mode**: Deep
- **Date**: 2026-09-14
- **Verdict**: REVISE → **SOUND** after triage (all 9 findings fixed)
- **Findings**: 3 critical, 5 warnings, 1 observation

## Verdicts

| Dimension | Verdict (at review) | After fixes |
|-----------|---------------------|-------------|
| End-State Alignment | FAIL | PASS |
| Lean Execution | PASS | PASS |
| Architectural Fitness | PASS | PASS |
| Blind Spots | FAIL | PASS |
| Plan Completeness | FAIL | PASS |

Three FAILs would read as RETHINK by the letter, but the approach was not wrong:
the phasing, the migration decision and the two-depth Chromium proof all held.
What was broken is that three Phase 2–4 contracts under-specified what actually
enters the image and where its configuration comes from. Every fix landed inside
an existing phase; no phase was added, removed or resequenced.

## Grounding

8/8 paths ✓, 2/2 symbols ✓, brief↔plan ✓.
Progress contract at review: 1 heading, 4/4 phases matched, 42/42 items, 0
checkboxes outside Progress. Re-verified after fixes: 11/11, 12/12, 12/12, 9/9.

## Findings

### F1 — Nothing copies scripts/ into the image

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: End-State Alignment
- **Location**: Phase 2 — Dockerfile contract
- **Detail**: The Dockerfile contract named exactly three COPY lines (standalone, public, static). `scripts/` was in none of them, and standalone output contains only what `@vercel/nft` traced from Next's entry points — which never reaches a script Next does not import. The entrypoint's `migrate.mjs`, criterion 2.2's `check-browser.mjs`, and Phase 4's smoke all referenced files absent from the image. Applying the fix also surfaced that `drizzle/` — which the migrate runner reads — was missing for the same reason.
- **Fix A ⭐ Recommended**: Explicit COPY for the scripts the image needs
  - Strength: Deterministic — the file is in the image because a line put it there, not because a tracer inferred it.
  - Tradeoff: The Dockerfile now carries a list someone must extend when a new container-side script appears.
  - Confidence: HIGH — a COPY line cannot be mis-traced.
  - Blind spot: Covers the scripts; their node_modules dependencies are F5.
- **Fix B**: `outputFileTracingIncludes` pulls `scripts/` into the trace
  - Strength: One entry covers scripts and dependency closure together; verified present in this Next version.
  - Tradeoff: Route-glob keyed, indirect, fails silently.
  - Confidence: MEDIUM — documented but not exercised in this repo.
  - Blind spot: Whether nft resolves `.mjs` outside `src/` cleanly.
- **Decision**: FIXED via Fix A — Dockerfile contract now copies `drizzle/` and names each container-side script, with a note that Phase 4 extends the line.

### F2 — Criterion 2.2 cannot run against the entrypoint as specified

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 2 — entrypoint contract, criterion 2.2
- **Detail**: The contract never said whether the entrypoint was `ENTRYPOINT` or `CMD`. Under `ENTRYPOINT` — the natural reading — `docker run --rm sitesmith-studio node scripts/check-browser.mjs` passes those words as arguments to a script that ignores them. The container migrates instead, and in Phase 2 no database exists yet, so the browser check fails for a reason unrelated to the browser.
- **Fix A ⭐ Recommended**: Entrypoint execs `"$@"` with a default CMD
  - Strength: Idiomatic; migration becomes a precondition for whatever was asked; criterion 2.2 works unchanged.
  - Tradeoff: Phase 2 still needs migration skipped or tolerated with no database.
  - Confidence: HIGH — standard entrypoint pattern.
  - Blind spot: Whether migrate should hard-fail for non-server commands.
- **Fix B**: Keep ENTRYPOINT; criterion 2.2 passes `--entrypoint`
  - Strength: Proves the browser in true isolation, no database involved.
  - Tradeoff: Every container-side check must remember the flag.
  - Confidence: HIGH — mechanically certain.
  - Blind spot: None significant.
- **Decision**: FIXED via Fix A — contract now specifies `ENTRYPOINT` + `exec "$@"` with `CMD ["node","server.js"]`, explains why, and resolves the blind spot: migration is skipped when `DATABASE_URL` is unset, and fails loudly only when a URL is present and unreachable.

### F3 — image:verify has no source for AUTH_SECRET or DATABASE_URL

- **Severity**: ❌ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Blind Spots
- **Location**: Phase 3 compose contract, Phase 4 criterion 4.1
- **Detail**: The compose contract specified the postgres service's credentials but said nothing about the app service's environment. `src/env.js:12-25` requires `AUTH_SECRET` and `DATABASE_URL` at runtime; `SKIP_ENV_VALIDATION` covers build only. `.env` is gitignored (`.gitignore:36-37`) and excluded by the plan's own `.dockerignore`, and CI has no `.env` at all — so `npm run image:verify`, the single command the workflow calls, would start an app service that fails env validation before serving. The plan's headline criterion could not pass in the environment it was written for.
- **Fix A ⭐ Recommended**: compose supplies throwaway verification values
  - Strength: `image:verify` becomes self-contained and identical locally and in CI — the property that made "one command, two places" worth choosing. The database is ephemeral and the secret signs nothing that outlives the run.
  - Tradeoff: A secret-shaped literal lives in a committed file and must be unmistakably marked verification-only.
  - Confidence: HIGH — the integration harness already generates a random `AUTH_SECRET` for the same reason (`vitest.integration.config.ts:52`).
  - Blind spot: Whether the app should refuse to start on detecting the verification secret outside a verification run.
- **Fix B**: `image:verify` generates the values and passes them through
  - Strength: Nothing secret-shaped committed; each run gets a fresh secret.
  - Tradeoff: Hand-run compose no longer works without replicating the logic.
  - Confidence: MEDIUM — splits config construction across two places.
  - Blind spot: Cross-shell random generation in PowerShell.
- **Decision**: FIXED via Fix A — compose contract now defines the app service's environment explicitly, with the disposability reasoning and the requirement that the value be self-describing and commented as verification-only.

### F4 — compose cannot derive credentials from DATABASE_URL, contradicting 3.11

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 3 — compose contract vs. criterion 3.11
- **Detail**: The contract said credentials and port are "derived to match what `DATABASE_URL` in `.env` already expects". Compose substitutes whole variables; it cannot parse a URL into user, password, port and database name. `scripts/db.mjs:65-80` does that in JavaScript, so derivation would work only through `db.mjs` — while criterion 3.11 explicitly tests `docker compose up` run directly, which would get unsubstituted or default values and a Postgres the app's `DATABASE_URL` does not match.
- **Fix**: Discrete `POSTGRES_*` variables in `.env` and `.env.example`; compose substitutes those; `db.mjs` keeps parsing the URL for status output and asserts the two agree.
  - Strength: Direct compose use and `db.mjs` both work, so criterion 3.11 is honest; `env.js` is untouched since it ignores extra vars.
  - Tradeoff: Two representations of one connection that can drift — which is why the assertion is required, not optional.
  - Confidence: HIGH — compose substitution semantics are unambiguous.
  - Blind spot: Whether `.env.example` changes break existing setup docs.
- **Decision**: FIXED — contract now requires discrete `POSTGRES_*` vars, explains why derivation is unavailable, and makes the drift assertion in `db.mjs` part of the change.

### F5 — The playwright package's own tracing under standalone is unverified

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 2 — Critical Implementation Details
- **Detail**: The plan reasoned correctly that the Chromium *binary* won't be traced and must come from the base layer, but never addressed the playwright *package*. It is imported from exactly one place (`src/server/crawl/render.ts:1`) so nft should trace it, but playwright resolves its browser registry through filesystem paths rather than imports — the pattern nft handles worst. No `outputFileTracingIncludes` or `serverExternalPackages` config exists in this project.
- **Fix**: Check `playwright` is present in `.next/standalone/node_modules` after the first build; reach for `outputFileTracingIncludes` only if absent or incomplete.
  - Strength: Turns an assumption into a checked fact at the one moment it is cheap, before the entrypoint depends on it.
  - Tradeoff: None meaningful — one command in a phase already inspecting build output.
  - Confidence: MEDIUM — nft's handling of playwright is genuinely uncertain.
  - Blind spot: Behavior may differ between Next patch versions.
- **Decision**: FIXED — added as a Critical Implementation Detail and as Phase 2 criterion 2.5.

### F6 — Phase 4's smoke trigger is left as an open decision

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 4 — smoke contract
- **Detail**: The contract said how the render is triggered "is the implementer's call" and offered a preference, not a decision. This is the plan's most load-bearing check — the one proving the product can use the browser — and it was the one thing left unresolved.
- **Fix**: Execute `renderSample` (`src/server/crawl/render.ts:275`) directly inside the running app container against a URL the composition serves; assert a non-empty observation with `complete: true`.
  - Strength: Reaches the real launch site at `render.ts:289` with no auth, no project record and no crawl, so the check fails for exactly one reason. Far less machinery than driving the UI.
  - Tradeoff: Doesn't prove the HTTP path — but the e2e suite already covers that on the host every phase.
  - Confidence: HIGH — `renderSample` is exported and takes plain arguments.
  - Blind spot: Reaching an app-internal module from a standalone build may need a thin wrapper the trace includes.
- **Decision**: FIXED — contract now pins the trigger, states the reasoning, and folds the wrapper caveat plus the Dockerfile COPY dependency into the change.

### F7 — Both README contracts describe content the README does not contain

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 change 6, Phase 3 change 3
- **Detail**: Both contracts said the setup sequence "names `db:migrate` where it named `db:push`". `README.md` is 29 lines of untouched `create-t3-app` boilerplate with no setup sequence, no `db:push` and no database section — its only database mention is a link to Drizzle's site. It also still lists Prisma, which this project does not use, and its "How do I deploy this?" section points at `create-t3-app`'s Vercel, Netlify and Docker guides, which would directly contradict the compose and Dockerfile this change adds.
- **Fix**: Change both contracts from editing a section to writing one; add removing the stale deploy section and Prisma line to Phase 3's README change.
  - Strength: The implementer would otherwise look for text that isn't there and have no instruction for what they found.
  - Tradeoff: Slightly widens Phase 3, only by deleting wrong lines.
  - Confidence: HIGH — verified by reading the file.
  - Blind spot: None significant.
- **Decision**: FIXED — both contracts rewritten.

### F8 — Migration Notes leaves the existing-dev-database question unresolved

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Migration Notes
- **Detail**: "Applying the initial migration to an existing database must be verified as a no-op rather than assumed… check on a scratch copy first" is an open question in a finished plan, and it had a cheap answer the plan didn't reach for: the development database holds only disposable data, and `db:seed-owner` and `db:seed-project` exist to rebuild it.
- **Fix**: Instruct drop, recreate, migrate, re-seed. Keep the scratch-copy check only as the path for anyone holding data they care about.
  - Strength: Removes the only unresolved decision in Migration Notes; makes Phase 1 reproducible rather than exploratory.
  - Tradeoff: Anyone with hand-made local state loses it — which is why the fallback stays documented.
  - Confidence: HIGH — both seed scripts exist in `package.json`.
  - Blind spot: None significant.
- **Decision**: FIXED — hedge replaced with an instruction plus a documented fallback.

### F9 — The grep criterion isn't mechanically decidable

- **Severity**: 💭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 — criterion 1.8
- **Detail**: `grep -rn "push" scripts/ test/ e2e/ package.json` returns 27 lines today, of which 12 relate to drizzle-kit and the rest are array `.push()` calls. "Nothing relevant" requires a human to judge, making it a manual check filed under Automated Verification.
- **Fix**: Grep for `drizzle-kit` instead, expecting hits only in the `db:generate` and `db:studio` scripts.
- **Decision**: FIXED — criterion rewritten with a precise expected result.

## Triage Summary

| Outcome | Findings |
|---|---|
| Fixed | F1 (Fix A), F2 (Fix A), F3 (Fix A), F4, F5, F6, F7, F8, F9 — 9 |
| Skipped | — |
| Accepted | — |
| Dismissed | — |

**Verdict after fixes: SOUND.** No phase was added, removed or resequenced; every
fix landed inside an existing phase contract. Phase 2 gained two success criteria
(scripts and `drizzle/` present; `playwright` traced), renumbering that phase's
Progress rows to 2.1–2.12.
