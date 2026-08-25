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

		let projectId: string;
		try {
			const project = await api.project.create({ name, startUrl, locales });
			projectId = project.id;
		} catch {
			// The only realistic failure is a malformed start URL, which the input
			// type already discourages; anything else is worth showing plainly.
			redirect("/projects/new?error=1");
		}

		redirect(`/projects/${projectId}`);
	}

	return (
		<main className="min-h-screen bg-neutral-950 text-neutral-100">
			<div className="container mx-auto max-w-lg px-4 py-12">
				<Link
					className="text-neutral-400 text-sm underline-offset-4 hover:text-neutral-100 hover:underline"
					href="/projects"
				>
					← Projects
				</Link>

				<h1 className="mt-6 font-bold text-2xl tracking-tight">New project</h1>
				<p className="mt-1 text-neutral-400 text-sm">
					One client site to check.
				</p>

				{error ? (
					<p
						className="mt-6 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-red-200 text-sm"
						role="alert"
					>
						That did not work. Check the start URL is a full address including
						https://
					</p>
				) : null}

				<form action={create} className="mt-6 flex flex-col gap-5">
					<label className="flex flex-col gap-1.5 text-sm">
						<span className="text-neutral-300">Name</span>
						<input
							className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-neutral-100 outline-none focus:border-neutral-600"
							name="name"
							placeholder="Acme Corporation"
							required
							type="text"
						/>
					</label>

					<label className="flex flex-col gap-1.5 text-sm">
						<span className="text-neutral-300">Start URL</span>
						<input
							className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-neutral-100 outline-none focus:border-neutral-600"
							name="startUrl"
							placeholder="https://acme.example"
							required
							type="url"
						/>
						<span className="text-neutral-500 text-xs">
							Crawling begins here and follows links within the same site.
						</span>
					</label>

					<label className="flex flex-col gap-1.5 text-sm">
						<span className="text-neutral-300">Expected locales</span>
						<input
							className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-neutral-100 outline-none focus:border-neutral-600"
							name="locales"
							placeholder="en, de, fr"
							type="text"
						/>
						<span className="text-neutral-500 text-xs">
							Comma-separated. A page family missing one of these is reported —
							so list only what the site is supposed to publish.
						</span>
					</label>

					<button
						className="mt-1 rounded-md bg-neutral-100 px-4 py-2 font-medium text-neutral-950 transition hover:bg-white"
						type="submit"
					>
						Create project
					</button>
				</form>

				<p className="mt-6 text-neutral-500 text-xs">
					Crawl scope and request limits default to something gentle. Adjust
					them with{" "}
					<code className="text-neutral-400">npm run db:seed-project</code>.
				</p>
			</div>
		</main>
	);
}
