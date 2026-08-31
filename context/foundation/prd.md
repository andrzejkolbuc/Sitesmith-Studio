---
project: "Sitesmith-Studio"
version: 1
status: draft
created: 2026-08-20
context_type: greenfield
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

# Sitesmith-Studio - Product Requirements

## Vision & Problem Statement

A freelance or agency web developer maintains 3-10 client websites they do not own. Each site
runs roughly 200 pages across 2-6 language variants - 400 to 1,200 URLs per project. Two
moments hurt: immediately after a deploy, when the question is whether the frontend is still
intact and no component broke; and the final check before a site goes live, which the
developer describes as painful. Today that check is a manual spot-check performed when
remembered, repeated per project and per language variant. Because it is manual it is
inconsistent, so regressions survive undetected rather than being caught at the moment they
are introduced.

The insight is a size-and-shape mismatch, not a preference. Every project in this portfolio
sits just above the free ceiling of the tools that could otherwise check it - 400-1,200 URLs
against free tiers that stop at around 500 - and the developer will not spend on tool
licences, with AI token cost the one accepted exception. The 2-6 language variants multiply
the work in a way per-URL tools do not model: they treat each URL as independent, so nothing
reports whether the variants of one page are in sync. Two capability gaps were named
directly: cross-language consistency between variants, and correlating findings that separate
tools report as unrelated items but which are one underlying problem on one page.

## User & Persona

**Primary persona - the maintaining developer.** A freelance or agency web developer
responsible for the ongoing health of 3-10 client sites they did not build alone and do not
own. They work across multilingual sites, 2-6 variants each, roughly 200 pages per variant
set.

They reach for this product at two moments:

1. **Immediately after a deploy** - to confirm no component broke.
2. **As the final gate before go-live** - the check they currently describe as painful.

They also need to answer "how is the site doing?" on demand for a client. Non-technical client
stakeholders are therefore a downstream audience for the product's output, though not users of
the product itself.

What counts as a failure worth flagging is all four of:

- **Visual or layout regression** - a component renders differently than before: shifted,
  overlapping, missing, wrong size.
- **HTTP or console errors** - 404s, 500s, broken links, failed asset loads, JavaScript
  exceptions.
- **Performance regression** - Core Web Vitals or page performance scores dropped versus the
  previous run on the same page.
- **SEO metadata regression** - missing or duplicate titles, broken canonicals, wrong or
  missing hreflang between language variants, a noindex directive accidentally shipped to
  production.

### Secondary persona

**The client stakeholder.** A non-technical contact at the client organisation who reads
results about their own site and nothing else. They never configure or trigger anything. Their
existence is what makes client data isolation a hard requirement rather than a convenience.

## Success Criteria

### Primary

- **The pre-go-live check stops being painful.** Full pre-launch verification of a 400-1,200
  URL multilingual site completes in one run the developer triggers and reads, replacing
  manual per-language spot-checking.
- **The go-live check is fast enough that it actually gets run.** The developer runs a check
  before every go-live because it is quick enough not to be skipped, replacing the current
  "manual spot-check when I remember" behaviour.

> Two alternative primary criteria were offered during shaping and NOT selected: "I catch
> regressions before the client does" and "I can hand a client a credible report without extra
> work". The primary bar is therefore about the check being performed reliably and cheaply,
> not about detection rate or client-facing output.
>
> The second criterion was reworded from an earlier "checked on every deploy" formulation,
> which was incompatible with the standalone constraint recorded in Non-Goals: with no
> deployment-pipeline coupling, nothing can trigger a check on deploy.

### Secondary

- Trend history - quality drift visible over months, not just last-run comparison.
- Scheduled unattended runs that fire without the developer triggering them.
- Checks that work against staging or password-protected environments, before a build is
  public.

> "AI suggests actual fixes, not just descriptions" was offered as a secondary criterion and
> NOT selected.

### Guardrails

- **Never degrade a client's live site.** Checking up to 1,200 URLs plus performance
  measurement against production must never cause an outage, exhaust a rate limit, or pollute
  the client's analytics. Causing an incident is worse than the regression being hunted.
- **No false-positive fatigue.** If runs routinely report changes that do not matter, the
  developer stops reading them and the product is dead. Signal quality is a survival
  requirement, not a polish item - most acutely for visual comparison.
- **Client data isolation is absolute.** No client sees another client's results through any
  path. One cross-tenant leak is a business-ending event for an agency.

