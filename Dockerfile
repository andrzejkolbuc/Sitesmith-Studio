# syntax=docker/dockerfile:1

# Build Sitesmith Studio to a standalone server and run it on the Playwright base.
#
# The final stage MUST stay the Playwright image. Chromium is a binary, not a
# module: `@vercel/nft` traces imports and `fs` usage, so it will never be pulled
# into the standalone output. The browser and its system libraries come from this
# layer or they are not there at all. Swapping the final stage for a slim Node
# image is the one change that yields a container which boots, serves and crawls
# while silently measuring nothing — `scripts/check-browser.mjs` exists to catch
# exactly that, and will.
#
# The tag matches the pinned `playwright` dependency. Both must move together;
# a mismatch means the npm package looks for a browser revision the image does
# not carry.
ARG PLAYWRIGHT_VERSION=1.62.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS base

# The same base for every stage, so the Node that builds is the Node that runs.
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# --- dependencies -----------------------------------------------------------
FROM base AS deps

# Lockfile-exact, and its own layer so a source edit does not reinstall.
COPY package.json package-lock.json ./
RUN npm ci

# --- build ------------------------------------------------------------------
FROM base AS build

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# No real AUTH_SECRET or DATABASE_URL exists at build time, and none should —
# `src/env.js:44` documents this escape hatch as being for exactly this case.
# It covers the build only; the runtime still validates both.
ENV SKIP_ENV_VALIDATION=1
ENV NODE_ENV=production
RUN npm run build

# --- runtime ----------------------------------------------------------------
FROM base AS runner

ENV NODE_ENV=production
# Next binds to localhost by default, which from outside the container is
# nothing at all.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# What gets copied, and why the list is explicit.
#
# Standalone output contains only what nft traced from Next's entry points, so
# anything Next does not import is absent unless a COPY line puts it there. That
# is the static assets (wrong destinations produce a site with no CSS rather than
# an error), the `drizzle/` migrations the entrypoint applies, and the
# container-side scripts.
#
# Deliberately not `COPY scripts/`: a container carrying only the scripts it runs
# is easier to reason about than one carrying the vault mirror and the seeds.
# Anyone adding a container-side script must extend this line — a script that is
# merely written is not a script that is present.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/public ./public
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts/migrate.mjs /app/scripts/check-browser.mjs ./scripts/

# The migrate runner's dependencies, copied because nothing traces them.
#
# nft traces from Next's entry points, and Next never imports `scripts/migrate.mjs`.
# Turbopack additionally bundles the server's own database code into `.next/server`,
# so the standalone `node_modules` contains 13 packages and neither of these is
# among them — verified after the build, not assumed. Both have zero runtime
# dependencies of their own, so these two trees are the whole requirement.
#
# `playwright` and `playwright-core` ARE traced (from `src/server/crawl/render.ts:1`)
# and need no line here; only the Chromium binary comes from the base layer.
COPY --from=build /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=build /app/node_modules/postgres ./node_modules/postgres

# Set here rather than relying on the checkout: on Windows the executable bit
# does not survive by default, so a committed mode cannot be trusted.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# `pwuser` ships with the Playwright image and already has read access to
# /ms-playwright.
USER pwuser

EXPOSE 3000

# The entrypoint migrates, then execs whatever was asked for — which is what
# makes `docker run <image> node scripts/check-browser.mjs` run the check rather
# than start the server.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
