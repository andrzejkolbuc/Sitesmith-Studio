import Link from "next/link";
import { notFound } from "next/navigation";

import { api } from "~/trpc/server";
import { RunPanel } from "./run-panel";

/**
 * A project and what its last check found.
 *
 * The page does not filter by tenant. `project.byId` runs on `tenantProcedure`
 * and re-establishes ownership on every read — filtering again here would imply
 * the API could be trusted to return too much.
 */
export default async function ProjectPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;

	let project: Awaited<ReturnType<typeof api.project.byId>>;
	try {
		project = await api.project.byId({ projectId: id });
	} catch {
		// A project belonging to another tenant is indistinguishable from one that
		// does not exist — which is the intended answer, not a limitation.
		notFound();
	}

	return (
		<main className="min-h-screen bg-neutral-950 text-neutral-100">
			<div className="container mx-auto max-w-3xl px-4 py-12">
				<Link
					className="text-neutral-400 text-sm underline-offset-4 hover:text-neutral-100 hover:underline"
					href="/projects"
				>
					← Projects
				</Link>

				<header className="mt-6">
					<h1 className="font-bold text-2xl tracking-tight">{project.name}</h1>
					<a
						className="mt-1 inline-block break-all text-neutral-400 text-sm underline-offset-4 hover:text-neutral-100 hover:underline"
						href={project.startUrl}
						rel="noreferrer"
						target="_blank"
					>
						{project.startUrl}
					</a>
				</header>

				<dl className="mt-6 flex flex-wrap gap-x-8 gap-y-3 text-sm">
					<div>
						<dt className="text-neutral-500 text-xs">Expected locales</dt>
						<dd className="mt-0.5 text-neutral-200">
							{project.locales.length > 0 ? (
								project.locales.join(", ")
							) : (
								<span className="text-neutral-500">
									none — nothing can be reported missing
								</span>
							)}
						</dd>
					</div>
					<div>
						<dt className="text-neutral-500 text-xs">Request pacing</dt>
						<dd className="mt-0.5 text-neutral-200">
							{project.maxConcurrency} at a time, {project.requestDelayMs}ms
							apart
						</dd>
					</div>
					{project.excludePaths.length > 0 ? (
						<div>
							<dt className="text-neutral-500 text-xs">Excluded</dt>
							<dd className="mt-0.5 text-neutral-200">
								{project.excludePaths.join(", ")}
							</dd>
						</div>
					) : null}
				</dl>

				<RunPanel projectId={project.id} />
			</div>
		</main>
	);
}