> "AI spend stays bounded and predictable" was offered as a guardrail and NOT selected,
> despite zero licence spend being a stated hard constraint and AI tokens being the single
> accepted cost. See Open Question 4.

> **Timeline cost, acknowledged.** During shaping the user was shown a 13-subsystem inventory
> totalling an estimated 30-45 weeks of after-hours work - roughly 15-23 weeks at their stated
> 10-20 hrs/week budget - was offered two concrete scope-down slices of 4-6 and 6-8 weeks,
> declined both, and committed to the full scope understanding it requires sustained dedication
> over months with periods where progress feels invisible. The user then declined to fix a week
> count, electing an open-ended timeline; `timeline_budget.mvp_weeks` is `null` for that reason.
> Full scope here describes the product, not a build order - sequencing into vertical,
> independently shippable milestones is a downstream concern.

## User Stories

### US-01: Pre-go-live check of a multilingual client site

- **Given** an Owner with a configured project of roughly 200 pages across 4 language variants,
  and at least one previous stored run
- **When** they trigger a check before taking the site live
- **Then** they see, in a single result, every page that fails, regressed, or diverges from its
  language siblings - without inspecting each variant by hand

#### Acceptance Criteria

- One trigger covers all declared language variants; the user does not start a run per language.
- Findings of different types on the same page appear as one explained page-level problem
  (FR-040), not as separate unrelated entries.
- Pages missing a language variant are reported as findings in their own right (FR-024), not as
  silent absences.
- A page whose siblings are healthy but which itself regressed is surfaced as a comparative
  finding (FR-026).
- The run completes fast enough that the user does not skip it - the property the Primary
  success bar rests on. No numeric threshold is currently defined; see Open Question 1.
- The run does not degrade the live site being checked.

### US-02: Deciding whether a deploy broke anything

- **Given** a project with an established visual baseline and at least one prior run
- **When** the Owner runs a check after deploying
- **Then** they see only what changed since the previous run, separated from pre-existing known
  state

#### Acceptance Criteria

- The result distinguishes new findings from findings that were already present.
- Visual differences are shown against the baseline with the differing regions indicated.
- Unchanged pages do not compete for attention with changed ones.

## Functional Requirements

> Requirements were renumbered sequentially when this PRD was generated. Two requirements were
> dropped during shaping and are recorded in Non-Goals rather than carried here as gaps.
> Socratic blockquotes below are preserved verbatim from shaping; they record counter-arguments
> raised against a requirement and how the user resolved them.

### Accounts & tenancy

- FR-001: Owner can create an account from an invite. Priority: must-have
- FR-002: User can sign in to their account. Priority: must-have
- FR-003: Owner can invite a Team-member into the tenant. Priority: must-have
- FR-004: Owner can invite a Client-viewer to a single project. Priority: must-have
- FR-005: Owner can assign a Team-member to specific projects. Priority: must-have

  > Socrates: A platform-level Admin role above Owners was proposed and dropped - it is scope
  > from a multi-agency product the user is not building, and contradicts the freelancer or
  > agency persona. The role set is three: Owner, Team-member, Client-viewer.
  >
  > Counter-arguments raised and NOT adopted for the remaining five: that roughly four weeks of
  > account work precedes the first checked page, and that scoping every record to a tenant from
  > the first day would give the same future-proofing without sign-in. FR-001 to FR-005 retained
  > as must-have.

### Project management

- FR-006: Owner can create a project representing one client site. Priority: must-have
- FR-007: Owner can configure a project crawl scope - start URL, included and excluded paths. Priority: must-have
- FR-008: Owner can review and correct a project language-variant mapping, which the product derives automatically from the hreflang declarations the site already publishes, falling back to URL pattern rules where hreflang is absent or broken. Priority: must-have
- FR-009: Owner or Team-member can view the projects they have access to. Priority: must-have
- FR-010: Client-viewer can view only their own project results. Priority: must-have
- FR-011: Owner can configure request rate and concurrency for a project. Priority: must-have

### Crawling

- FR-012: User can trigger a check of a project on demand. Priority: must-have
- FR-013: The product discovers all reachable pages within the configured scope, at a portfolio scale of up to roughly 1,200 URLs per project. Priority: must-have
- FR-014: The product records the HTTP status of every discovered URL. Priority: must-have
- FR-015: The product captures JavaScript console errors encountered on each page. Priority: must-have

### Technical checks

