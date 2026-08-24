import { relations } from "drizzle-orm";
import { index, pgTableCreator, primaryKey } from "drizzle-orm/pg-core";
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
		createdAt: d
			.timestamp({ withTimezone: true })
			.$defaultFn(() => /* @__PURE__ */ new Date())
			.notNull(),
		updatedAt: d.timestamp({ withTimezone: true }).$onUpdate(() => new Date()),
	}),
	(t) => [index("project_tenant_id_idx").on(t.tenantId)],
);

export const projectsRelations = relations(projects, ({ one }) => ({
	tenant: one(tenants, {
		fields: [projects.tenantId],
		references: [tenants.id],
	}),
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
