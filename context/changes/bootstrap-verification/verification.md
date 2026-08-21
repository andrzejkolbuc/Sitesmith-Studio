---
bootstrapped_at: 2026-08-21T07:11:15Z
starter_id: t3
starter_name: "T3 Stack"
project_name: sitesmith-studio
language_family: js
package_manager: npm
cwd_strategy: subdir-then-move
bootstrapper_confidence: verified
audit_command: "npm audit --json"
phase_3_status: ok
---

# Bootstrap verification log

## Hand-off

Read from `context/foundation/tech-stack.md`. Consumed values:

| Field | Value |
|---|---|
| starter_id | t3 |
| project_name | sitesmith-studio |
| package_manager | npm |
| language_family | js |
| deployment_target | self-host |
| bootstrapper_confidence | verified |
| path_taken | custom |
| Feature flags true | has_auth, has_background_jobs |

## Pre-scaffold verification

Package recency: `create-t3-app` v7.40.0, published 2025-11-05.

**Severity: stale** (older than 6 months; ~9.5 months at bootstrap time).

Repo recency: not checked. The card's `docs_url` is `https://create.t3.gg`, which is not a
GitHub repository URL, so no commit-recency signal was available to pair with the package date.

This finding proved material rather than cosmetic - see the audit section. A 9.5-month-old
scaffold pins 9.5-month-old dependency versions, and several of those versions have since
received security advisories.

## Scaffold log

### Command correction

The registry's `cmd_template` for this starter was **not** run verbatim. Three defects were
identified by validating every flag against the installed CLI (`create-t3-app --help`) before
execution, and all three corrections were confirmed by the user.

Registry template:

```
npx create-t3-app@latest {name} --CI --tailwind --trpc --drizzle --appRouter --biome --dbProvider sqlite
```

| # | Defect | Correction | Rationale |
|---|---|---|---|
| 1 | `--dbProvider sqlite` | `--dbProvider postgres` | PostgreSQL was an explicit preference during stack selection and the domain is relational. Flagged in advance in the hand-off's scaffolding notes. |
| 2 | `--nextAuth` absent | added `--nextAuth` | With `--CI`, unspecified feature flags default to false. The scaffold would have shipped with **no authentication** despite `has_auth: true`, and despite bundled auth being the stated reason this starter was chosen over plain Next.js. The registry card's description names NextAuth; its command did not install it. |
| 3 | no git flag | added `--noGit` | The CLI initialises a git repository by default. A stray `.git/` moved up during the merge would have collided with the existing repository and its three commits. |

Command actually executed:

```
npx create-t3-app@latest .bootstrap-scaffold --CI --tailwind --trpc --drizzle --nextAuth --appRouter --biome --dbProvider postgres --noGit
```

Exit code: **0**.

Boilerplate modules reported installed by the CLI: nextAuth, drizzle, tailwind, trpc,
dbContainer, envVariables, biome. Dependencies installed and the project formatted successfully.

### Merge

Strategy: scaffold into a temporary directory, then move files up into the working directory.

`--noGit` was honoured - no `.git/` existed in the temporary directory, so the existing
repository was never at risk during the move.

**Conflicts: none.** The working directory contained only `.git` and `context/`, neither of
which this starter produces. No `.scaffold` sibling files were created, and `context/` was
preserved verbatim.

16 entries moved up, then the temporary directory was removed:

```
.env               .env.example       .gitignore         README.md
biome.jsonc        drizzle.config.ts  next-env.d.ts      next.config.js
node_modules       package-lock.json  package.json       postcss.config.js
public             src                start-database.sh  tsconfig.json
```

Secret hygiene check: `.env` is matched by the scaffold's own `.gitignore` (line 36) and
`node_modules/` is excluded. 13 untracked files remain, none of them secrets or dependencies.

## Post-scaffold audit

Command: `npm audit --json` (exit code 1 - informational only; a non-zero audit exit does not
halt bootstrapping).

**10 vulnerabilities: 2 critical, 4 high, 4 moderate, 0 low.**

These are a direct consequence of the stale-package finding above. The scaffold pins versions
current as of 2025-11-05; advisories published since then apply to those pins.

### CRITICAL findings

**`@auth/core` <= 0.41.2** - reached through `next-auth@5.0.0-beta.25`, a **direct** dependency.

- Email normalizer validates the address before Unicode normalization, allowing a homoglyph `@`
  bypass (GHSA-7rqj-j65f-68wh)
- `getToken()` throws an uncaught exception on malformed Bearer authorization headers
  (GHSA-xmf8-cvqr-rfgj)
- OAuth state, nonce, and PKCE check cookies are not bound to the provider that created them
  (GHSA-x445-f3h2-j279)

