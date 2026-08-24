import Link from "next/link";

import { auth } from "~/server/auth";

export default async function Home() {
	const session = await auth();

	return (
		<main className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 text-neutral-100">
			<div className="container flex max-w-2xl flex-col items-center gap-8 px-4 py-16">
				<div className="flex flex-col items-center gap-3 text-center">
					<h1 className="font-bold text-4xl tracking-tight sm:text-5xl">
						Sitesmith Studio
					</h1>
					<p className="text-lg text-neutral-400">
						Checks multilingual client sites before they go live.
					</p>
				</div>

				<Link
					className="rounded-lg bg-neutral-100 px-6 py-3 font-medium text-neutral-950 transition hover:bg-white"
					href={session?.user ? "/projects" : "/signin"}
				>
					{session?.user ? "Go to your projects" : "Sign in"}
				</Link>
			</div>
		</main>
	);
}
