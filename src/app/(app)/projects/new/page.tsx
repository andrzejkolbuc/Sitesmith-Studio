import Link from "next/link";
import { redirect } from "next/navigation";

import { api } from "~/trpc/server";

/**
 * Creating a project.
 *
 * Three fields only. Crawl scope and the politeness dials take conservative
 * defaults and are adjustable with `npm run db:seed-project` — forms for them
 * are cheap to add later and would have competed with the crawl itself for the
 * time this slice had.
 */
export default async function NewProjectPage({
	searchParams,
}: {
	searchParams: Promise<{ error?: string }>;
}) {
	const { error } = await searchParams;

	async function create(formData: FormData) {
		"use server";

		const name = String(formData.get("name") ?? "").trim();
		const startUrl = String(formData.get("startUrl") ?? "").trim();

		/**
		 * Locales are the expectation every missing-variant finding is measured
		 * against, so an inaccurate list here produces confidently wrong results
		 * rather than no results.
		 */
		const locales = String(formData.get("locales") ?? "")
			.split(",")
			.map((locale) => locale.trim())
			.filter(Boolean);

		/**
		 * Path prefixes, comma-separated. Excluded paths win over included ones in
		 * the crawler, so an operator who is unsure can list both without having to
		 * reason about the interaction.
		 */
		const paths = (field: string) =>
			String(formData.get(field) ?? "")
				.split(",")
				.map((path) => path.trim())
				.filter(Boolean);

		let projectId: string;
		try {
			const project = await api.project.create({
				name,
				startUrl,
				locales,
				includePaths: paths("includePaths"),
				excludePaths: paths("excludePaths"),
			});
			projectId = project.id;
		} catch {
			// The only realistic failure is a malformed start URL, which the input
			// type already discourages; anything else is worth showing plainly.
			redirect("/projects/new?error=1");
		}

		redirect(`/projects/${projectId}`);
	}

	return (
		<main className="min-h-screen">
			<div className="mx-auto max-w-lg px-6 py-16">
				<Link
					className="font-mono text-ink-faint text-xs underline-offset-4 hover:text-ink hover:underline"
					href="/projects"
				>
					← Projects
				</Link>

				<h1 className="mt-8 font-display font-semibold text-3xl text-ink tracking-tight">
					New project
				</h1>
				<p className="mt-2 max-w-prose text-ink-soft text-sm leading-relaxed">
					One client site to check.
				</p>

				{error ? (
					<p
						className="mt-6 border-mark border-l-2 bg-mark-soft px-4 py-3 text-mark text-sm"
						role="alert"
					>
						That did not work. Check the start URL is a full address including
						https://
					</p>
				) : null}

				<form action={create} className="mt-6 flex flex-col gap-5">
					<label className="flex flex-col gap-2 text-sm">
						<span className="font-mono text-ink-faint text-xs uppercase tracking-wider">
							Name
						</span>
						<input
							className="rounded-sm border border-rule bg-sheet px-3 py-2.5 text-ink text-sm outline-none placeholder:text-ink-faint focus:border-ink"
							name="name"
							placeholder="Acme Corporation"
							required
							type="text"
						/>
					</label>

					<label className="flex flex-col gap-2 text-sm">
						<span className="font-mono text-ink-faint text-xs uppercase tracking-wider">
							Start URL
						</span>
						<input
							className="rounded-sm border border-rule bg-sheet px-3 py-2.5 text-ink text-sm outline-none placeholder:text-ink-faint focus:border-ink"
							name="startUrl"
							placeholder="https://acme.example"
							required
							type="url"
						/>
						<span className="max-w-prose text-ink-soft text-xs leading-relaxed">
							Crawling begins here and follows links within the same site.
						</span>
					</label>

					<label className="flex flex-col gap-2 text-sm">
						<span className="font-mono text-ink-faint text-xs uppercase tracking-wider">
							Expected locales
						</span>
						<input
							className="rounded-sm border border-rule bg-sheet px-3 py-2.5 text-ink text-sm outline-none placeholder:text-ink-faint focus:border-ink"
							name="locales"
							placeholder="en, de, fr"
							type="text"
						/>
						<span className="max-w-prose text-ink-soft text-xs leading-relaxed">
							Comma-separated. A page family missing one of these is reported —
							so list only what the site is supposed to publish.
						</span>
					</label>

					<label className="flex flex-col gap-2 text-sm">
						<span className="font-mono text-ink-faint text-xs uppercase tracking-wider">
							Exclude paths
						</span>
						<input
							className="rounded-sm border border-rule bg-sheet px-3 py-2.5 text-ink text-sm outline-none placeholder:text-ink-faint focus:border-ink"
							name="excludePaths"
							placeholder="/admin, /cart, /search"
							type="text"
						/>
						<span className="max-w-prose text-ink-soft text-xs leading-relaxed">
							Comma-separated path prefixes the check will never request. Worth
							filling in before the first run against a live site — anything
							that does work when fetched belongs here.
						</span>
					</label>

					<label className="flex flex-col gap-2 text-sm">
						<span className="font-mono text-ink-faint text-xs uppercase tracking-wider">
							Only these paths
						</span>
						<input
							className="rounded-sm border border-rule bg-sheet px-3 py-2.5 text-ink text-sm outline-none placeholder:text-ink-faint focus:border-ink"
							name="includePaths"
							placeholder="leave empty for the whole site"
							type="text"
						/>
						<span className="max-w-prose text-ink-soft text-xs leading-relaxed">
							Comma-separated. Empty means the whole site. Excluded paths still
							win, so listing a path in both leaves it excluded.
						</span>
					</label>

					<button
						className="mt-2 rounded-sm bg-ink px-5 py-2.5 font-medium text-paper text-sm transition-opacity hover:opacity-85"
						type="submit"
					>
						Create project
					</button>
				</form>

				<p className="mt-10 max-w-prose border-rule border-t pt-5 text-ink-faint text-xs leading-relaxed">
					Request rate and concurrency default to something gentle. Adjust them
					with{" "}
					<code className="font-mono text-ink">npm run db:seed-project</code>.
				</p>
			</div>
		</main>
	);
}
