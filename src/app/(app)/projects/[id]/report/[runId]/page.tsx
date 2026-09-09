import Link from "next/link";
import { notFound } from "next/navigation";

import { api } from "~/trpc/server";
import { CLIENT_LABEL, clientSentence } from "../../client-vocabulary";
import { type AnnotatedRow, splitResolved } from "../../comparison-view";
import { clientCoverageSentences, runCoverage } from "../../coverage";
import { pagesInvolved } from "../../summarise";
import { differsMeaningfully, orderSnapshots } from "../../visual";

/**
 * One stored run, written for the client contact rather than the operator.
 *
 * A server component, and deliberately not a client one. Every other view in
 * this product polls, folds and reveals — it is a console, and being alive is
 * the point. This is a document: it exists to be read once and printed, and a
 * page that assembles itself in the browser prints whatever had arrived by the
 * moment the reader pressed print. Rendering it whole on the server is what
 * makes the paper version trustworthy.
 *
 * Three consequences follow from that, and each is a requirement rather than a
 * side effect. Nothing is behind a disclosure, so the pictures are in the
 * document instead of behind a control that paper does not have. Nothing is
 * truncated to five, because "and 3 more" cannot be expanded once printed. And
 * no control appears at all — a button on paper is a dead affordance, and the
 * crawl's own configuration is not the client's business.
 *
 * Authorisation is inherited, not rebuilt. This sits inside the `(app)` route
 * group, so the session and tenant gate is structural, and every procedure it
 * calls runs `assertProjectAccess` for itself. It adds no procedure of its own.
 */
