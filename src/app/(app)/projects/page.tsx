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
		<main className="min-h-screen">
			<div className="mx-auto max-w-4xl px-6 py-14">
				<header className="flex flex-wrap items-end justify-between gap-6 border-rule border-b pb-6">
					<div>
						<h1 className="font-display font-semibold text-4xl text-ink tracking-tight">
							Projects
						</h1>
						<p className="mt-2 font-mono text-ink-faint text-xs">
							Signed in as {session?.user?.email}
						</p>
					</div>

					<div className="flex items-center gap-5">
						<Link
							className="rounded-sm bg-ink px-4 py-2 font-medium text-paper text-sm transition-opacity hover:opacity-85"
							href="/projects/new"
						>
							New project
						</Link>

						<form
							action={async () => {
								"use server";
								await signOut({ redirectTo: "/" });
							}}
						>
							<button
								className="text-ink-faint text-sm underline-offset-4 hover:text-ink hover:underline"
								type="submit"
							>
								Sign out
							</button>
						</form>
					</div>
				</header>

				{projects.length === 0 ? (
					/**
					 * An empty screen is an invitation to act, so it says what the first
					 * project will get you rather than reporting that a list is empty.
					 */
					<div className="mt-14 max-w-prose">
						<p className="font-display font-semibold text-2xl text-ink">
							No projects yet
						</p>
						<p className="mt-3 text-ink-soft text-sm leading-relaxed">
							Add a client site and run a check against it to see which pages
							are missing a language variant.
						</p>
						<Link
							className="mt-6 inline-block rounded-sm bg-ink px-4 py-2 font-medium text-paper text-sm transition-opacity hover:opacity-85"
							href="/projects/new"
						>
							Create your first project
						</Link>
					</div>
				) : (
					<ul className="mt-2">
						{projects.map((project) => (
							<li className="border-rule-soft border-b" key={project.id}>
								<Link
									className="-mx-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 rounded-sm px-3 py-5 transition-colors hover:bg-sheet"
									href={`/projects/${project.id}`}
								>
									<span className="min-w-0">
										<span className="block font-display font-semibold text-ink text-lg">
											{project.name}
										</span>
										<span className="mt-0.5 block break-all font-mono text-ink-faint text-xs">
											{project.startUrl}
										</span>
									</span>

									{project.locales.length > 0 ? (
										<span className="flex flex-wrap gap-1.5">
											{project.locales.map((locale) => (
												<code
													className="rounded-sm border border-rule bg-sheet px-1.5 py-0.5 font-mono text-ink-soft text-xs"
													key={locale}
												>
													{locale}
												</code>
											))}
										</span>
									) : (
										<span className="text-ink-faint text-xs">
											no expected locales
										</span>
									)}
								</Link>
							</li>
						))}
					</ul>
				)}
			</div>
		</main>
	);
}
