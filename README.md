# Create T3 App

This is a [T3 Stack](https://create.t3.gg/) project bootstrapped with `create-t3-app`.

## What's next? How do I make an app with this?

We try to keep this project as simple as possible, so you can start with just the scaffolding we set up for you, and add additional things later when they become necessary.

If you are not familiar with the different technologies used in this project, please refer to the respective docs. If you still are in the wind, please join our [Discord](https://t3.gg/discord) and ask for help.

- [Next.js](https://nextjs.org)
- [NextAuth.js](https://next-auth.js.org)
- [Drizzle](https://orm.drizzle.team)
- [Tailwind CSS](https://tailwindcss.com)
- [tRPC](https://trpc.io)

## Database

The development database runs in Docker. From any shell, including PowerShell:

```bash
npm run db:start
```

Then apply the schema:

```bash
npm run db:migrate
```

`npm run db:status` reports what is running, and `npm run db:stop` stops the
container without discarding its data.

`compose.yaml` is the definition; those three commands are the interface, and
they carry diagnostics a bare `docker compose` does not — the Docker binary is
found by absolute path (it is often not on PATH in a shell opened before Docker
was installed), a stopped engine is reported as a sentence rather than a stack
trace, and `DATABASE_URL` is checked against the `POSTGRES_*` variables compose
reads. The connection is stated twice because compose substitutes whole values
and cannot take a URL apart; `db:status` is what stops the two from drifting.

Copy `.env.example` to `.env` before the first start. Every variable compose
reads also has a default in `compose.yaml`, so the composition is valid with no
`.env` at all — which is how CI runs it.

### Changing the schema

Schema is delivered by **committed migrations**, not by pushing a schema at a
database. After editing `src/server/db/schema.ts`:

```bash
npm run db:generate
```

Commit the generated files in `drizzle/` alongside the schema change, then run
`npm run db:migrate` to apply them. A schema edit without a matching generate
will fail the test suites rather than being silently absorbed — that is
deliberate, because the same migrations are what reach a deployed container.

## Learn More

To learn more about the [T3 Stack](https://create.t3.gg/), take a look at the following resources:

- [Documentation](https://create.t3.gg/)
- [Learn the T3 Stack](https://create.t3.gg/en/faq#what-learning-resources-are-currently-available) — Check out these awesome tutorials

You can check out the [create-t3-app GitHub repository](https://github.com/t3-oss/create-t3-app) — your feedback and contributions are welcome!

## Running as a container

The app builds to an image and runs against the compose Postgres:

```bash
docker compose --profile app up --build
```

It serves on <http://localhost:3100> — deliberately not 3000, so a host
`npm run dev` and the container can run side by side. The image applies the
committed migrations before it starts serving, so a fresh database becomes a
working instance with no extra step.

The base image is `mcr.microsoft.com/playwright`, matched to the pinned
`playwright` version, because the crawler launches a real Chromium and needs its
system libraries to be correct. Two checks prove that rather than assume it:

```bash
docker run --rm sitesmith-studio node scripts/check-browser.mjs
```

asserts a browser launches inside the image, and `scripts/smoke-container.mjs`
asserts the application's own render path reaches one. Both assert a positive
result on purpose — `src/server/crawl/render.ts` degrades rather than crashes
when no browser is available, so an image with a broken Chromium boots, serves
and crawls while silently measuring nothing.

**There is no deployment yet.** No host is provisioned and nothing is published
to a registry; `compose.yaml` is a local composition for development and
verification, not a production topology. Choosing and provisioning a host is a
separate piece of work.
