import Link from "next/link";
import { notFound } from "next/navigation";

import { currentAccount } from "~/server/auth/account";
import { isOwner } from "~/server/auth/roles";
import { TeamPanel } from "./team-panel";

/**
 * Who may sign in, and what they reach.
 *
 * Inside the `(app)` group, so the session and tenant checks are inherited from
 * the layout rather than repeated here — and so this route is automatically
 * enrolled in the partial-account journey, which walks the group on the
 * filesystem and requires every page in it to explain itself to an account with
 * no workspace instead of returning a 5xx.
 *
 * A non-Owner gets `notFound()`, not a "you cannot do this" page. That is the
 * same answer the product gives everywhere a caller may not reach something,
 * and the reasoning carries: a client viewer should not learn that the agency
 * has a people-management screen at all.
 *
 * The gate here is presentation. Every procedure the panel calls is
 * `ownerProcedure` and refuses on its own.
 */
export default async function TeamPage() {
	const account = await currentAccount();
	if (!isOwner(account?.role)) notFound();

	return (
		<main className="min-h-screen">
			<div className="mx-auto max-w-4xl px-6 py-14">
				<Link
					className="font-mono text-ink-faint text-xs underline-offset-4 hover:text-ink hover:underline"
					href="/projects"
				>
					← Projects
				</Link>

				<header className="mt-8 border-rule border-b pb-6">
					<h1 className="font-display font-semibold text-4xl text-ink tracking-tight">
						People
					</h1>
					<p className="mt-2 max-w-prose text-ink-soft text-sm leading-relaxed">
						Accounts are created by invitation. You send the link yourself — it
						works once and expires in seven days.
					</p>
				</header>

				<TeamPanel />
			</div>
		</main>
	);
}