export default async function ReportPage({
	params,
}: {
	params: Promise<{ id: string; runId: string }>;
}) {
	const { id, runId } = await params;

	let project: Awaited<ReturnType<typeof api.project.byId>>;
	let run: Awaited<ReturnType<typeof api.project.runStatus>>;
	try {
		[project, run] = await Promise.all([
			api.project.byId({ projectId: id }),
			api.project.runStatus({ runId }),
		]);
	} catch {
		// Another tenant's project, or another tenant's run, is indistinguishable
		// from one that does not exist. That is the intended answer.
		notFound();
	}

	/*
	 * The URL pairs a project with a run, and nothing upstream checks that the
	 * two belong together — `runStatus` authorises against the run's own project,
	 * which may not be this one. Without this, a run could be rendered under
	 * another project's name and start URL, and the report would be a document
	 * making a confident claim about the wrong site.
	 */
	if (run.projectId !== project.id) notFound();

	const [findings, pages, comparison, snapshots] = await Promise.all([
		api.project.findings({ runId }),
		api.project.runPages({ runId }),
		api.project.comparison({ runId }),
		api.project.runSnapshots({ runId }),
	]);

	/*
	 * The comparison leads where there is one, so a finding carries whether it is
	 * new or was already there. Where the two runs were not comparable it returns
	 * nothing, and the run's own findings stand in with no status — the report
	 * says what is true now rather than refusing to say anything.
	 */
	const annotated: AnnotatedRow[] =
		comparison.findings.length > 0
			? comparison.findings
			: findings.map((finding) => ({ ...finding, status: null }));

	const { present, resolved } = splitResolved(annotated);
	const coverage = clientCoverageSentences(runCoverage(run));

	/*
	 * Grouped by type so one heading carries one kind of problem, in the order
	 * the run recorded them. No ranking: nothing in the data supports one, and
	 * inventing an order here would be this product asserting a severity it has
	 * never measured.
	 */
	const groups = new Map<string, typeof present>();
	for (const finding of present) {
		const group = groups.get(finding.type);
		if (group) group.push(finding);
		else groups.set(finding.type, [finding]);
	}

	const changed = orderSnapshots(snapshots.snapshots).filter(
		differsMeaningfully,
	);

	const pageCount = new Set(pages.map((page) => page.url)).size;

	return (
		<main className="min-h-screen">
			<div className="mx-auto max-w-3xl px-6 py-14">
				<Link
					className="font-mono text-ink-faint text-xs underline-offset-4 hover:text-ink hover:underline"
					data-no-print
					href={`/projects/${project.id}`}
				>
					← Back to {project.name}
				</Link>

				<header className="mt-8 border-rule border-b pb-8">
					<p className="font-mono text-ink-faint text-xs uppercase tracking-wider">
						Site check
					</p>
					<h1 className="mt-2 font-display font-semibold text-4xl text-ink tracking-tight">
						{project.name}
					</h1>
					<p className="mt-3 break-all font-mono text-ink-soft text-sm">
						{project.startUrl}
					</p>
					<p className="mt-4 text-ink-soft text-sm">
						Checked {formatDate(run.startedAt ?? run.createdAt)} · {pageCount}{" "}
						{pageCount === 1 ? "page" : "pages"} looked at
					</p>
				</header>

				{/*
				 * Coverage leads the document. On screen each section states its own,
				 * a few hundred pixels from the numbers it qualifies; on paper that
				 * closeness is gone and a reader who skims may never reach it. So the
				 * whole statement is made once, before anything it could qualify.
				 */}
				<section className="mt-10" data-coverage>
					<h2 className="font-display font-semibold text-ink text-xl">
						What this check covered
					</h2>
					<div className="mt-4 border-rule border-l-2 py-1 pl-4">
						{coverage.map((sentence) => (
							<p
								className="max-w-prose text-ink-soft text-sm leading-relaxed [&+p]:mt-2"
								key={sentence}
							>
								{sentence}
							</p>
						))}
					</div>
				</section>

				<section className="mt-12">
					<h2 className="font-display font-semibold text-ink text-xl">
						What we found
					</h2>

					{groups.size === 0 ? (
						/*
						 * Never "no problems found". The checks that ran are the checks
						 * that ran, and on a partial pass some of them were held back —
						 * which the coverage statement above has already said.
						 */
						<p className="mt-4 max-w-prose text-ink-soft text-sm leading-relaxed">
							Nothing was found by the checks that ran on this pass.
						</p>
					) : (
						<div className="mt-6 flex flex-col gap-10">
							{[...groups].map(([type, items]) => (
								<article className="report-block" key={type}>
									<h3 className="font-display font-semibold text-ink text-lg">
										{CLIENT_LABEL[type] ?? "Something to look at"}
									</h3>
									<p className="mt-1 font-mono text-ink-faint text-xs">
										{items.length}{" "}
										{items.length === 1 ? "instance" : "instances"}
									</p>

									<ul className="mt-4 flex flex-col gap-5">
										{items.map((finding) => (
											<li className="report-block" key={finding.id}>
												<p className="max-w-prose text-ink text-sm leading-relaxed">
													{clientSentence(finding)}
												</p>
												<Pages urls={pagesInvolved(finding)} />
											</li>
										))}
									</ul>
								</article>
							))}
						</div>
					)}
				</section>

				{changed.length > 0 ? (
					<section className="mt-12">
						<h2 className="font-display font-semibold text-ink text-xl">
							Pages that look different
						</h2>
						<p className="mt-2 max-w-prose text-ink-soft text-sm leading-relaxed">
							Compared against the reference pictures set for this site.
						</p>

						<div className="mt-6 flex flex-col gap-10">
							{changed.map((row) => (
								<figure className="report-block" key={row.id}>
									<figcaption className="break-all font-mono text-ink-soft text-xs">
										{row.url}
									</figcaption>
									<div className="mt-2 grid gap-4 sm:grid-cols-2">
										{/* biome-ignore lint/performance/noImgElement: a stored PNG
										    served by our own route, not an asset the optimiser can
										    pre-process. */}
										<img
											alt={`${row.url} as it was`}
											className="w-full border border-rule"
											src={`/api/snapshots/${row.id}?view=baseline`}
										/>
										{/* biome-ignore lint/performance/noImgElement: as above. */}
										<img
											alt={`${row.url} as it is now`}
											className="w-full border border-rule"
											src={`/api/snapshots/${row.id}?view=current`}
										/>
									</div>
								</figure>
							))}
						</div>
					</section>
				) : null}

				{resolved.length > 0 ? (
					<section className="mt-12">
						<h2 className="font-display font-semibold text-ink text-xl">
							No longer reported
						</h2>
						<p className="mt-2 max-w-prose text-ink-soft text-sm leading-relaxed">
							These were reported by the previous check and were not found by
							this one.
						</p>

						<ul className="mt-6 flex flex-col gap-4">
							{resolved.map((finding) => (
								<li className="report-block" key={finding.id}>
									<p className="max-w-prose text-ink-soft text-sm leading-relaxed">
										{CLIENT_LABEL[finding.type] ?? "Something to look at"}
									</p>
								</li>
							))}
						</ul>
					</section>
				) : null}
			</div>
		</main>
	);
}

/**
 * The pages a finding concerns, under a heading that says so.
 *
 * The list is not the sentence's count and must not be read as it. A sentence
 * saying "1 page links to a page that does not open" sits above two addresses —
 * the page doing the linking and the page that will not open — and without a
 * label the reader sees a number contradicting a list directly beneath it, then
 * distrusts both.
 */
function Pages({ urls }: { urls: string[] }) {
	/*
	 * Deduplicated, because a page can hold both roles in one finding — the
	 * address that is wrong and the address that emits it are the same page for
	 * the duplicate rules. Listed twice it reads as two separate problems at one
	 * address, which is the opposite of what the finding says.
	 */
	const unique = [...new Set(urls)];
	if (unique.length === 0) return null;

	return (
		<div className="mt-2">
			<p className="font-mono text-ink-faint text-xs uppercase tracking-wider">
				Pages involved
			</p>
			<ul className="mt-1 flex flex-col gap-0.5">
				{unique.map((url) => (
					<li className="break-all font-mono text-ink-faint text-xs" key={url}>
						{url}
					</li>
				))}
			</ul>
		</div>
	);
}

function formatDate(value: Date): string {
	return new Date(value).toLocaleDateString(undefined, {
		day: "numeric",
		month: "long",
		year: "numeric",
	});
}