- FR-016: User can see broken internal and external links, and redirect chains or loops. Priority: must-have
- FR-017: User can see the reconciliation between a declared sitemap and the actual crawl - sitemap URLs that fail, and live pages absent from the sitemap. Priority: must-have
- FR-018: User can see which robots.txt rules block pages that were intended to be indexable. Priority: must-have
- FR-019: User can see orphan pages - pages reachable via sitemap but linked from nowhere. Priority: must-have
- FR-020: User can see duplicate titles and near-identical content across URLs. Priority: must-have

  > Socrates: Counter-argument considered and AGREED WITH: this group is where the user rebuilds
  > Screaming Frog - these checks exist in a mature tool that does them better than a first
  > version will, and every week spent here is a week not spent on the multilingual work nothing
  > else does. Resolution: the user nonetheless retained these five as must-have, and dropped
  > only structured-data validation, whose validator carries permanent maintenance cost as the
  > specification evolves. The rebuild concern is acknowledged and overruled for five of six -
  > recorded so that build sequencing can still put the differentiator first.

### SEO metadata

- FR-021: User can see missing, duplicated, or out-of-range titles and meta descriptions. Priority: must-have
- FR-022: User can see canonical tag problems - missing, self-conflicting, or pointing at non-canonical URLs. Priority: must-have
- FR-023: User can see pages carrying a noindex directive in a production environment. Priority: must-have

### Multilingual consistency

- FR-024: User can see which pages are missing one or more language variants. Priority: must-have
- FR-025: User can see hreflang graph problems - non-reciprocal, incomplete, or pointing at dead URLs. Priority: must-have
- FR-026: User can see cross-variant parity problems - one language variant regressed while its siblings did not. Priority: must-have
- FR-027: User can see content drift between variants - divergent word counts, missing sections, untranslated placeholder text left in production. Priority: must-have

  > Socrates: Counter-argument considered: variant URL mapping needs manual setup per project,
  > and wrong mapping produces confidently wrong findings, so setup cost may exceed the value.
  > Resolution: mapping is not asked of the user by default. It is derived from the hreflang the
  > site already publishes, falls back to URL pattern rules, and allows manual correction
  > (FR-008). Setup cost approaches zero on healthy sites, and pages where derivation fails are
  > themselves reportable findings via FR-025.
  >
  > Counter-arguments raised and NOT adopted: that content drift (FR-027) will fire constantly
  > because honest translations legitimately differ in length, and that hreflang validation
  > (FR-025) is already covered by free tools. Both retained as must-have. The FR-027 noise risk
  > is unresolved; see Open Question 3.

### Performance & assets

- FR-028: User can see Core Web Vitals and standard page performance scores for a representative sample of pages - one per page template per language variant - rather than for every crawled URL. Priority: must-have

  > Socrates: Counter-argument considered and ADOPTED: measuring performance page by page takes
  > tens of seconds each; across 1,200 URLs that is hours per run, which directly destroys the
  > Primary success criterion that the check be fast enough that the user actually runs it before
  > go-live. Resolution: rewritten from per-page to sampled - one representative page per
  > template per language variant. Coverage is traded for a run duration compatible with the
  > Primary criterion.

- FR-029: User can see image weight and optimization problems - oversized images, missing modern formats, missing dimensions. Priority: must-have

### Security

- FR-030: User can see security header and certificate problems, including certificate expiry. Priority: must-have

### Visual regression

- FR-031: The product captures a rendered snapshot of each page in a run. Priority: must-have
- FR-032: User can promote a snapshot to be a project baseline. Priority: must-have
- FR-033: User can see which pages differ visually from their baseline, and where on the page they differ. Priority: must-have
- FR-034: User can review a visual difference side by side against its baseline. Priority: must-have
- FR-035: Owner can mark regions of a page - carousels, ad slots, date stamps, rotating banners - as excluded from visual comparison for that project. Priority: must-have

  > Socrates: Counter-argument considered and ADOPTED: dynamic content makes visual comparison
  > unreliable on real client sites - carousels, rotating banners, ads, dates, experiments and
  > lazily loaded images produce differences on every run without anything being broken.
  > Resolution: FR-035 added - per-project ignore-regions that mask volatile areas from
  > comparison. This partially restores the false-positive defence lost when severity triage was
  > declined.
  >
  > Counter-arguments raised and NOT adopted: that declining triage leaves false positives with
  > nowhere to go, violating the stated no-false-positive-fatigue guardrail; and that snapshot
  > storage across 1,200 URLs by baselines by history by 3-10 projects is the line item most
  > likely to force a hosting bill in a zero-budget product. See Open Questions 2 and 5.