This lands in the authentication stack that was deliberately chosen for this project. The third
advisory in particular concerns cross-provider check-cookie binding, which is squarely relevant
to a multi-tenant product whose PRD names absolute client data isolation as a guardrail.

npm reports a fix available via `npm audit fix --force`, which would install
`next-auth@5.0.0-beta.32` - outside the stated dependency range.

### HIGH findings

- **`drizzle-orm` < 0.45.2** (direct dependency) - SQL injection via improperly escaped SQL
  identifiers (GHSA-gpj5-g38j-94v9). Fix would install `drizzle-orm@0.45.2`, a breaking change.
- **`postcss` <= 8.5.22** (transitive, via `next`) - four advisories: XSS via unescaped
  `</style>` in stringify output, and three concerning attacker-controlled `sourceMappingURL`
  enabling arbitrary `.map` file disclosure and path traversal.
- **`sharp` < 0.35.0** (transitive, via `next`) - inherited libvips vulnerabilities
  CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591.
- **`next`** 9.3.4-canary.0 through 16.3.0-preview.10 (direct, pinned `^15.2.3`) - depends on the
  vulnerable `postcss` and `sharp` above. Fix would install `next@16.3.1`, a major breaking change.

### MODERATE findings

- **`esbuild` <= 0.24.2** (transitive, via `drizzle-kit` and `@esbuild-kit/core-utils`) - any
  website can send requests to the development server and read the response
  (GHSA-67mh-4wv8-2f99). Development-time exposure rather than production.

### LOW / INFO findings

None reported.

### Note on remediation

No fix was applied. Bootstrapper informs; the user decides. Every available fix is flagged by npm
as breaking or out-of-range, so remediation is a deliberate decision rather than a safe automatic
upgrade - and the Next.js 15 to 16 jump in particular is a project-shaping choice, not a patch.

## Hints recorded but not acted on

The hand-off carries hints this version surfaces but does not act on:

| Hint | Value | Why not acted on |
|---|---|---|
| deployment_target | self-host | No Dockerfile or deployment config is generated. The hand-off's scaffolding notes call for a Dockerfile for Azure container hosting; that remains outstanding. |
| ci_provider | github-actions | No CI workflow files are generated in this version. |
| ci_default_flow | auto-deploy-on-merge | Same as above. |
| has_background_jobs | true | No worker process or job runner is scaffolded. The hand-off notes that crawling, snapshot capture, and scheduled runs need a separate process; that is an architecture decision for planning. |
| has_auth | true | Acted on indirectly - `--nextAuth` was added to the corrected command. Recorded here because the correction was manual, not automatic. |
| quality_override | false | Nothing to compensate for; the starter passes all four quality gates. |
| bootstrapper_confidence | verified | No extra caution applied; scaffolding completed cleanly. |

`AGENTS.md` / `CLAUDE.md` generation and CI workflow files are out of scope for this version.

## Next steps

1. **Decide on the critical auth advisories.** `@auth/core` carries three, including one about
   OAuth check cookies not being bound to their provider. This is the authentication stack for a
   multi-tenant product with a hard data-isolation guardrail.
2. **Decide on `drizzle-orm`.** The SQL-injection advisory affects a direct dependency; the fix is
   a breaking change.
3. **Start the database.** The scaffold provides `./start-database.sh` for a local Postgres
   container, then `npm run db:push` to apply the schema.
4. **Fill in `.env`.** See https://create.t3.gg/en/usage/first-steps. The file is gitignored.
5. **Generate a Dockerfile** for the chosen self-hosted deployment target.
6. **Plan where the long-running work lives** - crawling and snapshot capture do not belong in
   request handlers.

## Post-merge correction: temp-directory name leak

The scaffold-into-a-temp-directory strategy has a defect this run hit. `create-t3-app` bakes the
directory name it is given into project files, so scaffolding into `.bootstrap-scaffold` left that
name in six places after the move-up:

| File | Leak |
|---|---|
| `package.json` | `"name": ".bootstrap-scaffold"` - **invalid**; npm package names may not begin with a dot |
| `package-lock.json` | same name, two occurrences |
| `.env` | database name in `DATABASE_URL` |
| `.env.example` | database name in `DATABASE_URL` |
| `drizzle.config.ts` | `tablesFilter: [".bootstrap-scaffold_*"]` |
| `src/server/db/schema.ts` | table-name prefix `` `.bootstrap-scaffold_${name}` `` |

All six were rewritten to `sitesmith-studio`, the `project_name` from the hand-off - reproducing
exactly what the CLI would have emitted had it been invoked with that directory name directly.
The command transcript earlier in this log deliberately retains the original
`.bootstrap-scaffold` argument, because it records what was actually executed.

Verified after the fix: no occurrences of the temp name remain in any project file.
