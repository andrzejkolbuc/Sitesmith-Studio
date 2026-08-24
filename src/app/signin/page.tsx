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
		<main className="flex min-h-screen items-center justify-center bg-neutral-950 px-4 text-neutral-100">
			<div className="w-full max-w-sm">
				<h1 className="font-bold text-2xl tracking-tight">Sign in</h1>
				<p className="mt-1 text-neutral-400 text-sm">Sitesmith Studio</p>

				{error ? (
					/**
					 * Deliberately one message for every failure. The authorize callback
					 * makes an unknown address and a wrong password indistinguishable so
					 * that sign-in cannot be used to discover which addresses hold
					 * accounts; saying "no such user" here would give that back.
					 */
					<p
						className="mt-6 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-red-200 text-sm"
						role="alert"
					>
						Those details did not match an account.
					</p>
				) : null}

				<form action={authenticate} className="mt-6 flex flex-col gap-4">
					<label className="flex flex-col gap-1.5 text-sm">
						<span className="text-neutral-300">Email</span>
						<input
							autoComplete="email"
							className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-neutral-100 outline-none focus:border-neutral-600"
							name="email"
							required
							type="email"
						/>
					</label>

					<label className="flex flex-col gap-1.5 text-sm">
						<span className="text-neutral-300">Password</span>
						<input
							autoComplete="current-password"
							className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-neutral-100 outline-none focus:border-neutral-600"
							name="password"
							required
							type="password"
						/>
					</label>

					<button
						className="mt-2 rounded-md bg-neutral-100 px-4 py-2 font-medium text-neutral-950 transition hover:bg-white"
						type="submit"
					>
						Sign in
					</button>
				</form>

				<p className="mt-6 text-neutral-500 text-xs">
					Accounts are created by invitation. There is no sign-up.
				</p>
			</div>
		</main>
	);
}
