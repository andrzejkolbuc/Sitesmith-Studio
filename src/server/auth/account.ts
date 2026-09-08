import "server-only";

import { eq } from "drizzle-orm";

import { auth } from "~/server/auth";
import type { UserRole } from "~/server/auth/roles";
import { db } from "~/server/db";
import { users } from "~/server/db/schema";

/**
 * Who is asking, for pages that need to know in order to render.
 *
 * **This is for presentation, never for enforcement.** Hiding a button that a
 * role cannot use is a courtesy; the refusal that matters already happened in
 * `ownerProcedure` and `assertProjectAccess`, server-side, on every call. A page
 * that used this to decide whether to *allow* something would be adding a second
 * authority that could disagree with the first.
 *
 * Read per request rather than carried on the session, for the reason the whole
 * codebase reads authorization per request: sessions are unrevocable JWTs, so a
 * role demoted an hour ago would still be showing its old controls.
 */
export async function currentAccount(): Promise<{
	userId: string;
	tenantId: string;
	role: UserRole;
} | null> {
	const session = await auth();
	const userId = session?.user?.id;
	if (!userId) return null;

	const account = await db.query.users.findFirst({
		columns: { tenantId: true, role: true },
		where: eq(users.id, userId),
	});
	if (!account?.tenantId) return null;

	return { userId, tenantId: account.tenantId, role: account.role };
}
