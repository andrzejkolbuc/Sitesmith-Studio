import { and, eq, gt } from "drizzle-orm";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";

import { auth, signIn } from "~/server/auth";
import { acceptInvite, INVITE_PASSWORD_MIN } from "~/server/auth/accept-invite";
import { hashInviteToken } from "~/server/auth/invite";
import { db } from "~/server/db";
import { invites } from "~/server/db/schema";

/**
 * Where an invited account comes into being.
 *
 * This page sits **outside** `src/app/(app)/` on purpose: the person opening it
 * has no session, so it can inherit nothing from the route-group layout. That
 * puts it in the same position as the snapshot route — no middleware, no
 * inherited guard — and it establishes its own authority the same way, from the
 * token in the URL and nothing else.
 *
 * The redemption itself lives in `~/server/auth/accept-invite` so it can be
 * asserted without a browser. What is left here is the form and the two
 * redirects.
 *
 * One generic failure for every reason an invite will not open: expired,
 * already used, revoked, never existed, or mistyped. The sign-in page makes the
 * same choice for the same reason — a page that distinguishes them tells an
 * uninvited visitor which links used to be real.
 */

export default async function AcceptInvitePage({
	params,
	searchParams,
}: {
	params: Promise<{ token: string }>;
	searchParams: Promise<{ error?: string }>;
}) {
	const session = await auth();
	if (session?.user) redirect("/projects");

	const { token } = await params;
	const { error } = await searchParams;

	/**
	 * Read only to decide whether to render the form, and for the address to show
	 * on it. Whether the invite is still good is decided again inside
	 * `acceptInvite` when the form is submitted — this lookup is a courtesy to
	 * the reader, not the gate.
	 */
	const invite = await db.query.invites.findFirst({
		columns: { email: true },
		where: and(
			eq(invites.tokenHash, hashInviteToken(token)),
			gt(invites.expiresAt, new Date()),
		),
	});

	async function accept(formData: FormData) {
		"use server";

		const accepted = await acceptInvite(db, {
			token,
			password: String(formData.get("password") ?? ""),
		});

		if (!accepted) redirect(`/invite/${token}?error=1`);

		try {
			await signIn("credentials", {
				email: accepted.email,
				password: String(formData.get("password") ?? ""),
				redirectTo: "/projects",
			});
		} catch (caught) {
			/**
			 * A successful sign-in throws a redirect, which must propagate. The
			 * account exists either way at this point, so a genuine auth failure
			 * sends them to sign in rather than back to a spent invite.
			 */
			if (caught instanceof AuthError) redirect("/signin");
			throw caught;
		}
	}

	if (!invite) {
		return (
			<main className="flex min-h-screen items-center justify-center px-6">
				<div className="w-full max-w-sm">
					<h1 className="font-display font-semibold text-3xl text-ink tracking-tight">
						Invite not valid
					</h1>
					<p className="mt-3 max-w-prose text-ink-soft text-sm leading-relaxed">
						This invite link is not valid. It may have expired, or already been
						used. Ask whoever invited you to send a new one.
					</p>
				</div>
			</main>
		);
	}

	return (
		<main className="flex min-h-screen items-center justify-center px-6">
			<div className="w-full max-w-sm">
				<h1 className="font-display font-semibold text-3xl text-ink tracking-tight">
					Set your password
				</h1>
				<p className="mt-2 max-w-prose text-ink-soft text-sm leading-relaxed">
					You were invited as <span className="font-mono">{invite.email}</span>.
				</p>

				{error ? (
					<p
						className="mt-6 border-mark border-l-2 bg-mark-soft px-4 py-3 text-mark text-sm"
						role="alert"
					>
						That password could not be used. It must be at least{" "}
						{INVITE_PASSWORD_MIN} characters.
					</p>
				) : null}

				<form action={accept} className="mt-6 flex flex-col gap-4">
					<label className="flex flex-col gap-2 text-sm">
						<span className="font-mono text-ink-faint text-xs uppercase tracking-wider">
							Password
						</span>
						<input
							autoComplete="new-password"
							className="rounded-sm border border-rule bg-sheet px-3 py-2.5 text-ink text-sm outline-none placeholder:text-ink-faint focus:border-ink"
							minLength={INVITE_PASSWORD_MIN}
							name="password"
							required
							type="password"
						/>
					</label>

					<button
						className="mt-2 w-full rounded-sm bg-ink px-4 py-2.5 font-medium text-paper text-sm transition-opacity hover:opacity-85"
						type="submit"
					>
						Set password and sign in
					</button>
				</form>

				<p className="mt-10 max-w-prose border-rule border-t pt-5 text-ink-faint text-xs leading-relaxed">
					At least {INVITE_PASSWORD_MIN} characters. This link works once.
				</p>
			</div>
		</main>
	);
}
