import { relations } from "drizzle-orm";
import {
	index,
	pgTableCreator,
	primaryKey,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AdapterAccount } from "next-auth/adapters";

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
