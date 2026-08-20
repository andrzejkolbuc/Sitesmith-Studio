---
project: "Sitesmith-Studio"
context_type: greenfield
created: 2026-08-19
updated: 2026-08-19
checkpoint:
  current_phase: 8
  phases_completed: [1, 2, 3, 4, 5, 6, 7]
  gray_areas_resolved:
    - topic: "primary persona scope"
      decision: "freelance / agency web developer maintaining 3-10 client sites they do not own"
    - topic: "pain category"
      decision: "all four affirmed - coordination overhead (tools do not talk), workflow friction (manual, therefore skipped), zero-licence-budget constraint, and a named missing capability"
    - topic: "trigger moment"
      decision: "deploy verification and pre-go-live gate, plus on-demand client report; user holds both as EQUAL for v1 despite the flagged scope cost"
    - topic: "definition of broken"
      decision: "all four count - visual/layout regression, HTTP or console errors, performance regression, SEO metadata regression"
    - topic: "named capability gaps"
      decision: "cross-language consistency across variants; correlating findings across tools into one underlying problem"
    - topic: "budget constraint"
      decision: "zero spend on tool licences; AI token cost is acceptable, possibly in future"
    - topic: "operator access model"
      decision: "full accounts with sign-up, multiple users and roles - chosen over the cheaper local/no-auth option; Sitesmith-Studio is therefore multi-tenant by design"
    - topic: "client access to results"
      decision: "client accounts - clients log in to see their own project; export-only and share-link options were declined"
    - topic: "role set"
      decision: "four roles - Owner, Team-member, Client-viewer, Admin (platform-level)"
    - topic: "account creation"
      decision: "invite-only; no public self-serve registration, which removes email verification and abuse-surface cost"
    - topic: "MVP scope vs timeline"
      decision: "user reviewed a 13-subsystem inventory estimated at 30-45 weeks of after-hours work, declined both scope-down slices, and committed to full scope with the sustained-effort cost explicitly accepted"
    - topic: "weekly time budget"
      decision: "10-20 hrs/week - serious side project; halves the 30-45 week estimate to roughly 15-23 weeks"
    - topic: "timeline figure"
      decision: "open-ended - user declined to fix a week count; recorded as null with the acknowledgment block standing in for the estimate"
    - topic: "AI priority signal"
      decision: "user declined AI fix-suggestions as a secondary criterion AND declined bounded AI spend as a guardrail, despite AI being listed in the seed as a main feature - unresolved tension, carried to Phase 5"
  frs_drafted: 44
  quality_check_status: accepted
product_type: web-app
target_scale:
  users: small
  qps: low
  data_volume: medium
timeline_budget:
  mvp_weeks: null
  hard_deadline: null
  after_hours_only: true
---

# Shape Notes - Sitesmith-Studio

## Seed idea (verbatim, as provided)

> it will be complex solution for web development testing and analysis
>
> my first thoughts is to make copy of screaming frog seo spider and add more features there, so basicaly i need to keep my existing projects stable, test project are being in development and help achive best seo practice and quality.
> My main features are:
> - user accounts and multople project setup
> - seo tools to analyze website
> - site crawler to find http issues, all pages etc
> - visual regression tool with option to compare changes between snapshot we can create (playwright?)
> - lighhouse scoring and core web vitals (unlighthouse ?)
> - possible some ai integration to openrouter to analyze findings and suggest fixes
>
> i need to think about more features. lets talk

---

## Vision & Problem Statement

