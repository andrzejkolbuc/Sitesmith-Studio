import { relations } from "drizzle-orm";
import {
	customType,
	index,
	pgTableCreator,
	primaryKey,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AdapterAccount } from "next-auth/adapters";

/**
 * Raw bytes.
 *
 * Postgres has `bytea` and drizzle has no built-in column for it, so it is
 * declared once here rather than in the one table that needs it — the next
 * binary column should reuse this rather than redeclare it.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
	dataType: () => "bytea",
});

/**
 * This is an example of how to use the multi-project schema feature of Drizzle ORM. Use the same
 * database instance for multiple projects.
 *
 * @see https://orm.drizzle.team/docs/goodies#multi-project-schema
 */
export const createTable = pgTableCreator((name) => `sitesmith-studio_${name}`);

/**
 * A tenant is one agency. It is the root every scoped record hangs from, and the
 * boundary the product promises never to leak across.
 */
export const tenants = createTable("tenant", (d) => ({
	id: d
		.varchar({ length: 255 })
		.notNull()
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: d.varchar({ length: 255 }).notNull(),
	createdAt: d
		.timestamp({ withTimezone: true })
		.$defaultFn(() => /* @__PURE__ */ new Date())
		.notNull(),
}));

export const users = createTable(
	"user",
	(d) => ({
		id: d
			.varchar({ length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		name: d.varchar({ length: 255 }),
		/**
		 * Unique because sign-in resolves an account by email. Without the constraint
		 * two rows could share an address and the lookup would be non-deterministic.
		 */
		email: d.varchar({ length: 255 }).notNull().unique(),
		emailVerified: d
			.timestamp({
				mode: "date",
				withTimezone: true,
			})
			.$defaultFn(() => /* @__PURE__ */ new Date()),
		image: d.varchar({ length: 255 }),
		/**
		 * Encoded scrypt digest — see `~/server/auth/password`. Nullable: a user
		 * invited but who has not yet set a password has none, and any federated
		 * provider added later would not use one.
		 */
		passwordHash: d.varchar({ length: 255 }),
		/**
		 * Nullable at the database level even though the application treats it as
		 * required. The Auth.js adapter's user-creation path knows nothing about
		 * tenants, so a NOT NULL column would break the first federated provider
		 * anyone adds, at the moment they add it. The tenant resolver denies access
		 * to a user with no tenant instead, so the invariant holds at the boundary
		 * where it matters.
		 *
		 * Do not "fix" this to NOT NULL without also handling adapter-created users.
		 */
		tenantId: d.varchar({ length: 255 }).references(() => tenants.id),
	}),
	(t) => [index("user_tenant_id_idx").on(t.tenantId)],
);

export const usersRelations = relations(users, ({ one, many }) => ({
	accounts: many(accounts),
	tenant: one(tenants, {
		fields: [users.tenantId],
		references: [tenants.id],
	}),
}));

export const accounts = createTable(
	"account",
	(d) => ({
		userId: d
			.varchar({ length: 255 })
			.notNull()
			.references(() => users.id),
		type: d.varchar({ length: 255 }).$type<AdapterAccount["type"]>().notNull(),
		provider: d.varchar({ length: 255 }).notNull(),
		providerAccountId: d.varchar({ length: 255 }).notNull(),
		refresh_token: d.text(),
		access_token: d.text(),
		expires_at: d.integer(),
		token_type: d.varchar({ length: 255 }),
		scope: d.varchar({ length: 255 }),
		id_token: d.text(),
		session_state: d.varchar({ length: 255 }),
	}),
	(t) => [
		primaryKey({ columns: [t.provider, t.providerAccountId] }),
		index("account_user_id_idx").on(t.userId),
	],
);

export const accountsRelations = relations(accounts, ({ one }) => ({
	user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const sessions = createTable(
	"session",
	(d) => ({
		sessionToken: d.varchar({ length: 255 }).notNull().primaryKey(),
		userId: d
			.varchar({ length: 255 })
			.notNull()
			.references(() => users.id),
		expires: d.timestamp({ mode: "date", withTimezone: true }).notNull(),
	}),
	(t) => [index("t_user_id_idx").on(t.userId)],
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
	user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

/**
 * A project is one client site under check.
 *
 * Deliberately minimal: start URL, crawl scope and language-variant configuration
 * belong to the slice that adds crawling. What matters here is that the table is
 * tenant-scoped from its first migration rather than retrofitted afterwards.
 */
export const projects = createTable(
	"project",
	(d) => ({
		id: d
			.varchar({ length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: d
			.varchar({ length: 255 })
			.notNull()
			.references(() => tenants.id),
		name: d.varchar({ length: 255 }).notNull(),
		/** Where a crawl begins. A project without one cannot be checked. */
		startUrl: d.varchar({ length: 2048 }).notNull(),
		/**
		 * Crawl scope. Empty `includePaths` means "anything on the start URL's
		 * origin"; `excludePaths` always wins over includes.
		 */
		includePaths: d
			.text()
			.array()
			.notNull()
			.$defaultFn(() => []),
		excludePaths: d
			.text()
			.array()
			.notNull()
			.$defaultFn(() => []),
		/**
		 * The locales this site is expected to publish, as BCP-47 tags.
		 *
		 * This is the declared expectation that makes a missing variant detectable
		 * at all — without it, a locale that vanished entirely would be
		 * indistinguishable from one the site never had.
		 */
		locales: d
			.text()
			.array()
			.notNull()
			.$defaultFn(() => []),
		/**
		 * Politeness ceiling. Defaults are deliberately timid: an unconfigured
		 * project must not be capable of stressing a client's site, because the
		 * cost of being too slow is a slow run and the cost of being too fast is
		 * someone else's outage.
		 */
		maxConcurrency: d.integer().notNull().default(2),
		requestDelayMs: d.integer().notNull().default(500),
		/**
		 * CSS selectors whose elements are painted over before a snapshot exists.
		 *
		 * Per project rather than per page, which is what FR-035 asks for and what
		 * a carousel or an ad slot actually is — a template's element, not one
		 * page's. Applied at capture rather than at comparison, so the volatile
		 * content never enters storage: nothing to leak, and an old snapshot never
		 * needs re-masking when this list changes.
		 *
		 * Stored as given. A selector that is valid CSS but matches nothing is
		 * indistinguishable here from one that will match, and refusing it would
		 * be us guessing about their markup.
		 *
		 * A database-level default rather than the `$defaultFn` its neighbours use:
		 * those were present when the table was created, this one arrives on a
		 * table that already has rows, and an application-side default leaves them
		 * violating the constraint.
		 */
		maskSelectors: d.text().array().notNull().default([]),
		/**
		 * The run whose snapshots are what this site is supposed to look like.
		 *
		 * Null means no baseline, which is a real and common state rather than an
		 * error — it is where every project starts and where most of them sit.
		 *
		 * Deliberately carries no foreign key. `runs` references `projects`, so a
		 * declared reference back would be a circular table dependency, and the
		 * column is read through a tenant-scoped query that establishes the run's
		 * ownership anyway. The integrity this would buy is integrity the read
		 * path already has to prove for itself.
		 */
		baselineRunId: d.varchar({ length: 255 }),
		baselinePinnedAt: d.timestamp({ withTimezone: true }),
		createdAt: d
			.timestamp({ withTimezone: true })
			.$defaultFn(() => /* @__PURE__ */ new Date())
			.notNull(),
		updatedAt: d.timestamp({ withTimezone: true }).$onUpdate(() => new Date()),
	}),
	(t) => [index("project_tenant_id_idx").on(t.tenantId)],
);

export const projectsRelations = relations(projects, ({ one, many }) => ({
	tenant: one(tenants, {
		fields: [projects.tenantId],
		references: [tenants.id],
	}),
	runs: many(runs),
}));

/**
 * One execution of a check against a project.
 *
 * The row is also the job's state. A trigger inserts it as `queued` and returns
 * before any crawling starts; the crawler advances it. Because the work happens
 * in-process, a run left in `queued` or `running` after a restart is by
 * definition stale, and the boot sweep closes it as `interrupted`.
 */
export const runs = createTable(
	"run",
	(d) => ({
		id: d
			.varchar({ length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: d
			.varchar({ length: 255 })
			.notNull()
			.references(() => tenants.id),
		projectId: d
			.varchar({ length: 255 })
			.notNull()
			.references(() => projects.id),
		/** queued | running | done | failed | interrupted */
		status: d.varchar({ length: 32 }).notNull().default("queued"),
		startedAt: d.timestamp({ withTimezone: true }),
		finishedAt: d.timestamp({ withTimezone: true }),
		pagesCrawled: d.integer().notNull().default(0),
		findingsCount: d.integer().notNull().default(0),
		/** Why the run aborted — the failure burst, a fetch error, or a crash. */
		error: d.text(),
		/**
		 * Whether the crawl saw the whole site it was given: no abort, no ceiling.
		 *
		 * Nullable, and null means *not recorded* rather than false. A run from
		 * before comparison existed, or one whose process died before it could
		 * write this, genuinely has no answer — and the honest handling of "we did
		 * not observe it" is silence, not a default. Do not "fix" this to
		 * `notNull().default(false)`: that would assert every historical run was
		 * truncated, and a comparison reading the assertion would report our own
		 * missing data as pages the client had fixed.
		 */
		crawlComplete: d.boolean(),
		/**
		 * Whether the page ceiling stopped the crawl.
		 *
		 * Recorded separately from `crawlComplete` because an abort is already
		 * recoverable from `status` and `error`, while a run that hit the ceiling
		 * looks like an ordinary success from every other column.
		 */
		reachedPageLimit: d.boolean(),
		/**
		 * The project configuration this crawl actually ran under.
		 *
		 * Snapshotted because `projects` is mutable and a run outlives the config
		 * that produced it. Narrowing `includePaths` between two runs changes what
		 * the crawl was even asked to look at, so without this the next run would
		 * report the pages it was told not to visit as problems that had been
		 * fixed.
		 */
		scope: d.jsonb().$type<{
			includePaths: string[];
			excludePaths: string[];
			locales: string[];
		}>(),
		/**
		 * The detection rules that could have fired on this run.
		 *
		 * Derived from `FINDING_TYPES` at the moment the run closed, never
		 * maintained by hand: a list somebody has to remember to update has exactly
		 * one failure mode, and its consequence is a trend claiming two
		 * incomparable runs are comparable.
		 *
		 * Nullable for the same reason `crawlComplete` is: null means *not
		 * recorded*, which is what every run from before this column genuinely is.
		 * Without it a finding type with no rows is ambiguous between "the rule
		 * found nothing" and "the rule did not exist yet", and only the first is a
		 * statement about the site.
		 */
		ruleSet: d.jsonb().$type<string[]>(),
		/**
		 * What the render pass covered, and whether it got through.
		 *
		 * Recorded because a sample is a claim about coverage: a reader shown four
		 * measured pages of a five-hundred-page site has to be told it was four,
		 * and a later trend over vitals has to be able to tell an unmeasured page
		 * from a fast one.
		 *
		 * Nullable, meaning *not recorded* — a run from before rendering existed,
		 * or one that died before it could write this. Do not default it: a zero
		 * would assert that every historical run rendered nothing, which is a
		 * different claim from having no answer.
		 */
		renderSummary: d.jsonb().$type<{
			/** Pages the sample chose. */
			chosen: number;
			/** Of those, how many produced a measurement. */
			measured: number;
			/** The cap in force, so the reader can be told what bounded it. */
			cap: number;
			/** False when the browser could not be used at all. */
			complete: boolean;
		}>(),
		/**
		 * What the visual pass covered, and what it was measured against.
		 *
		 * The same kind of claim `renderSummary` makes, for the same reason: a
		 * reader shown two changed pages has to be told how many were watched, and
		 * a run compared against a *different* baseline than its predecessor is
		 * not a run whose visual findings may be called new or resolved.
		 *
		 * `baselineRunId` is null when the project had no baseline when this run
		 * closed — a recorded fact, distinct from the column itself being null.
		 *
		 * Nullable, meaning *not recorded*: a run from before this shipped, or one
		 * that died before it could write this. Do not default it — a zero would
		 * assert that every historical run watched nothing, which is a different
		 * claim from having no answer.
		 */
		visualSummary: d.jsonb().$type<{
			/** The baseline this run was compared against; null when there was none. */
			baselineRunId: string | null;
			/** Pages the baseline put under watch. */
			watched: number;
			/** Of those, how many produced an image. */
			captured: number;
			/** Of those, how many could be compared against their baseline. */
			compared: number;
			/** Of those, how many differed. */
			differing: number;
			/** False when the browser could not be used at all. */
			complete: boolean;
		}>(),
		createdAt: d
			.timestamp({ withTimezone: true })
			.$defaultFn(() => /* @__PURE__ */ new Date())
			.notNull(),
	}),
	(t) => [
		index("run_tenant_id_idx").on(t.tenantId),
		index("run_project_id_idx").on(t.projectId),
	],
);

export const runsRelations = relations(runs, ({ one, many }) => ({
	tenant: one(tenants, { fields: [runs.tenantId], references: [tenants.id] }),
	project: one(projects, {
		fields: [runs.projectId],
		references: [projects.id],
	}),
	pages: many(pages),
	findings: many(findings),
}));

/**
 * One URL as this run observed it.
 *
 * Written as the crawl proceeds rather than batched at the end, so memory stays
 * flat across a 1,200-URL run and an aborted run still shows what it managed.
 */
export const pages = createTable(
	"page",
	(d) => ({
		id: d
			.varchar({ length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: d
			.varchar({ length: 255 })
			.notNull()
			.references(() => tenants.id),
		runId: d
			.varchar({ length: 255 })
			.notNull()
			.references(() => runs.id),
		url: d.varchar({ length: 2048 }).notNull(),
		/** Null when the request never produced a response — see `fetchError`. */
		httpStatus: d.integer(),
		/** Locale detected for this page, from hreflang or the URL. */
		locale: d.varchar({ length: 32 }),
		/**
		 * Which variant family this page belongs to. Derived from the hreflang
		 * graph rather than from any single URL, so the key is stable regardless
		 * of which page the crawl reached first.
		 */
		variantGroupKey: d.varchar({ length: 255 }),
		/** The hreflang targets this page declared, as locale → URL. */
		hreflangTargets: d.jsonb().$type<Record<string, string>>(),
		/**
		 * What this page's markup says about its images, in fixed-size form.
		 *
		 * Nullable, and null means *not observed* rather than "no images" — a page
		 * recorded before this column existed, or a response that was never HTML.
		 * The rules that read it must stay silent on null for the reason every
		 * other rule here does: an unobserved page is not a clean one.
		 *
		 * Counts are exact; the URL lists behind them are capped at capture, since
		 * this row is written once per page of a crawl that can reach two thousand.
		 */
		images: d.jsonb().$type<{
			total: number;
			undimensioned: number;
			legacy: number;
			undimensionedUrls: string[];
			legacyUrls: string[];
			urls: string[];
		}>(),
		fetchError: d.text(),
		createdAt: d
			.timestamp({ withTimezone: true })
			.$defaultFn(() => /* @__PURE__ */ new Date())
			.notNull(),
	}),
	(t) => [
		index("page_tenant_id_idx").on(t.tenantId),
		index("page_run_id_idx").on(t.runId),
		index("page_variant_group_idx").on(t.runId, t.variantGroupKey),
		/**
		 * One row per page per run, enforced rather than assumed.
		 *
		 * It was already true, but only because the crawler happened to dedupe on
		 * the URL it requested — and that incidental guarantee is exactly what broke
		 * when redirect aliases turned out to be several routes to one page. An
		 * invariant nothing enforces is one that returns silently.
		 */
		uniqueIndex("page_run_url_uq").on(t.runId, t.url),
	],
);

/**
 * What a browser saw on one page, for the few pages a run renders.
 *
 * A table rather than columns on `pages` because only a sample is measured:
 * absence of a row *is* "not measured", which is the distinction the whole
 * render half turns on. Nullable columns on every page would make an unmeasured
 * page and a page with nothing to report look the same, and only one of those is
 * a statement about the site.
 */
export const pageObservations = createTable(
	"page_observation",
	(d) => ({
		id: d
			.varchar({ length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: d
			.varchar({ length: 255 })
			.notNull()
			.references(() => tenants.id),
		runId: d
			.varchar({ length: 255 })
			.notNull()
			.references(() => runs.id),
		pageId: d
			.varchar({ length: 255 })
			.notNull()
			.references(() => pages.id),
		/**
		 * The browser's own numbers, read from its PerformanceObserver.
		 *
		 * Null per metric rather than zero: a page that never produced an LCP —
		 * one with no contentful paint at all — has no value, and zero would read
		 * as instantaneous.
		 */
		ttfbMs: d.integer(),
		lcpMs: d.integer(),
		/** Cumulative Layout Shift. Stored as text to keep its precision exact. */
		cls: d.varchar({ length: 32 }),
		/** Console errors from the site's own scripts. */
		firstPartyErrors: d.integer().notNull().default(0),
		/** Console errors from scripts the site loaded from elsewhere. */
		thirdPartyErrors: d.integer().notNull().default(0),
		/** A few of the messages, truncated at capture. */
		samples: d
			.jsonb()
			.$type<
				Array<{ message: string; source: string | null; firstParty: boolean }>
			>(),
		/** Why this page has no measurement; null when it has one. */
		renderError: d.text(),
		createdAt: d
			.timestamp({ withTimezone: true })
			.$defaultFn(() => /* @__PURE__ */ new Date())
			.notNull(),
	}),
	(t) => [
		index("observation_tenant_id_idx").on(t.tenantId),
		index("observation_run_id_idx").on(t.runId),
		/** One observation per page per run, enforced rather than assumed. */
		uniqueIndex("observation_run_page_uq").on(t.runId, t.pageId),
	],
);

/**
 * One rendering of one page, as a picture.
 *
 * A table rather than columns on `pages` for the reason `pageObservations` is
 * one: only a watched set is captured, so absence of a row *is* "not watched",
 * and that is a different fact from a page that was photographed and found
 * unchanged.
 *
 * The nullability of `image` is three-state and load-bearing:
 *
 *   image present                  — we have it
 *   image null, captureError set   — the capture failed, and why
 *   image null, expiredAt set      — we had it, and retention took it
 *
 * All three null is a bug rather than a state. Retention **updates** rather than
 * deletes for exactly this reason: a deleted row makes a snapshot that expired
 * indistinguishable from one that was never taken, and only one of those is a
 * statement about our own storage rather than about the site.
 */
export const pageSnapshots = createTable(
	"page_snapshot",
	(d) => ({
		id: d
			.varchar({ length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: d
			.varchar({ length: 255 })
			.notNull()
			.references(() => tenants.id),
		runId: d
			.varchar({ length: 255 })
			.notNull()
			.references(() => runs.id),
		pageId: d
			.varchar({ length: 255 })
			.notNull()
			.references(() => pages.id),
		/** The PNG. Null when the capture failed, or when retention expired it. */
		image: bytea(),
		/**
		 * Kept beside the bytes so a list view can report storage without ever
		 * selecting the bytes. Nulled with the image when retention expires it.
		 */
		byteSize: d.integer(),
		/** The PNG's own dimensions. Height varies with the page's own length. */
		imageWidth: d.integer(),
		imageHeight: d.integer(),
		/**
		 * What the browser was set to. Recorded because it is *our* number rather
		 * than the site's: a pair of snapshots taken at different viewports refuses
		 * comparison instead of reporting every page as changed.
		 */
		viewportWidth: d.integer().notNull(),
		viewportHeight: d.integer().notNull(),
		/**
		 * The masks in force when this picture was taken.
		 *
		 * Snapshotted for the reason `runs.scope` snapshots the project config: the
		 * project is mutable and this row outlives the configuration that produced
		 * it. Two images masked differently are not two views of the same thing.
		 */
		maskSelectors: d
			.text()
			.array()
			.notNull()
			.$defaultFn(() => []),
		/** Why this page has no picture; null when it has one. */
		captureError: d.text(),
		/**
		 * How this picture compared against the baseline, as the run concluded it.
		 *
		 * Recorded rather than derived, and recorded even when nothing changed —
		 * because "compared, and identical" and "never compared" are different
		 * facts and the findings table cannot tell them apart. A finding exists
		 * only for a page that *differed*, so a view reading findings alone would
		 * report every unchanged page as unexamined.
		 *
		 * Null means this page was not compared at all: no baseline, or the run
		 * predates the visual pass. `{comparable: false}` means it was reached and
		 * refused, and the reason says which of our own changes caused that.
		 */
		comparison: d.jsonb().$type<
			| {
					comparable: true;
					changedPixels: number;
					comparedPixels: number;
					heightDelta: number;
					/**
					 * Where the differences are, in the picture's own pixels, measured
					 * from its top-left. Stored rather than recomputed for the reason
					 * the counts beside them are: a reader looking at an old run must
					 * see where it concluded the page changed, not where today's code
					 * would put the boxes. Optional because runs recorded before the
					 * boxes shipped have none, and an absent list is not an empty one.
					 */
					regions?: {
						x: number;
						y: number;
						width: number;
						height: number;
					}[];
					/** True when there were more regions than the cap reports. */
					regionsCapped?: boolean;
			  }
			| { comparable: false; reason: string }
		>(),
		/** When retention dropped the bytes; null while they are still held. */
		expiredAt: d.timestamp({ withTimezone: true }),
		createdAt: d
			.timestamp({ withTimezone: true })
			.$defaultFn(() => /* @__PURE__ */ new Date())
			.notNull(),
	}),
	(t) => [
		index("snapshot_tenant_id_idx").on(t.tenantId),
		index("snapshot_run_id_idx").on(t.runId),
		/** One snapshot per page per run, enforced rather than assumed. */
		uniqueIndex("snapshot_run_page_uq").on(t.runId, t.pageId),
	],
);

export const pageSnapshotsRelations = relations(pageSnapshots, ({ one }) => ({
	tenant: one(tenants, {
		fields: [pageSnapshots.tenantId],
		references: [tenants.id],
	}),
	run: one(runs, { fields: [pageSnapshots.runId], references: [runs.id] }),
	page: one(pages, { fields: [pageSnapshots.pageId], references: [pages.id] }),
}));

export const pageObservationsRelations = relations(
	pageObservations,
	({ one }) => ({
		tenant: one(tenants, {
			fields: [pageObservations.tenantId],
			references: [tenants.id],
		}),
		run: one(runs, {
			fields: [pageObservations.runId],
			references: [runs.id],
		}),
		page: one(pages, {
			fields: [pageObservations.pageId],
			references: [pages.id],
		}),
	}),
);

export const pagesRelations = relations(pages, ({ one }) => ({
	tenant: one(tenants, { fields: [pages.tenantId], references: [tenants.id] }),
	run: one(runs, { fields: [pages.runId], references: [runs.id] }),
}));

/**
 * Something the product concluded, as opposed to something it merely observed.
 *
 * First-class rows rather than derived at read time: later slices compare runs
 * against each other, and a comparison needs what was concluded *then*, not what
 * today's rules would conclude about yesterday's data.
 */
export const findings = createTable(
	"finding",
	(d) => ({
		id: d
			.varchar({ length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: d
			.varchar({ length: 255 })
			.notNull()
			.references(() => tenants.id),
		runId: d
			.varchar({ length: 255 })
			.notNull()
			.references(() => runs.id),
		/** Discriminator, e.g. `missing_locale`, `hreflang_target_failed`. */
		type: d.varchar({ length: 64 }).notNull(),
		/** Null for findings about a group rather than a single page. */
		pageId: d.varchar({ length: 255 }).references(() => pages.id),
		/**
		 * The evidence: which group, which locale, what was expected, what was
		 * observed. A finding must be actionable without re-running the crawl.
		 */
		detail: d.jsonb().$type<Record<string, unknown>>().notNull(),
		createdAt: d
			.timestamp({ withTimezone: true })
			.$defaultFn(() => /* @__PURE__ */ new Date())
			.notNull(),
	}),
	(t) => [
		index("finding_tenant_id_idx").on(t.tenantId),
		index("finding_run_id_idx").on(t.runId),
		index("finding_type_idx").on(t.runId, t.type),
	],
);

export const findingsRelations = relations(findings, ({ one }) => ({
	tenant: one(tenants, {
		fields: [findings.tenantId],
		references: [tenants.id],
	}),
	run: one(runs, { fields: [findings.runId], references: [runs.id] }),
	page: one(pages, { fields: [findings.pageId], references: [pages.id] }),
}));

export const tenantsRelations = relations(tenants, ({ many }) => ({
	users: many(users),
	projects: many(projects),
}));

export const verificationTokens = createTable(
	"verification_token",
	(d) => ({
		identifier: d.varchar({ length: 255 }).notNull(),
		token: d.varchar({ length: 255 }).notNull(),
		expires: d.timestamp({ mode: "date", withTimezone: true }).notNull(),
	}),
	(t) => [primaryKey({ columns: [t.identifier, t.token] })],
);
