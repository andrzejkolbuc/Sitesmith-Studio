import Link from "next/link";
import { notFound } from "next/navigation";

import { currentAccount } from "~/server/auth/account";
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

	/**
	 * Presentation only. The panel hides controls this role cannot use; every one
	 * of them is refused server-side regardless.
	 *
	 * The layout has already established there is a session and a tenant, so a
	 * null here would mean the account vanished mid-request.
	 */
	const account = await currentAccount();
	if (!account) notFound();

	let project: Awaited<ReturnType<typeof api.project.byId>>;
	try {
		project = await api.project.byId({ projectId: id });
	} catch {
		// A project belonging to another tenant is indistinguishable from one that
		// does not exist — which is the intended answer, not a limitation.
		notFound();
	}

	return (
		<main className="min-h-screen">
			<div className="mx-auto max-w-4xl px-6 py-14">
				<Link
					className="font-mono text-ink-faint text-xs underline-offset-4 hover:text-ink hover:underline"
					href="/projects"
				>
					← Projects
				</Link>

				<header className="mt-8">
					<h1 className="font-display font-semibold text-4xl text-ink tracking-tight">
						{project.name}
					</h1>
					<a
						className="mt-2 inline-block break-all font-mono text-ink-soft text-sm underline-offset-4 hover:text-ink hover:underline"
						href={project.startUrl}
						rel="noreferrer"
						target="_blank"
					>
						{project.startUrl}
					</a>
				</header>

				<dl className="mt-8 flex flex-wrap gap-x-12 gap-y-5 border-rule border-t pt-6 text-sm">
					<Field label="Expected locales">
						{project.locales.length > 0 ? (
							<span className="flex flex-wrap gap-1.5">
								{project.locales.map((locale) => (
									<code
										className="rounded-sm border border-rule bg-sheet px-1.5 py-0.5 font-mono text-ink text-xs"
										key={locale}
									>
										{locale}
									</code>
								))}
							</span>
						) : (
							<span className="text-ink-faint">
								none — nothing can be reported missing
							</span>
						)}
					</Field>

					<Field label="Request pacing">
						<span className="tnum font-mono text-xs">
							{project.maxConcurrency} at a time, {project.requestDelayMs}ms
							apart
						</span>
					</Field>

					{project.excludePaths.length > 0 ? (
						<Field label="Excluded">
							<span className="font-mono text-xs">
								{project.excludePaths.join(", ")}
							</span>
						</Field>
					) : null}

					{project.includePaths.length > 0 ? (
						<Field label="Only these paths">
							<span className="font-mono text-xs">
								{project.includePaths.join(", ")}
							</span>
						</Field>
					) : null}
				</dl>

				<RunPanel
					expectedLocales={project.locales}
					projectId={project.id}
					role={account.role}
				/>
			</div>
		</main>
	);
}

function Field({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div>
			<dt className="font-mono text-ink-faint text-xs uppercase tracking-wider">
				{label}
			</dt>
			<dd className="mt-1.5 text-ink">{children}</dd>
		</div>
	);
}