A freelance / agency web developer maintains 3-10 client websites they do not own. Each site
runs roughly 200 pages across 2-6 language variants - 400 to 1,200 URLs per project. Two
moments hurt: immediately after a deploy ("is the frontend still okay, is any component
broken?"), and the final check before a site goes live, which the developer describes as
painful. Today that check is a manual spot-check performed when remembered, repeated per
project and per language variant. Because it is manual it is inconsistent, so regressions
survive undetected rather than being caught at the moment they are introduced.

The insight is a size-and-shape mismatch, not a preference. Every project in this portfolio
sits just above the free ceiling of the tools that could otherwise check it - 400-1,200 URLs
against free tiers that stop at around 500 - and the developer will not spend on tool
licences (AI token cost is the one accepted exception). The 2-6 language variants multiply
the work in a way per-URL tools do not model: they treat each URL as independent, so nothing
reports whether the variants of one page are in sync. Two capability gaps were named
directly: cross-language consistency between variants, and correlating findings that
separate tools report as unrelated items but which are one underlying problem on one page.

## User & Persona

**Primary persona - the maintaining developer.** A freelance or agency web developer
responsible for the ongoing health of 3-10 client sites they did not build alone and do not
own. They work across multilingual sites (2-6 variants each, ~200 pages per variant set).

They reach for this product at two moments:

1. **Immediately after a deploy** - to confirm no component broke.
2. **As the final gate before go-live** - the check they currently describe as painful.

They also need to answer "how is the site doing?" on demand for a client. Non-technical
client stakeholders are therefore a downstream audience for the product's output, though not
users of the product itself.

What counts as a failure worth flagging, per the user, is all four of:

- **Visual / layout regression** - a component renders differently than before: shifted,
  overlapping, missing, wrong size.
- **HTTP or console errors** - 404s, 500s, broken links, failed asset loads, JavaScript
  exceptions.
- **Performance regression** - Core Web Vitals or Lighthouse scores dropped versus the
  previous run on the same page.
- **SEO metadata regression** - missing or duplicate titles, broken canonicals, wrong or
  missing hreflang between language variants, `noindex` accidentally shipped to production.

### Open tension carried into Phase 3

The user selected "on demand - client-facing report" as the primary trigger, then described
the actual daily pain as post-deploy verification and the pre-go-live gate. When asked to
resolve, the user chose **"they are genuinely equal - I need both in v1"**, having been shown
that this doubles MVP scope. Recorded as the user's decision; re-tested in Phase 3 against a
concrete timeline.

## Success Criteria

### Primary

- **The pre-go-live check stops being painful.** Full pre-launch verification of a
  400-1,200 URL multilingual site completes in one run the developer triggers and reads,
  replacing manual per-language spot-checking.
- **The go-live check is fast enough that it actually gets run.** The developer runs a check
  before every go-live because it is quick enough not to be skipped - replacing the current
  "manual spot-check when I remember" behaviour. Reworded from an earlier "on every deploy"
  formulation, which was incompatible with the standalone / no-pipeline-coupling constraint.

> Note: "I catch regressions before the client does" and "I can hand a client a credible
> report without extra work" were offered as primary criteria and NOT selected. The user's
> primary bar is therefore about the *check being performed reliably and cheaply*, not about
> detection rate or client-facing output.

### Secondary

- Trend history - quality drift visible over months, not just last-run comparison.
- Scheduled unattended runs that fire without the developer triggering them.
- Works against staging / password-protected environments, before a build is public.

> Note: "AI suggests actual fixes, not just descriptions" was offered and NOT selected.

### Guardrails

- **Never degrade a client's live site.** Crawling up to 1,200 URLs plus performance runs
  against production must never cause an outage, trip rate limits, or pollute the client's
  analytics. Causing an incident is worse than the regression being hunted.
- **No false-positive fatigue.** If runs routinely report changes that do not matter, the
  developer stops reading them and the product is dead. Signal quality is a survival
  requirement, not a polish item - most acutely for visual diffing.
- **Client data isolation is absolute.** No client sees another client's results through any
  path - report, URL, link, or AI prompt. One cross-tenant leak is a business-ending event
  for an agency.

> Note: "AI spend stays bounded and predictable" was offered as a guardrail and NOT selected,
> despite zero-licence-budget being a stated hard constraint and AI tokens being the single
> accepted cost. See the AI-priority tension recorded in the checkpoint.

## Timeline acknowledgment

Acknowledged on 2026-08-19: the user was shown a 13-subsystem inventory totalling an
estimated 30-45 weeks of after-hours work (roughly 15-23 weeks at the user's stated 10-20
hrs/week budget), was offered two concrete scope-down slices of 4-6 and 6-8 weeks, declined
both, and committed to the full scope understanding it requires sustained dedication over
months with periods where progress feels invisible. The user then declined to fix a week
count, electing an open-ended timeline.

`timeline_budget.mvp_weeks` is therefore `null`. This acknowledgment block is the record that
the cost was surfaced and accepted.

**Sequencing note:** full scope in the PRD does not mean an undifferentiated build.
`/10x-roadmap` runs downstream of `/10x-prd` and slices this into ordered, vertical,
independently-shippable milestones. Scope and order are separate decisions.

## User Stories

### US-01: Pre-go-live check of a multilingual client site

- **Given** an Owner with a configured project of roughly 200 pages across 4 language variants,
  and at least one previous stored run
- **When** they trigger a check before taking the site live
- **Then** they see, in a single result, every page that fails, regressed, or diverges from its
  language siblings - without inspecting each variant by hand

#### Acceptance criteria

- One trigger covers all declared language variants; the user does not start a run per language.
- Findings of different types on the same page appear grouped as one page-level item (FR-041),
  not as separate unrelated entries.
- Pages missing a language variant are reported as findings in their own right (FR-026), not as
  silent absences.
- A page whose siblings are healthy but which itself regressed is surfaced as a comparative
  finding (FR-028).
- The run completes fast enough that the user does not skip it - the criterion the Primary
  success bar rests on.
- The run does not degrade the live site being checked (Guardrail 1).

### US-02: Deciding whether a deploy broke anything

- **Given** a project with an established baseline and prior run
- **When** the Owner runs a check after deploying
- **Then** they see only what changed since the previous run, separated from pre-existing
  known state

#### Acceptance criteria

- The result distinguishes new findings from findings that were already present.
- Visual differences are shown against the baseline with the differing regions indicated.
- Unchanged pages do not compete for attention with changed ones.

## Functional Requirements

> **Numbering note.** FR-006 and FR-022 were dropped during the Socrates round. Their numbers
> are left vacant rather than renumbering, so cross-references from User Stories and Socrates
> blockquotes stay valid. `/10x-prd` renumbers cleanly when it writes the PRD.
>
> **Socrates round note.** The process calls for one challenge per FR. At 45 FRs that volume
> would produce rubber-stamping, so challenges were batched by group and run against the eight
> groups where a genuine counter-argument existed. Groups without a real counter-argument
> (sign-in, project CRUD, run storage, history) inherit their group result. This deviation is
> recorded deliberately rather than left silent.

### Accounts & tenancy

- FR-001: Owner can create an account from an invite. Priority: must-have
- FR-002: User can sign in to their account. Priority: must-have
- FR-003: Owner can invite a Team-member into the tenant. Priority: must-have
- FR-004: Owner can invite a Client-viewer to a single project. Priority: must-have
- FR-005: Owner can assign a Team-member to specific projects. Priority: must-have
- ~~FR-006: Admin can administer accounts and tenants across the platform.~~ **DROPPED**

  > Socrates: Counter-argument considered: a platform-level Admin above Owners is scope from a
  > multi-agency SaaS the user is not building, and contradicts the freelancer/agency persona
  > captured in Phase 1. Resolution: FR-006 dropped. The role set reduces from four to three -
  > Owner, Team-member, Client-viewer. Access Control updated accordingly.
  >
  > Counter-arguments raised and NOT adopted for the remaining five: that roughly four weeks of
  > auth work precedes the first checked page, and that a tenant-scoped schema would give the
  > same future-proofing without login. FR-001 to FR-005 retained as must-have.

### Project management

- FR-007: Owner can create a project representing one client site. Priority: must-have
- FR-008: Owner can configure a project crawl scope - start URL, included and excluded paths. Priority: must-have
- FR-009: Owner can review and correct a project language-variant mapping, which the system derives automatically from the site's own hreflang declarations, falling back to URL pattern rules where hreflang is absent or broken. Priority: must-have
- FR-010: Owner or Team-member can view the projects they have access to. Priority: must-have
- FR-011: Client-viewer can view only their own project results. Priority: must-have
- FR-012: Owner can configure crawl rate and concurrency for a project. Priority: must-have

### Crawling

- FR-013: User can trigger a crawl of a project on demand. Priority: must-have
- FR-014: Crawler discovers all reachable pages within the configured scope, at the portfolio scale of up to roughly 1,200 URLs per project. Priority: must-have
- FR-015: Crawler records the HTTP status of every discovered URL. Priority: must-have
- FR-016: Crawler captures JavaScript console errors encountered on each page. Priority: must-have

### Technical checks

- FR-017: User can see broken internal and external links, and redirect chains or loops. Priority: must-have
- FR-018: User can see the reconciliation between a declared sitemap and the actual crawl - sitemap URLs that fail, and live pages absent from the sitemap. Priority: must-have
- FR-019: User can see which robots.txt rules block pages that were intended to be indexable. Priority: must-have
- FR-020: User can see orphan pages - pages reachable via sitemap but linked from nowhere. Priority: must-have
- FR-021: User can see duplicate titles and near-identical content across URLs. Priority: must-have
- ~~FR-022: User can see structured data validated against schema.org definitions.~~ **DROPPED**

  > Socrates: Counter-argument considered and AGREED WITH: this group is where the user rebuilds
  > Screaming Frog - all six exist in a mature tool that does them better than a v1 will, and
  > every week spent here is a week not spent on the multilingual work nothing else does.
  > Resolution: the user nonetheless retained FR-017 to FR-021 as must-have, and dropped only
  > FR-022, whose schema.org validator carries permanent maintenance cost as the specification
  > evolves. The rebuild concern is therefore acknowledged and overruled for five of six FRs -
  > recorded here so the roadmap can still sequence the differentiator first.

### SEO metadata

- FR-023: User can see missing, duplicated, or out-of-range titles and meta descriptions. Priority: must-have
- FR-024: User can see canonical tag problems - missing, self-conflicting, or pointing at non-canonical URLs. Priority: must-have
- FR-025: User can see pages carrying a noindex directive in a production environment. Priority: must-have

### Multilingual (differentiator)

- FR-026: User can see which pages are missing one or more language variants. Priority: must-have
- FR-027: User can see hreflang graph problems - non-reciprocal, incomplete, or pointing at dead URLs. Priority: must-have
- FR-028: User can see cross-variant parity problems - one language variant regressed while its siblings did not. Priority: must-have
- FR-029: User can see content drift between variants - divergent word counts, missing sections, untranslated placeholder text left in production. Priority: must-have

  > Socrates: Counter-argument considered: variant URL mapping needs manual setup per project,
  > and wrong mapping produces confidently wrong findings, so setup cost may exceed the value.
  > Resolution: mapping is not asked of the user by default. The system derives it from the
  > hreflang the site already publishes, falls back to URL pattern rules, and allows manual
  > correction (FR-009). Setup cost approaches zero on healthy sites, and pages where derivation
  > fails are themselves reportable findings via FR-027.
  >
  > Counter-arguments raised and NOT adopted: that content drift (FR-029) will fire constantly
  > because honest translations legitimately differ in length, and that hreflang validation
  > (FR-027) is already covered by free tools. Both retained as must-have. The FR-029 noise risk
  > is unresolved and carried to Open Questions.

### Performance & assets

- FR-030: User can see Lighthouse scores and Core Web Vitals for a representative sample of pages - one per page template per language variant - rather than for every crawled URL. Priority: must-have

  > Socrates: Counter-argument considered and ADOPTED: Lighthouse takes 10-30 seconds per page;
  > at 1,200 URLs that is 3-10 hours per run, which directly destroys the Primary success
  > criterion that the check be fast enough that the user actually runs it before go-live.
  > Resolution: FR-030 rewritten from per-page to sampled - one representative page per template
  > per language variant. Coverage is traded for a run duration compatible with the Primary
  > criterion.

- FR-031: User can see image weight and optimization problems - oversized images, missing modern formats, missing dimensions. Priority: must-have

### Security

- FR-032: User can see security header and SSL certificate problems, including certificate expiry. Priority: must-have

### Visual regression

- FR-033: System captures a rendered snapshot of each page in a run. Priority: must-have
- FR-034: User can promote a snapshot to be a project baseline. Priority: must-have
- FR-035: User can see which pages differ visually from their baseline, and where on the page they differ. Priority: must-have
- FR-036: User can review a visual difference side by side against its baseline. Priority: must-have
- FR-046: Owner can mark regions of a page - carousels, ad slots, date stamps, rotating banners - as excluded from visual comparison for that project. Priority: must-have

  > Socrates: Counter-argument considered and ADOPTED: dynamic content makes visual regression
  > unreliable on real client sites - carousels, rotating banners, ads, dates, A/B tests and
  > lazy-loaded images produce differences on every run without anything being broken.
  > Resolution: FR-046 added - per-project ignore-regions that mask volatile areas from diffing.
  > This partially restores the false-positive defence lost when severity triage was declined.
  >
  > Counter-arguments raised and NOT adopted: that declining triage leaves false positives with
  > nowhere to go, violating the stated no-false-positive-fatigue guardrail; and that snapshot
  > storage across 1,200 URLs by baselines by history by 3-10 projects is the line item most
  > likely to force a hosting bill in a zero-budget product. Both carried to Open Questions.

### Runs, history & comparison

- FR-037: Every check execution is stored as a timestamped run belonging to a project. Priority: must-have
- FR-038: User can compare a run against the previous run and see what changed between them. Priority: must-have
- FR-039: User can view a project run history. Priority: must-have
- FR-040: User can see scores and issue counts tracked over time to reveal quality drift. Priority: nice-to-have

### Correlation

- FR-041: Findings produced by different check types on the same page are analysed to determine which of them share an underlying cause, and are presented as a single explained problem rather than as unrelated items. Priority: must-have

  > Socrates: Challenge posed - is this the domain rule, or is it grouping by URL, a UI feature?
  > Resolution: the user affirmed it is the domain rule. The product does not merely collate
  > findings by page; it infers that a slow page, a shifted layout and a failed asset constitute
  > one broken deploy, and says so. FR-041 was rewritten from "grouped into a single page-level
  > finding" to reflect inference rather than collation. This is the answer to what the
  > application decides for the user, and is load-bearing for Business Logic.

### Reporting

- FR-042: User can generate a client-readable report from a stored run. Priority: nice-to-have

  > Socrates: Counter-argument considered and ADOPTED: the user declined "I can hand a client a
  > credible report without extra work" as a Primary success criterion, so must-have contradicts
  > their own stated priority. Resolution: demoted to nice-to-have so it stops competing with the
  > differentiator for build time.
  >
  > A larger reduction was offered and NOT taken: demoting reporting AND dropping the
  > Client-viewer role with it, which would remove FR-004, FR-011 and most multi-tenancy cost.
  > The user retained client logins.

### Scheduling & environments

- FR-043: Owner can schedule recurring runs for a project without triggering them manually. Priority: nice-to-have
- FR-044: User can run checks against a staging or password-protected environment before it is public. Priority: nice-to-have

### AI assistance

- FR-045: User can have findings ranked by an AI service according to which matter most. Priority: nice-to-have

  > Socrates: Counter-argument considered and PARTIALLY ADOPTED: AI was declined twice - as a
  > secondary success criterion and as a bounded-spend guardrail - so it is present only from
  > seed inertia; and it is the single uncapped recurring cost in a product whose defining
  > constraint is zero spend. Resolution: FR-045 narrowed from "explains findings and suggests
  > fixes" to prioritisation only - ranking which findings matter most. Explanation and fix
  > suggestion are dropped, on the reasoning that a finding needing AI to explain it is a badly
  > written finding. Prioritisation is retained because it is the one job the checks cannot do
  > for themselves, and because it is now the closest thing to a false-positive defence.
  >
  > Cost remains uncapped: the bounded-AI-spend guardrail was declined. Carried to Open Questions.

## Non-Functional Requirements

- **Checking never degrades the site being checked.** A site under check suffers no measurable
  availability or latency impact, and request volume stays under a per-project configured
  ceiling. Causing a client incident is a worse outcome than the regression being hunted.
- **No client's data is reachable from another client's session.** Binary commitment. Isolation
  holds across every surface a result can appear on - stored results, generated reports, any
  shareable link, and any data submitted to an external ranking service.
- **Stored snapshots and run history stay within a bounded footprint.** Retention is finite;
  old runs and their snapshots expire rather than accumulating without limit. This is the
  outer-boundary answer to the storage growth risk identified in the visual-regression
  challenge (1,200 URLs x baselines x history x 3-10 projects).

> **NOT captured, deliberately.** A run-duration NFR was offered - "a full check of a 1,200-URL
> multilingual site finishes fast enough to run before go-live" - and declined, as was every
> proposed numeric target (10 min / 30 min / 2 hr). The user elected "no target - it takes what
> it takes". The consequence was stated at the time and accepted: the Primary success criterion
> "fast enough that it actually gets run" has no threshold and is therefore currently
> untestable. Carried to Open Questions.

## Business Logic

**Given a page's findings across all its language variants and its previous run, the product
decides which findings share an underlying cause and whether the page has genuinely regressed -
reporting one explained problem instead of many symptoms.**

The rule consumes three user-facing inputs: the set of problems observed on a page during the
current check, the same page's language siblings and their observed state, and what the page
looked like the last time it was checked. None of these are new information in isolation -
every input is something an existing tool can already report. The decision is what the product
adds.

Its output is a single explained problem per underlying cause, rather than a list of symptoms.
Where a slow page, a shifted layout and a failed asset all trace to one broken deploy, the user
is told that once. Where five language variants are healthy and one is not, the divergence
itself is the finding, not five independent per-URL reports of which one happens to be bad.
Where a problem was already present at the previous check, it is separated from what actually
changed, so a go-live decision is made against the delta rather than against accumulated
known state.

The user encounters the rule as the primary result of any check: they open a run and see
problems, ranked and explained, instead of a table of raw findings to interpret themselves.
This is the difference between this product and running its constituent checks separately -
the constituent checks produce the inputs; this rule produces the answer.

> Empty-CRUD check: PASSED. The product applies a real domain decision (cause inference,
> regression discrimination, and cross-variant comparison) rather than storing and displaying
> records. The rule was challenged directly in Phase 4.5 - "is this the domain rule, or is it
> grouping by URL, a UI feature?" - and the user affirmed inference over collation.

## Access Control

**Model: multi-tenant, invite-only, three roles.** Chosen deliberately over the cheaper
single-user / no-auth and export-only options, both of which were presented with their cost
savings and declined. Client data isolation - client A must never see client B - is therefore
a load-bearing constraint on every data access path in the product.

### Roles and capabilities

| Role | Scope | Can do |
|---|---|---|
| ~~Admin~~ | - | **DROPPED in Phase 4.5** - platform-level administration was scope from a multi-agency SaaS the user is not building |
| **Owner** | All projects in their tenant | Full control: create projects, configure crawls, run checks, view all results, manage users and billing, delete projects |
| **Team-member** | Assigned projects only | Run checks and view results on assigned projects; cannot manage users or billing, cannot delete projects |
| **Client-viewer** | The single project they belong to | Read-only access to that project's results |

### Account creation

**Invite-only.** There is no public self-serve registration. The Owner creates the account or
sends an invite. This removes public registration, email-verification flow, bot/spam signup
handling, and the associated abuse surface from scope - a deliberate cost reduction that
matches the agency relationship, where the client is already known.

### Note on sequencing

This is the **target** access model, not a statement that all of it ships in v1. None of the
four failure classes the product detects (visual, HTTP, performance, SEO) require
multi-tenancy to function; auth and tenancy sit between the user and the product's value.
The cost of building tenancy before the first useful crawl was surfaced and the model was
confirmed anyway. What actually ships first is decided in Success Criteria / MVP scope.

## Non-Goals

### Functional non-goals

Selected explicitly in Phase 6:

- **Content and keyword SEO - rankings, backlinks, keyword research.** The product stays
  strictly technical and on-page. This is the line between a crawler-based auditor and a
  rank-tracking suite, and it was identified as the most likely direction for scope to creep.
- **Auto-remediation.** The product reports and explains; it never edits a client site. This
  also removes write access to client systems from the security surface entirely.
- **Continuous uptime and availability monitoring.** Checks run on demand or on a schedule,
  never as always-on monitoring. Consistent with the standalone stance, and keeps the product
  out of on-call territory.
- **Real-user monitoring.** No script is embedded in client sites to collect field data from
  actual visitors. The product remains entirely external to the sites it checks.

Declined earlier in the session and recorded here so they cannot return by default:

- **CI/CD and deployment-pipeline integration.** Stated directly by the user: the project is
  standalone and must not connect to any project pipeline or deployment process. Rules out
  deploy webhooks and build-failing CI integration.
- **Notifications and alerting.** Offered as the mechanism that would make scheduled runs
  useful without the user remembering to open the dashboard; declined.
- **Severity triage - mute, accept, snooze a finding.** Offered as the defence against the
  stated no-false-positive-fatigue guardrail; declined. Only per-project visual ignore-regions
  (FR-046) survive.
- **Accessibility auditing.** Offered twice, declined twice.
- **Third-party script weight tracking.** Offered twice, declined twice.
- **Structured data / schema.org validation.** Dropped as FR-022 during the Socrates round for
  permanent maintenance cost.
- **Platform-level multi-agency administration.** Dropped as FR-006; the product serves one
  agency, not many.
- **Public self-serve registration.** Accounts are invite-only, which removes registration,
  email verification and abuse handling from scope.
- **AI explanation of findings and fix suggestion.** Narrowed out of FR-045, which now covers
  prioritisation only, on the reasoning that a finding requiring AI to explain it is a badly
  written finding.

### Non-functional non-goals

- **No high-availability guarantee for the product itself.** If Sitesmith-Studio is down, the
  check runs later. It is a gate its operator runs, not a service anyone depends on
  continuously. Removes redundancy, failover and uptime targets from scope.
- **No compliance certification (SOC 2, ISO 27001).** Client data isolation remains a hard
  requirement; formal certification of it is not pursued.
- **No horizontal scale beyond a single machine.** The product is sized for 3-10 projects and
  single-digit users. Rules out distributed crawling and multi-node architecture.
- **No offline capability.** Checking a website is inherently online; recording this prevents
  the question recurring.

### Note on scale and the shape of the rule

Asked how the domain rule would change at 100x scale (50 projects rather than 3-10), the user
answered that it would not - cause inference and variant comparison operate within one page's
family of variants, so more projects means more volume rather than a different decision. The
rule is therefore soundly scoped for the stated scale.

Two alternatives were offered and not chosen, recorded as the directions the rule would grow
rather than as gaps: that prioritisation (FR-045) would become the core of the product at a
scale where no human can read every run, and that cross-project patterns - "this CMS update
broke the same component on nine client sites" - would become the real value. The current
rule cannot make a cross-project finding, because it reasons within a single page's variants.

---

## Open Questions

1. **What run duration makes the Primary criterion testable?** The Primary success criterion
   depends on a check being "fast enough that it actually gets run", but no target was set and
   the corresponding NFR was declined. Until a threshold exists, success cannot be evaluated.
   Owner: user. Block: partial - the product can be built, but its primary bar cannot be
   assessed.
2. **What mechanism delivers the no-false-positive-fatigue guardrail?** Severity triage
   (mute / accept / snooze) was offered as the defence and declined. Per-project ignore-regions
   (FR-046) partially cover visual noise only. Every non-visual check - and FR-029 content
   drift in particular - has no mechanism for suppressing known-acceptable findings, so signal
   quality must come entirely from conservative detection logic. Owner: user.
3. **Will FR-029 (content drift between variants) be noise by default?** Honest translations
   legitimately differ in length; German runs materially longer than English. The counter-argument
   was raised and the FR retained as must-have without a resolution. Owner: user.
4. **What bounds AI spend?** AI token cost is the single accepted recurring cost in an otherwise
   zero-budget product, and the bounded-AI-spend guardrail was explicitly declined. FR-045 is
   therefore an uncapped cost. Owner: user.
5. **Does snapshot retention conflict with regression detection?** The bounded-footprint NFR
   requires runs and snapshots to expire, while trend history (FR-040) and baseline comparison
   require history to persist. The retention window that satisfies both is unresolved.
   Owner: user.
6. **Is full-scope run time compatible with a go-live gate at all?** Crawling up to 1,200 URLs,
   capturing a snapshot per page, and sampling Lighthouse may be structurally incompatible with
   a check the user runs casually before every launch - independent of question 1's threshold.
   Owner: user.

## Quality cross-check

Run 2026-08-19 against the six greenfield gate elements.

| Element | Result |
|---|---|
| Access Control | **present** - three roles (Owner, Team-member, Client-viewer), invite-only, tenancy named as load-bearing on every data path |
| Business Logic | **present** - single declarative rule stated; empty-CRUD check PASSED (inference affirmed over collation in Phase 4.5) |
| Project artifacts | **present** - shape-notes.md with valid frontmatter checkpoint |
| Timeline-cost acknowledged | **present** - 13-subsystem / 30-45 week inventory presented, two concrete scope-down slices declined, sustained-effort cost explicitly accepted |
| Non-Goals | **present** - 4 new functional, 10 previously-declined functional, 4 non-functional |
| Preserved behavior | **n/a** - greenfield session |

**Status: accepted.** No gate element is missing or weak.

The gate is deliberately narrow, and passing it is not a claim that the shape is free of risk.
Six substantive Open Questions are recorded in the section above and were reviewed with the
user before finishing. Three are load-bearing:

- **Open Question 1 - no run-duration target.** The Primary success criterion is that a check
  be "fast enough that it actually gets run". No threshold was set and the corresponding NFR
  was declined, so the criterion is currently untestable.
- **Open Question 2 - no false-positive mechanism.** No-false-positive-fatigue is a stated
  guardrail, but severity triage was declined. Only per-project visual ignore-regions (FR-046)
  survive; every non-visual check has no suppression path.
- **Open Question 6 - full-scope run time versus a go-live gate.** Crawling up to 1,200 URLs,
  snapshotting each page and sampling Lighthouse may be structurally incompatible with a check
  run casually before every launch, independent of whether a threshold exists.

Questions 1 and 6 are the same risk from two directions: the product's value rests on the user
actually running it, and nothing currently in the specification protects that property. The
user reviewed all three and elected to carry them into the PRD rather than resolve them now.

## Forward: tech-stack

Tools and technologies the user named up-front. NOT stack commitments - captured here for the
downstream tech-stack-selection step, not for the PRD.

- **Playwright** - floated for the visual regression / snapshot capture capability
- **Unlighthouse** - floated for Lighthouse scoring / Core Web Vitals at site scale
- **OpenRouter** - floated as the AI provider gateway for findings analysis and fix suggestions
- **Screaming Frog SEO Spider** - named as the reference product to model and exceed
- **Hard constraint carried forward:** zero spend on tool licences. Any candidate stack
  component with a paid tier that this portfolio size would trigger is disqualified. AI token
  cost is the accepted exception.
