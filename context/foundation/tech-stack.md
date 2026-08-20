---
starter_id: t3
package_manager: npm
project_name: sitesmith-studio
hints:
  language_family: js
  team_size: solo
  deployment_target: self-host
  ci_provider: github-actions
  ci_default_flow: auto-deploy-on-merge
  bootstrapper_confidence: verified
  path_taken: custom
  quality_override: false
  self_check_answers:
    typed: true
    from_official_starter: true
    conventions: true
    docs_current: true
    can_judge_agent: true
  has_auth: true
  has_payments: false
  has_realtime: false
  has_ai: false
  has_background_jobs: true
---

## Why this stack

Sitesmith-Studio is a solo-built, multi-tenant web app whose core loop is long-running browser
work: crawling up to 1,200 URLs per project, capturing a rendered snapshot of every page, and
comparing runs. That workload, not the interface, drove the choice.

The vetted default for web plus JavaScript was named and rejected. Its edge-first deployment
cannot run a browser in-process, the hosted alternative for that is a paid product, and its
bundled storage free tier is far below the snapshot volume this portfolio generates - all three
colliding with the project's zero-spend constraint.

T3 keeps every stated preference intact (React, Next.js, Tailwind, TypeScript) while shipping
authentication and a typed data layer in the scaffold. That matters because the PRD explicitly
flagged roughly four weeks of account work standing between the developer and the first checked
page; this starter removes most of it. It passes all four agent-friendly quality gates and its
scaffolding is verified end to end.

Deployment is a self-hosted container, targeting Azure - the developer's stated preference, and
the honest mapping for a workload that needs a persistent process rather than a short-lived
invocation. It also satisfies their explicit avoid on proprietary-API lock-in. Cloudflare belongs
in front as CDN and DNS, not as the application runtime.

## Scaffolding notes

**Read before running the scaffolder.**

1. **Change the database provider to Postgres.** The registry's scaffold command for this starter
   is pinned to `--dbProvider sqlite`, but PostgreSQL was an explicit preference and the domain is
   relational (runs, findings, and variant relationships). Use `--dbProvider postgres` instead.
   Left unchanged, the scaffold silently produces a SQLite project.

2. **Deployment target is a deliberate deviation.** This starter's card lists `vercel`,
   `cloudflare-pages`, and `fly`. `self-host` was chosen instead, because the workload needs a
   persistent process that can launch a browser. The starter is Next.js underneath, which does
   list self-hosting, so this is well-supported - but the scaffolder should generate a Dockerfile
   rather than a platform-specific config.

3. **The long-running work needs somewhere to live.** Crawling, snapshot capture, and scheduled
   runs do not belong in request handlers regardless of host. Expect a separate worker process
   alongside the web app. This is an architecture decision for planning, not a scaffold flag.

4. **Not a stack concern, carried forward:** Grafana was named for observability. It sits outside
   the starter and does not affect scaffolding.

5. **Hosting cost is real.** The zero-spend constraint recorded during shaping covers tool
   licences, not infrastructure. A persistent container, a Postgres instance, and snapshot storage
   will carry a running cost.