### Runs, history & comparison

- FR-036: Every check execution is stored as a timestamped run belonging to a project. Priority: must-have
- FR-037: User can compare a run against the previous run and see what changed between them. Priority: must-have
- FR-038: User can view a project run history. Priority: must-have
- FR-039: User can see scores and issue counts tracked over time to reveal quality drift. Priority: nice-to-have

### Correlation

- FR-040: Findings produced by different check types on the same page are analysed to determine which of them share an underlying cause, and are presented as a single explained problem rather than as unrelated items. Priority: must-have

  > Socrates: Challenge posed - is this the domain rule, or is it grouping by URL, a presentation
  > feature? Resolution: the user affirmed it is the domain rule. The product does not merely
  > collate findings by page; it infers that a slow page, a shifted layout and a failed asset
  > constitute one broken deploy, and says so. The requirement was rewritten from "grouped into a
  > single page-level finding" to reflect inference rather than collation. This is the answer to
  > what the product decides for the user, and is load-bearing for Business Logic.

### Reporting

- FR-041: User can generate a client-readable report from a stored run. Priority: nice-to-have

  > Socrates: Counter-argument considered and ADOPTED: the user declined "I can hand a client a
  > credible report without extra work" as a Primary success criterion, so must-have contradicts
  > their own stated priority. Resolution: demoted to nice-to-have so it stops competing with the
  > differentiator for build time.
  >
  > A larger reduction was offered and NOT taken: demoting reporting AND dropping the
  > Client-viewer role with it, which would remove FR-004, FR-010 and most of the multi-tenancy
  > cost. The user retained client logins.

### Scheduling & environments

- FR-042: Owner can schedule recurring runs for a project without triggering them manually. Priority: nice-to-have
- FR-043: User can run checks against a staging or password-protected environment before it is public. Priority: nice-to-have

### Assisted prioritisation

- FR-044: User can have findings ranked by an assistive service according to which matter most. Priority: nice-to-have

  > Socrates: Counter-argument considered and PARTIALLY ADOPTED: assisted analysis was declined
  > twice - as a secondary success criterion and as a bounded-spend guardrail - so it is present
  > only from the original seed idea; and it is the single uncapped recurring cost in a product
  > whose defining constraint is zero spend. Resolution: narrowed from "explains findings and
  > suggests fixes" to prioritisation only - ranking which findings matter most. Explanation and
  > fix suggestion are dropped, on the reasoning that a finding requiring assistance to explain
  > it is a badly written finding. Prioritisation is retained because it is the one job the
  > checks cannot do for themselves, and because it is now the closest thing to a false-positive
  > defence. Cost remains uncapped; see Open Question 4.

## Non-Functional Requirements

- **Checking never degrades the site being checked.** A site under check suffers no measurable
  availability or latency impact, and request volume stays under a ceiling the Owner configures
  for that project. Causing a client incident is a worse outcome than the regression being
  hunted.
- **No client's data is reachable from another client's session.** Binary commitment. Isolation
  holds across every surface a result can appear on - stored results, generated reports, any
  shareable link, and any data submitted to an external service.
- **Stored snapshots and run history stay within a bounded footprint.** Retention is finite; old
  runs and their snapshots expire rather than accumulating without limit.

> **Deliberately not captured.** A run-duration requirement was offered - "a full check of a
> 1,200-URL multilingual site finishes fast enough to run before go-live" - and declined, as was
> every proposed numeric target. The user elected no target. The consequence was stated at the
> time and accepted: the Primary success criterion "fast enough that it actually gets run" has no
> threshold and is currently untestable. See Open Question 1.

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
changed, so a go-live decision is made against the delta rather than against accumulated known
state.

The user encounters the rule as the primary result of any check: they open a run and see
problems, ranked and explained, instead of a table of raw findings to interpret themselves.
This is the difference between this product and running its constituent checks separately - the
constituent checks produce the inputs; this rule produces the answer.

> The rule was challenged directly during shaping - "is this the domain rule, or is it grouping
> by URL, a presentation feature?" - and the user affirmed inference over collation.
>
> Asked how the rule would change at 100x scale, 50 projects rather than 3-10, the user answered
> that it would not: cause inference and variant comparison operate within one page's family of
> variants, so more projects means more volume rather than a different decision. Two growth
> directions were offered and not chosen, recorded here as where the rule would extend rather
> than as gaps: prioritisation becoming the core of the product at a scale where no human reads
> every run, and cross-project pattern findings - "this platform update broke the same component
> on nine client sites" - which the current rule cannot make, because it reasons within a single
> page's variants.

