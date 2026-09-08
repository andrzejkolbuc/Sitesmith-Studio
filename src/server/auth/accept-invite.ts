import { and, eq, gt } from "drizzle-orm";

import type { db as database } from "~/server/db";
import { invites, projectAssignments, users } from "~/server/db/schema";
import { hashInviteToken } from "./invite";
import { hashPassword } from "./password";

/**
 * Redeeming an invite: the account, the grant, and the spend, as one event.
 *
 * Lives here rather than inside the page's server action so it can be asserted
 * directly. The properties that matter — that a link works exactly once, that a
 * revoked or expired one works never, that the account comes out with the role
 * and project the invite named — are all properties of this function, and a
 * test that had to drive a browser to reach them would be testing the form.
 *
 * Every refusal returns `null`. Expired, already spent, revoked, never existed,
 * mistyped: the caller cannot tell them apart, and neither can whoever is
 * holding the link. That matches how sign-in answers, and for the same reason —
 * distinguishing them tells an uninvited visitor which links used to be real.
 */

/**
 * The minimum for a password being set for the first time.
 *
 * Sign-in validates `min(1)` because it must accept whatever is already stored;
 * this is the only place a floor can be imposed at all.
 */
export const INVITE_PASSWORD_MIN = 12;

type Database = typeof database;

export async function acceptInvite(
	db: Database,
	{ token, password }: { token: string; password: string },
): Promise<{ email: string } | null> {
	if (password.length < INVITE_PASSWORD_MIN) return null;

	const invite = await db.query.invites.findFirst({
		columns: {
			id: true,
			email: true,
			role: true,
			projectId: true,
			tenantId: true,
		},
		where: and(
			eq(invites.tokenHash, hashInviteToken(token)),
			gt(invites.expiresAt, new Date()),
		),
	});
	if (!invite) return null;

	/**
	 * Hashed before the transaction opens. scrypt is deliberately slow, and
	 * holding a transaction open across it would keep a database connection
	 * parked for the duration of a CPU-bound step that needs none.
	 */
	const passwordHash = await hashPassword(password);

	/**
	 * One transaction, and the reason is the ordering rather than the grouping.
	 *
	 * A crash between creating the account and deleting the invite would leave a
	 * link that had already been spent still reading as pending — replayable
	 * against an address that now has an account. Rolling the writes together
	 * makes "used" and "gone" the same event.
	 *
	 * The delete is conditioned on the row still being there, so two requests
	 * racing the same link cannot both succeed: the second finds nothing to
	 * delete and rolls back the account it had just created.
	 */
	try {
		await db.transaction(async (tx) => {
			const [created] = await tx
				.insert(users)
				.values({
					email: invite.email,
					passwordHash,
					tenantId: invite.tenantId,
					role: invite.role,
				})
				.returning({ id: users.id });

			if (!created) throw new Error("user insert returned nothing");

			if (invite.projectId) {
				await tx.insert(projectAssignments).values({
					tenantId: invite.tenantId,
					userId: created.id,
					projectId: invite.projectId,
				});
			}

			const [spent] = await tx
				.delete(invites)
				.where(eq(invites.id, invite.id))
				.returning({ id: invites.id });

			if (!spent) throw new Error("invite was already spent");
		});
	} catch {
		/**
		 * A duplicate address, a lost race, or a project deleted between issue and
		 * acceptance all land here. None of them is something the person holding
		 * the link can act on differently, so they get the one answer.
		 */
		return null;
	}

	return { email: invite.email };
}
