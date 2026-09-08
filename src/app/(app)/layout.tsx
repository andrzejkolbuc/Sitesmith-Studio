import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { auth, signOut } from "~/server/auth";
import { db } from "~/server/db";
import { users } from "~/server/db/schema";

/**
 * Guard for every gated route.
 *
 * **Put new signed-in pages inside this route group.** The checks live in the
 * layout rather than in each page so that a new page inherits them structurally
 * instead of having to remember them — the same reasoning behind building domain
 * routers on `tenantProcedure` rather than filtering by hand.
 *
 * Two conditions are enforced here, and they fail differently on purpose:
 *
 * 1. **No session** — redirected to sign-in. This product is invite-only and has
 *    no public surface whose existence is worth concealing, and a redirect is the
 *    least confusing outcome for a client contact following a stale link.
 *    (Resolves the open question the requirements left about gated-route
 *    behaviour.)
 *
 * 2. **Session but no tenant** — shown an explanation, not a redirect. Bouncing a
 *    successfully authenticated user back to sign-in would invite them to try the
 *    same credentials again forever. `users.tenantId` is nullable so the Auth.js
 *    adapter can create users, which means this state is reachable by design
 *    rather than by accident, and it needs a real answer.
 *
 * Not implemented as middleware: the auth configuration pulls in the Postgres
 * driver through the database adapter, which does not run in the edge runtime
 * Next uses for middleware by default.
 */
export default async function AppLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const session = await auth();
	if (!session?.user) redirect("/signin");

	/**
	 * Deliberately re-read rather than trusting the session. The tenant is
	 * resolved per request everywhere else for the same reason: sessions are JWTs
	 * and cannot be revoked, so a tenant carried inside one would stay stale until
	 * the token expired.
	 */
	const account = await db.query.users.findFirst({
		columns: { tenantId: true, role: true },
		where: eq(users.id, session.user.id),
	});

	if (!account?.tenantId) {
		return <NoTenantNotice email={session.user.email ?? undefined} />;
	}

	return <>{children}</>;
}

function NoTenantNotice({ email }: { email?: string }) {
	return (
		<main className="flex min-h-screen items-center justify-center px-6">
			<div className="w-full max-w-md text-center">
				<h1 className="font-display font-semibold text-3xl text-ink tracking-tight">
					This account has no workspace
				</h1>
				<p className="mt-3 max-w-prose text-ink-soft text-sm leading-relaxed">
					{email ? `${email} is signed in, but ` : "You are signed in, but "}
					the account is not attached to a workspace yet, so there is nothing to
					show. Accounts are attached when they are invited.
				</p>

				<form
					action={async () => {
						"use server";
						await signOut({ redirectTo: "/" });
					}}
				>
					<button
						className="mt-8 rounded-sm bg-ink px-5 py-2.5 font-medium text-paper text-sm transition-opacity hover:opacity-85"
						type="submit"
					>
						Sign out
					</button>
				</form>
			</div>
		</main>
	);
}