## Access Control

**Model: multi-tenant, invite-only, three roles.** Chosen deliberately over cheaper
single-user and export-only alternatives, both of which were presented with their cost savings
and declined. Client data isolation - one client must never see another client's data - is a
load-bearing constraint on every data access path in the product.

### Roles and capabilities

| Role | Scope | Can do |
|---|---|---|
| **Owner** | All projects in their tenant | Full control: create projects, configure checks, run them, view all results, manage users, delete projects |
| **Team-member** | Assigned projects only | Run checks and view results on assigned projects; cannot manage users, cannot delete projects |
| **Client-viewer** | The single project they belong to | Read-only access to that project's results |

A platform-level administrator role above Owners was considered and dropped during shaping; see
Non-Goals.

### Account creation

**Invite-only.** There is no public self-serve registration. The Owner creates the account or
sends an invite. This removes public registration, email verification, and bot or spam signup
handling from scope - a deliberate cost reduction that matches the agency relationship, where
the client is already known.

### Unauthenticated access

An unauthenticated visitor has access to no project data of any kind. The behaviour presented
to them at a gated route is unspecified in the input; see Open Question 7.

### Note on sequencing

This is the target access model, not a statement that all of it ships first. None of the four
failure classes the product detects - visual, HTTP, performance, SEO - require multi-tenancy to
function. The cost of building accounts and tenancy before the first useful check was surfaced
during shaping and the model was confirmed anyway.

## Non-Goals

### Functional non-goals

- **Content and keyword SEO - rankings, backlinks, keyword research.** The product stays
  strictly technical and on-page. This is the line between a crawler-based auditor and a
  rank-tracking suite, and it was identified during shaping as the most likely direction for
  scope to creep.
- **Auto-remediation.** The product reports and explains; it never edits a client site. This
  also removes write access to client systems from the security surface entirely.
- **Continuous uptime and availability monitoring.** Checks run on demand or on a schedule,
  never as always-on monitoring. This keeps the product out of on-call territory.
- **Real-user monitoring.** Nothing is embedded in client sites to collect field data from
  actual visitors. The product remains entirely external to the sites it checks.
- **Deployment-pipeline integration.** Stated directly by the user: the product is standalone
  and must not connect to any project pipeline or deployment process. This rules out automatic
  triggering on deploy and any ability to block a release. It is also why the second Primary
  criterion is framed around a check being fast enough to run, rather than around deploy
  coverage.
- **Notifications and alerting.** Offered as the mechanism that would make scheduled runs useful
  without the user remembering to open the product; declined.
- **Severity triage - muting, accepting, or snoozing a finding.** Offered as the defence
  against the no-false-positive-fatigue guardrail; declined. Only per-project visual
  ignore-regions (FR-035) survive. See Open Question 2.
- **Accessibility auditing.** Offered twice, declined twice.
- **Third-party script weight tracking.** Offered twice, declined twice.
- **Structured data validation against schema.org.** Dropped during shaping for the permanent
  maintenance cost of tracking an evolving specification.
- **Platform-level multi-agency administration.** The administrator role above Owners was
  dropped during shaping; the product serves one agency, not many.
- **Public self-serve registration.** Accounts are invite-only, which removes registration,
  email verification and abuse handling from scope.
- **Explanation of findings and fix suggestion by an assistive service.** Narrowed out of
  FR-044, which now covers prioritisation only, on the reasoning that a finding requiring
  assistance to explain it is a badly written finding.

### Non-functional non-goals

- **No high-availability guarantee for the product itself.** If the product is unavailable, the
  check runs later. It is a gate its operator runs, not a service anyone depends on
  continuously. Removes redundancy, failover and uptime targets from scope.
- **No compliance certification (SOC 2, ISO 27001).** Client data isolation remains a hard
  requirement; formal certification of it is not pursued.
- **No horizontal scale beyond a single machine.** The product is sized for 3-10 projects and
  single-digit users. Rules out distributed checking and multi-node operation.
- **No offline capability.** Checking a website is inherently online; recording this prevents
  the question recurring.

## Open Questions

