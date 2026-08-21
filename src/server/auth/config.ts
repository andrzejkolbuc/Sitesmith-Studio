import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import type { DefaultSession, NextAuthConfig } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { z } from "zod";

import { db } from "~/server/db";
import {
	accounts,
	sessions,
	users,
	verificationTokens,
} from "~/server/db/schema";
import { burnPasswordTime, verifyPassword } from "./password";

/**
 * Module augmentation for `next-auth` types. Allows us to add custom properties to the `session`
 * object and keep type safety.
 *
 * @see https://next-auth.js.org/getting-started/typescript#module-augmentation
 */
declare module "next-auth" {
	interface Session extends DefaultSession {
		user: {
			id: string;
			// ...other properties
			// role: UserRole;
		} & DefaultSession["user"];
	}
}

const credentialsSchema = z.object({
	email: z.string().email(),
	password: z.string().min(1),
});

/**
 * Options for NextAuth.js used to configure adapters, providers, callbacks, etc.
 *
 * @see https://next-auth.js.org/configuration/options
 */
export const authConfig = {
	providers: [
		CredentialsProvider({
			name: "Email and password",
			credentials: {
				email: { label: "Email", type: "email" },
				password: { label: "Password", type: "password" },
			},
			/**
			 * Returning `null` is the only failure signal Auth.js accepts here, and every
			 * rejection path below returns exactly that — an unknown address, an account
			 * with no password set, and a wrong password are indistinguishable to the
			 * caller. Telling them apart would confirm which addresses hold accounts.
			 */
			authorize: async (raw) => {
				const parsed = credentialsSchema.safeParse(raw);
				if (!parsed.success) return null;

				const email = parsed.data.email.trim().toLowerCase();

				const user = await db.query.users.findFirst({
					where: eq(users.email, email),
				});

				if (!user?.passwordHash) {
					// Spend comparable time so a missing account is not measurably faster.
					await burnPasswordTime(parsed.data.password);
					return null;
				}

				const ok = await verifyPassword(
					parsed.data.password,
					user.passwordHash,
				);
				if (!ok) return null;

				return {
					id: user.id,
					email: user.email,
					name: user.name,
					image: user.image,
				};
			},
		}),
	],
	adapter: DrizzleAdapter(db, {
		usersTable: users,
		accountsTable: accounts,
		sessionsTable: sessions,
		verificationTokensTable: verificationTokens,
	}),
	/**
	 * Credentials sign-in requires JWT sessions — Auth.js will not issue a database
	 * session for it. Consequence worth knowing: sessions can no longer be revoked
	 * server-side by deleting a row. A token stays valid until it expires, so
	 * removing someone's access is not immediate. If instant revocation becomes a
	 * requirement, the usual answer is a token version on the user row that the
	 * `jwt` callback checks.
	 */
	session: { strategy: "jwt" },
	callbacks: {
		jwt: ({ token, user }) => {
			if (user) token.id = user.id;
			return token;
		},
		session: ({ session, token }) => ({
			...session,
			user: {
				...session.user,
				id: token.id as string,
			},
		}),
	},
} satisfies NextAuthConfig;
