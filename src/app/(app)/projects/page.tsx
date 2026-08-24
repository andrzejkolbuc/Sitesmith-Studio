import Link from "next/link";

import { auth, signOut } from "~/server/auth";
import { api } from "~/trpc/server";

export default async function ProjectsPage() {
	/**
	 * Scoping is not applied here. `project.list` runs on `tenantProcedure`, which
	 * resolves the caller's tenant and filters server-side — a page that filtered
	 * again would imply the API could be trusted to return too much.
	 */
	const projects = await api.project.list();
	const session = await auth();

	return (
		<main className="min-h-screen bg-neutral-950 text-neutral-100">
			<div className="container mx-auto max-w-3xl px-4 py-12">
				<header className="flex items-baseline justify-between gap-4">
					<div>
						<h1 className="font-bold text-2xl tracking-tight">Projects</h1>
						<p className="mt-1 text-neutral-400 text-sm">
							Signed in as {session?.user?.email}
						</p>
					</div>

					<form
						action={async () => {
							"use server";
							await signOut({ redirectTo: "/" });
						}}
					>
						<button
							className="text-neutral-400 text-sm underline-offset-4 transition hover:text-neutral-100 hover:underline"
							type="submit"
						>
							Sign out
						</button>
					</form>
				</header>

				{projects.length === 0 ? (
					<div className="mt-10 rounded-lg border border-neutral-800 border-dashed p-8 text-center">
						<p className="font-medium text-neutral-300">No projects yet</p>
						<p className="mt-2 text-neutral-500 text-sm">
							Creating and configuring projects arrives with the crawling work.
							Until then, the seed command is what puts rows here.
						</p>
						<Link
							className="mt-4 inline-block text-neutral-400 text-sm underline-offset-4 hover:text-neutral-100 hover:underline"
							href="/"
						>
							Back to home
						</Link>
					</div>
				) : (
					<ul className="mt-8 divide-y divide-neutral-800 border-neutral-800 border-y">
						{projects.map((project) => (
							<li className="py-4" key={project.id}>
								<span className="font-medium">{project.name}</span>
							</li>
						))}
					</ul>
				)}
			</div>
		</main>
	);
}
