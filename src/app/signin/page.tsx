import { redirect } from "next/navigation";
import { AuthError } from "next-auth";

import { auth, signIn } from "~/server/auth";

export default async function SignInPage({
	searchParams,
}: {
	searchParams: Promise<{ error?: string }>;
}) {
	const session = await auth();
	if (session?.user) redirect("/projects");

	const { error } = await searchParams;

	async function authenticate(formData: FormData) {
		"use server";

		try {
			await signIn("credentials", {
				email: formData.get("email"),
				password: formData.get("password"),
				redirectTo: "/projects",
			});
		} catch (caught) {
			/**
			 * A successful sign-in throws a redirect, which must propagate — only
			 * genuine auth failures are converted into the error banner.
			 */
			if (caught instanceof AuthError) redirect("/signin?error=1");
			throw caught;
		}
	}

	return (
		<main className="flex min-h-screen items-center justify-center px-6">
			<div className="w-full max-w-sm">
				<h1 className="font-display font-semibold text-3xl text-ink tracking-tight">
					Sign in
				</h1>
				<p className="mt-2 max-w-prose text-ink-soft text-sm leading-relaxed">
					Sitesmith Studio
				</p>

				{error ? (
					/**
					 * Deliberately one message for every failure. The authorize callback
					 * makes an unknown address and a wrong password indistinguishable so
					 * that sign-in cannot be used to discover which addresses hold
					 * accounts; saying "no such user" here would give that back.
					 */
					<p
						className="mt-6 border-mark border-l-2 bg-mark-soft px-4 py-3 text-mark text-sm"
						role="alert"
					>
						Those details did not match an account.
					</p>
				) : null}

				<form action={authenticate} className="mt-6 flex flex-col gap-4">
					<label className="flex flex-col gap-2 text-sm">
						<span className="font-mono text-ink-faint text-xs uppercase tracking-wider">
							Email
						</span>
						<input
							autoComplete="email"
							className="rounded-sm border border-rule bg-sheet px-3 py-2.5 text-ink text-sm outline-none placeholder:text-ink-faint focus:border-ink"
							name="email"
							required
							type="email"
						/>
					</label>

					<label className="flex flex-col gap-2 text-sm">
						<span className="font-mono text-ink-faint text-xs uppercase tracking-wider">
							Password
						</span>
						<input
							autoComplete="current-password"
							className="rounded-sm border border-rule bg-sheet px-3 py-2.5 text-ink text-sm outline-none placeholder:text-ink-faint focus:border-ink"
							name="password"
							required
							type="password"
						/>
					</label>

					<button
						className="mt-2 w-full rounded-sm bg-ink px-4 py-2.5 font-medium text-paper text-sm transition-opacity hover:opacity-85"
						type="submit"
					>
						Sign in
					</button>
				</form>

				<p className="mt-10 max-w-prose border-rule border-t pt-5 text-ink-faint text-xs leading-relaxed">
					Accounts are created by invitation. There is no sign-up.
				</p>
			</div>
		</main>
	);
}
