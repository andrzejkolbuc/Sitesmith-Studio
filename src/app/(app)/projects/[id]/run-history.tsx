"use client";

/**
 * The project's runs, as a list you can move between.
 *
 * A history of one is not a history: with a single run there is nothing to
 * choose and nothing to compare, so this renders nothing and the panel below it
 * looks exactly as it did before comparison existed.
 */

export type RunSummary = {
	id: string;
	status: string;
	createdAt: Date;
	startedAt: Date | null;
	finishedAt: Date | null;
	pagesCrawled: number;
	findingsCount: number;
	/**
	 * Carried so the row's badge can say the same thing the panel's does. A run
	 * that stopped at its page ceiling closes as `done`, and a history that calls
	 * it "Complete" reintroduces the misread one row down from where it was fixed.
	 */
	crawlComplete: boolean | null;
	reachedPageLimit: boolean | null;
};

function when(value: Date | null): string {
	if (!value) return "—";
	return new Date(value).toLocaleString(undefined, {
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function RunHistory({
	runs,
	selectedRunId,
	onSelect,
	statusLabel,
	statusStyle,
}: {
	runs: RunSummary[];
	selectedRunId: string | null;
	onSelect: (runId: string) => void;
	/**
	 * Passed in rather than duplicated: the panel owns this vocabulary.
	 *
	 * A function rather than a map because the label is derived from the run's
	 * completeness, not from its status alone — `done` is not the same claim on a
	 * run that ran out of pages as on one that reached the end of the site.
	 */
	statusLabel: (run: RunSummary) => string;
	statusStyle: Record<string, string>;
}) {
	if (runs.length < 2) return null;

	return (
		<section className="mt-10">
			<h2 className="border-rule border-b pb-2 font-display font-semibold text-ink text-lg">
				Run history
				<span className="ml-3 font-mono font-normal text-ink-faint text-xs">
					{runs.length} runs
				</span>
			</h2>

			<ul className="divide-y divide-rule-soft">
				{runs.map((run) => {
					const selected = run.id === selectedRunId;

					return (
						<li key={run.id}>
							<button
								/*
								 * The whole row is the control. A date that looks clickable but
								 * is not is worse than one that plainly is.
								 */
								aria-current={selected ? "true" : undefined}
								className={`flex w-full flex-wrap items-center gap-x-6 gap-y-2 px-2 py-3 text-left text-sm transition-colors ${
									selected ? "bg-sheet" : "hover:bg-sheet"
								}`}
								onClick={() => onSelect(run.id)}
								type="button"
							>
								<span className="tnum min-w-36 font-mono text-ink text-xs">
									{when(run.startedAt ?? run.createdAt)}
								</span>

								<span
									className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider ${
										statusStyle[run.status] ?? statusStyle.queued
									}`}
								>
									{statusLabel(run)}
								</span>

								<span className="tnum font-mono text-ink-soft text-xs">
									{run.pagesCrawled} {run.pagesCrawled === 1 ? "page" : "pages"}
								</span>

								<span className="tnum font-mono text-ink-soft text-xs">
									{run.findingsCount}{" "}
									{run.findingsCount === 1 ? "finding" : "findings"}
								</span>

								{selected ? (
									<span className="ml-auto font-mono text-[11px] text-ink-faint uppercase tracking-wider">
										Showing
									</span>
								) : null}
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
