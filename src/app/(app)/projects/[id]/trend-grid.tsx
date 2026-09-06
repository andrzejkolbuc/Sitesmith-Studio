"use client";

import type { ComparableRun } from "~/server/crawl/comparison";
import { api } from "~/trpc/react";
import { REASON_HEADING } from "./comparison-view";
import { FINDING_LABEL } from "./finding-labels";
import { buildTrend, GAP_SENTENCE, type TrendCell, trendGap } from "./trend";

/**
 * The other signature grid: finding types down, runs across.
 *
 * The parity grid answers "is this site in step across its languages"; this
 * answers "is it getting better". Deliberately the same picture, because the
 * product's whole vocabulary is tables and a small set of marks, and a chart
 * here would introduce a second idiom to say something a grid already says.
 *
 * Only runs produced under the same conditions appear. A run that was truncated,
 * scoped differently, or produced by a different set of checks is not drawn at
 * all rather than drawn with a caveat: the shape of a series is the claim, and
 * marking one point does not unmake it.
 */

function onDay(value: Date): string {
	return new Date(value).toLocaleString(undefined, {
		day: "numeric",
		month: "short",
	});
}

function atTime(value: Date): string {
	return new Date(value).toLocaleString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * A column's date and time together, as the run history writes them.
 *
 * The time is not decoration. Two checks of the same project on one day are the
 * ordinary case — it is what "run it again and see" produces — and a header
 * naming only the day gives the reader two identical columns they cannot tell
 * apart or match against the history above.
 */
const when = (value: Date): string => `${onDay(value)}, ${atTime(value)}`;

export function TrendGrid({
	projectId,
	history,
}: {
	projectId: string;
	/** The run list the panel already holds, newest first. */
	history: ComparableRun[];
}) {
	const trend = api.project.trend.useQuery({ projectId });

	// Nothing to say until the answer arrives; the section simply is not there yet.
	if (!trend.data) return null;

	const gap = trendGap(history, trend.data.runs.length);

	return (
		<section className="mt-12">
			<header className="flex flex-wrap items-baseline justify-between gap-3">
				<h2 className="font-display font-semibold text-ink text-xl">Trend</h2>
				{gap === null ? (
					<p className="tnum text-ink-faint text-xs">
						{trend.data.runs.length} comparable checks
					</p>
				) : null}
			</header>

			{gap === null ? (
				<Grid trend={buildTrend(trend.data.runs, trend.data.counts)} />
			) : (
				<Explanation gap={gap} />
			)}
		</section>
	);
}

/**
 * Why the grid is not here, said out loud.
 *
 * An unexplained absence is what makes people stop trusting a tool. The reader
 * is told which precondition is missing and, where the answer is "nothing is
 * wrong, check again", that too — a feature that looks broken and a feature
 * that is merely waiting must not look the same.
 */
function Explanation({
	gap,
}: {
	gap: NonNullable<ReturnType<typeof trendGap>>;
}) {
	const sentence =
		gap.kind === "excluded"
			? `Nothing to plot yet: ${REASON_HEADING[gap.reason].replace(/^Not compared — /, "")}. Earlier checks are not on the same footing as this one.`
			: GAP_SENTENCE[gap.kind];

	return (
		<p className="mt-4 max-w-prose border-rule border-l-2 py-1 pl-4 text-ink-soft text-sm leading-relaxed">
			{sentence}
		</p>
	);
}

function Grid({ trend }: { trend: ReturnType<typeof buildTrend> }) {
	return (
		<>
			<div className="mt-4 overflow-x-auto">
				<table className="w-full min-w-[32rem] border-collapse text-left">
					<thead>
						<tr className="border-rule border-b">
							<th className="py-2 pr-4 font-mono font-normal text-ink-faint text-xs uppercase tracking-wider">
								Check
							</th>
							{trend.runs.map((run) => (
								<th
									className="w-20 px-2 py-2 text-center font-medium font-mono text-ink text-xs"
									key={run.id}
									scope="col"
								>
									{onDay(run.createdAt)}
									<span className="block font-normal text-ink-faint">
										{atTime(run.createdAt)}
									</span>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{trend.rows.map((row) => (
							<tr className="border-rule-soft border-b" key={row.type}>
								<th
									className="py-2.5 pr-4 font-normal text-ink-soft text-xs"
									scope="row"
								>
									{FINDING_LABEL[row.type] ?? row.type}
								</th>
								{row.cells.map((cell, index) => (
									<td
										className="tnum px-2 py-2.5 text-center text-sm"
										key={`${row.type}-${trend.runs[index]?.id}`}
									>
										<Count
											cell={cell}
											label={FINDING_LABEL[row.type] ?? row.type}
											when={
												trend.runs[index]
													? when(trend.runs[index].createdAt)
													: ""
											}
										/>
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{trend.hidden > 0 ? (
				<p className="mt-3 text-ink-faint text-xs italic">
					and {trend.hidden} more{" "}
					{trend.hidden === 1 ? "check that has" : "checks that have"} not
					changed
				</p>
			) : null}

			<p className="mt-5 max-w-prose text-ink-faint text-xs">
				Only checks run under the same settings appear here, so a change in a
				row describes the site rather than a change we made.
			</p>
		</>
	);
}

/**
 * One cell.
 *
 * A check that was not part of a run renders as genuinely nothing — not a zero,
 * not a dash with a number's weight — because a rule that did not exist yet
 * found nothing only in the sense that nobody looked. Writing that as zero
 * would show every check we have ever added as a problem the client fixed on
 * the day we added it.
 */
function Count({
	cell,
	label,
	when,
}: {
	cell: TrendCell;
	label: string;
	when: string;
}) {
	if (cell.kind === "not-checked") {
		return (
			<span className="text-ink-faint" title={`${when}: not checked yet`}>
				<span aria-hidden>·</span>
				<span className="sr-only">
					{label} was not checked on {when}
				</span>
			</span>
		);
	}

	if (cell.value === 0) {
		return (
			<span className="text-ink-faint" title={`${when}: none`}>
				<span aria-hidden>0</span>
				<span className="sr-only">
					no {label} on {when}
				</span>
			</span>
		);
	}

	return (
		<span className="font-medium text-ink" title={`${when}: ${cell.value}`}>
			<span aria-hidden>{cell.value}</span>
			<span className="sr-only">
				{cell.value} {label} on {when}
			</span>
		</span>
	);
}
