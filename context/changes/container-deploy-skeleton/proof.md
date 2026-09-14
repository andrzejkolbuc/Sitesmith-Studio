# Proof — container deploy skeleton

Evidence gathered while implementing, on 2026-09-14, on Windows 11 with Docker
Desktop 29.7.2. Recorded here because the claims this slice makes — "Chromium
launches in the image", "the app's own render path reaches it", "the image is
this big" — are the kind that quietly stop being true and need a number to
regress against.

## Phase 2 — the image

### Base image

`mcr.microsoft.com/playwright:v1.62.1-noble`, matching the pinned
`playwright@1.62.1`.

```
$ docker run --rm mcr.microsoft.com/playwright:v1.62.1-noble node --version
v24.18.1
```

That satisfies the `engines.node` floor of `>=22.18.0`, which exists because
`scripts/seed-*.ts` rely on unflagged TypeScript stripping. The floor was written
after this check, not before it.

Browsers ship at `/ms-playwright` (`chromium-1234`, `chromium_headless_shell-1234`,
`ffmpeg-1011`, `firefox-1538`, `webkit-2336`), and `PLAYWRIGHT_BROWSERS_PATH` is
already set in the base layer. The image runs as `pwuser` (uid 1001), which the
base image provides and which can already read that directory.

### The trace did not include what playwright needs — found by the check, not by reading

The first standalone build produced a `node_modules` of **13 packages**. It
contained `playwright` and `playwright-core`, so the naive form of criterion 2.5
passed. The container still failed:

```
$ docker run --rm sitesmith-studio node scripts/check-browser.mjs
entrypoint: DATABASE_URL is not set; skipping migrations.
Error: Cannot find module '/app/node_modules/playwright-core/browsers.json'
Require stack:
- /app/node_modules/playwright-core/lib/coreBundle.js
```

This is the failure the plan predicted at `Critical Implementation Details`:
playwright resolves its browser registry through constructed filesystem paths
rather than imports, which is the pattern `@vercel/nft` handles worst. `lib/` was
traced; `browsers.json`, which nothing imports by name, was not.

Fixed in `next.config.js` with `outputFileTracingIncludes` over the whole
`playwright` and `playwright-core` trees rather than over the one file that
happened to be missing — the registry reads several paths this way, and a list
naming only what we have tripped over would break again on the next upgrade, at
deploy time, as a browser that silently does not launch.

**Worth noting for anyone reading criterion 2.5 later:** "`playwright` is present
in `.next/standalone/node_modules`" was true while the image was broken. The
package directory being present is not the same claim as the package working.
2.2 is the criterion that actually held.

### Chromium launches in the final image

```
$ docker run --rm sitesmith-studio node scripts/check-browser.mjs
entrypoint: DATABASE_URL is not set; skipping migrations.
check-browser: chromium 151.0.7922.34 launched and rendered a page.
$ echo $?
0
```

The entrypoint line is itself evidence of two contracts: migration is skipped
rather than failed when no `DATABASE_URL` is set, and `exec "$@"` handed the
container's arguments to the check instead of starting the server.

### What is in the image

```
-- cwd: /app
-- static assets
-rwxr-xr-x 1 root root 15406 public/favicon.ico
.next/static -> chunks, hOFdCftoNM1gL5hhvIKZT, media
-- scripts
check-browser.mjs  migrate.mjs
-- drizzle
0000_freezing_violations.sql  meta/{0000_snapshot.json,_journal.json}
-- migrate deps
node_modules/{drizzle-orm,postgres,playwright,playwright-core}
-- user
uid=1001(pwuser) gid=1001(pwuser)
```

`drizzle-orm` and `postgres` are copied explicitly. Turbopack bundles the
server's database code into `.next/server`, so neither survives as a package in
the standalone tree — and `scripts/migrate.mjs`, which Next never imports, is
never traced at all. Both have zero runtime dependencies, so those two trees are
the whole requirement. Verified after the build rather than assumed, as the plan
required.

### Image size

| | Size |
| --- | --- |
| `mcr.microsoft.com/playwright:v1.62.1-noble` (base) | 3.52 GB |
| `sitesmith-studio:latest` | 3.62 GB |

**The application contributes about 100 MB**; the rest is a base layer that is
cached and changes only when playwright is upgraded. That split is the number to
watch: if the app layer grows into the hundreds of megabytes, the standalone
output has stopped being standalone — most plausibly because the final stage
started installing dependencies of its own.