1. **What run duration makes the Primary criterion testable?** The Primary success criterion
   depends on a check being "fast enough that it actually gets run", but no target was set and
   the corresponding non-functional requirement was declined. Until a threshold exists, success
   cannot be evaluated. Owner: user. Block: partial - the product can be built, but its primary
   bar cannot be assessed.
2. **What mechanism delivers the no-false-positive-fatigue guardrail?** Severity triage was
   offered as the defence and declined. Per-project ignore-regions (FR-035) cover visual noise
   only. Every non-visual check - and FR-027 content drift in particular - has no mechanism for
   suppressing known-acceptable findings, so signal quality must come entirely from conservative
   detection logic. Owner: user.
3. **Will FR-027, content drift between variants, be noise by default?** Honest translations
   legitimately differ in length; some languages run materially longer than others. The
   counter-argument was raised and the requirement retained as must-have without a resolution.
   Owner: user.

   > **Resolved 2026-08-31.** Not one check but three, shipped as independent rules in
   > ascending order of noise, each able to be trusted or distrusted on its own:
   >
   > 1. **Untranslated placeholder text** — `lorem ipsum`, `TODO`, unrendered interpolation
   >    markers, or a variant whose body is substantially identical to its sibling's. A site
   >    never means to publish these, so the false-positive rate is close to zero.
   > 2. **Missing sections** — compared *structurally* (heading counts and depth, presence of a
   >    form, table, or media block), never as prose. Structure is a translation-invariant the
   >    way word count is not.
   > 3. **Word count** — last, and only at the extreme: a member far below its family's median,
   >    where the reading is "most of this page is absent", not "German runs longer than
   >    English". Requires a family of three or more, so one short sibling cannot define the
   >    baseline.
   >
   > This answers the noise objection by removing the coupling that caused it: the signal most
   > likely to fire wrongly no longer decides whether the other two are believed. It is the same
   > conservatism that fixed detection rules 1 and 6 — see `context/foundation/lessons.md`.
4. **What bounds the cost of assisted prioritisation?** Token cost is the single accepted
   recurring cost in an otherwise zero-spend product, and the bounded-spend guardrail was
   explicitly declined. FR-044 is therefore an uncapped cost. Owner: user.

   > **Resolved 2026-08-31.** The bound is structural rather than monetary, because a spend cap
   > nobody can enforce is not a bound. One model call per run, over the correlated problems
   > S-09 produces (tens) rather than raw findings (hundreds), with the result cached against
   > the run so that re-reading it is free. Cost therefore scales with *runs*, not with pages: a
   > 1,200-URL crawl costs the same to rank as a 20-URL one. A hard ceiling on calls per month
   > sits behind that as a backstop, not as the primary defence.
5. **Does bounded retention conflict with regression detection?** The bounded-footprint
   requirement expects runs and snapshots to expire, while trend history (FR-039) and baseline
   comparison require history to persist. The retention window that satisfies both is
   unresolved. Owner: user.

   > **Resolved 2026-08-31.** The conflict came from treating runs and snapshots as one thing.
   > They have footprints four orders of magnitude apart, so retention is defined per artifact
   > class:
   >
   > - **Run metadata and findings** — kilobytes of rows. Kept indefinitely. This is what
   >   FR-039's trend history reads, so the trend comes for free rather than needing a window.
   > - **Snapshots** — the line item that would force a hosting bill. The baseline is pinned and
   >   never expires; beyond it only the most recent three runs' images are kept.
   >
   > Bounded footprint and persistent history stop contradicting each other once the bound is
   > applied to the bytes rather than to the history.
6. **Is full-scope run time compatible with a go-live gate at all?** Checking up to 1,200 URLs,
   capturing a snapshot per page, and sampling performance may be structurally incompatible with
   a check the user runs casually before every launch - independent of question 1's threshold.
   Owner: user.
7. **What does an unauthenticated visitor see at a gated route?** The access model is defined
   for the three roles, but the behaviour presented to an unauthenticated visitor was not
   specified in the input and has not been invented here. Owner: user. Block: no.

> The shaping session's closing quality cross-check passed on all six gate elements - access
> control, business logic, project artifacts, timeline-cost acknowledgment, non-goals, and
> preserved behaviour (not applicable for a greenfield project). Questions 1 to 6 above are
> carried forward from that session as substantive risks the user reviewed and elected not to
> resolve before writing this PRD. Question 7 was raised by this generation step, where the
> schema requires content the input did not supply.
