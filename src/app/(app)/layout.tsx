import { redirect } from "next/navigation";

import { auth } from "~/server/auth";

/**
 * Guard for every gated route.
 *
 * **Put new signed-in pages inside this route group.** The check lives in the
 * layout rather than in each page so that a new page inherits it structurally
 * instead of having to remember it — the same reasoning behind building domain
 * routers on `tenantProcedure` rather than filtering by hand.
 *
 * An unauthenticated visitor is redirected to sign-in rather than shown a 403 or
 * a not-found. This product is invite-only and has no public surface whose
 * existence is worth concealing, and a redirect is the least confusing outcome
 * for a client contact following a stale link. (Resolves the open question the
 * requirements left about gated-route behaviour.)
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

	return <>{children}</>;
}
