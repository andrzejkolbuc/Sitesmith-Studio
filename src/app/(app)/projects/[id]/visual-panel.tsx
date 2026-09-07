"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import {
	changeShare,
	differsMeaningfully,
	orderSnapshots,
	type SnapshotRow,
	uncomparedReason,
	visualState,
} from "./visual";

/**
 * How the watched pages look now, against what they are supposed to look like.
 *
 * Named `visual-panel.tsx` rather than `visual.tsx` so the component and its
 * logic module do not collide — S-06 hit exactly that import ambiguity and
 * resolved it by renaming.
 *
 * **This panel does not restate the finding's sentence.** The finding says a
 * page changed; this shows the pictures and the numbers behind that. Two
 * sections agreeing verbatim reads as a bug in the page, which is what S-06's
 * real-site reading caught between the trend and the comparison refusal.
 */

const percent = (share: number): string =>
	share >= 0.01 ? `${(share * 100).toFixed(1)}%` : share > 0 ? "<0.1%" : "0%";

export function VisualPanel({
	projectId,
	runId,
}: {
	projectId: string;
	runId: string;
}) {
	const data = api.project.runSnapshots.useQuery({ runId });
	const utils = api.useUtils();
	const pin = api.project.pinBaseline.useMutation({
		onSuccess: async () => {
			await utils.project.runSnapshots.invalidate();
			await utils.project.byId.invalidate();
		},
	});

	if (!data.data) return null;

	const { snapshots, summary, pagesCrawled, projectBaselineRunId } = data.data;
	const rows: SnapshotRow[] = snapshots.map((row) => ({
		id: row.id,
		url: row.url,
		byteSize: row.byteSize,
		captureError: row.captureError,
		expiredAt: row.expiredAt,
		comparison: row.comparison ?? null,
	}));

	const state = visualState(summary, rows, pagesCrawled, projectBaselineRunId);

	/**
	 * A run from before the visual pass existed says nothing at all. There is no
	 * absence to explain, and a notice about it would be about us rather than
	 * about their site.
	 */
	if (state.kind === "not_recorded") return null;

	const capturable = rows.some((row) => row.captureError === null);

	return (
		<section className="mt-12">
			<header className="flex flex-wrap items-baseline justify-between gap-3">
				<h2 className="font-display font-semibold text-ink text-xl">
					Appearance
				</h2>
				{state.kind === "compared" ? (
					<p className="tnum text-ink-faint text-xs">{state.coverage}</p>
				) : null}
			</header>

			{/*
			 * The state this section spends most of its life in, and neither a pass
			 * nor a failure. It says what to do rather than reporting a verdict on a
			 * project nobody has told what the site should look like.
			 */}
			{state.kind === "no_baseline" ? (
				<div className="mt-4 max-w-prose border-rule border-l-2 py-1 pl-4">
					<p className="text-ink-soft text-sm leading-relaxed">
						No baseline is pinned, so there is nothing to compare this run
						against. Pin a run you are happy with and every later run will
						report which of its pages stopped looking like it.
					</p>
					{capturable ? (
						<button
							className="mt-3 rounded-sm border border-rule px-3 py-1.5 font-mono text-ink text-xs hover:bg-sheet disabled:opacity-50"
							disabled={pin.isPending}
							onClick={() => pin.mutate({ projectId, runId })}
							type="button"
						>
							{pin.isPending ? "Pinning…" : "Pin this run as the baseline"}
						</button>
					) : (
						<p className="mt-3 text-ink-faint text-xs">
							This run photographed nothing, so it cannot be a baseline.
						</p>
					)}
					{pin.error ? (
						<p className="mt-2 text-flag text-xs">{pin.error.message}</p>
					) : null}
				</div>
			) : null}

			{/*
			 * A baseline exists, just not for this run. The instruction above would
			 * be wrong here — the reader has already pinned one, and repeating the
			 * ask would read as their pin not having taken.
			 */}
			{state.kind === "predates_baseline" ? (
				<p className="mt-4 max-w-prose border-rule border-l-2 py-1 pl-4 text-ink-soft text-sm leading-relaxed">
					This run happened before the current baseline was pinned, so it was
					not compared against anything. The next check will be.
				</p>
			) : null}

			{state.kind === "unavailable" ? (
				<p className="mt-4 max-w-prose border-rule border-l-2 py-1 pl-4 text-ink-soft text-sm leading-relaxed">
					No browser was available during this run, so no page was photographed.
					This says nothing about the site — the next run will picture the
					watched pages again.
				</p>
			) : null}

			{state.kind === "nothing_watched" ? (
				<p className="mt-4 max-w-prose border-rule border-l-2 py-1 pl-4 text-ink-soft text-sm leading-relaxed">
					A baseline is pinned, but this run photographed none of the pages it
					watches. That usually means those pages are no longer reachable.
				</p>
			) : null}

			{state.kind === "compared" ? (
				<>
					{/*
					 * The numbers below were measured against a reference that is no
					 * longer the reference. That is a fact about us rather than about
					 * their site, which is why it is said rather than silently ignored.
					 */}
					{state.supersededBaseline ? (
						<p className="mt-4 max-w-prose border-flag border-l-2 bg-flag-soft px-4 py-3 text-flag text-sm">
							The baseline has been re-pinned since this run, so what follows
							compares against the old one.
						</p>
					) : null}

					<ul className="mt-4 divide-y divide-rule-soft border-rule border-t">
						{orderSnapshots(rows).map((row) => (
							<Row key={row.id} row={row} />
						))}
					</ul>

					{/*
					 * Re-pinning, which the no-baseline state offers once and nothing
					 * offered again. A baseline that can only ever be set once turns
					 * every intended redesign into a permanent finding, and masks are
					 * unusable without it — editing them refuses every later comparison
					 * until a run is pinned under the new list.
					 *
					 * Worded as a replacement rather than as a pin: the reader already
					 * has a baseline, and the thing they need to know is that this run
					 * takes its place.
					 */}
					{capturable ? (
						<div className="mt-5 border-rule border-l-2 py-1 pl-4">
							<button
								className="rounded-sm border border-rule px-3 py-1.5 font-mono text-ink text-xs hover:bg-sheet disabled:opacity-50"
								disabled={pin.isPending}
								onClick={() => pin.mutate({ projectId, runId })}
								type="button"
							>
								{pin.isPending ? "Pinning…" : "Make this run the new baseline"}
							</button>
							<p className="mt-2 max-w-prose text-ink-faint text-xs">
								Later runs will be compared against this one instead. Do it
								after a change you meant to make, or after editing the masked
								regions.
							</p>
							{pin.error ? (
								<p className="mt-2 text-flag text-xs">{pin.error.message}</p>
							) : null}
						</div>
					) : null}

					<p className="mt-5 max-w-prose text-ink-faint text-xs">
						A watched set, not the whole site: the pages the baseline
						photographed are the pages later runs re-photograph, so the same
						pages are compared every time. Counts are pixels that differ from
						the baseline over the area both pictures cover — there is no score,
						because whether a difference matters is a judgement about pictures
						you can see.
					</p>
				</>
			) : null}
		</section>
	);
}

function Row({ row }: { row: SnapshotRow }) {
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<"side" | "diff">("side");

	const reason = uncomparedReason(row);
	const share = changeShare(row);
	/** The rule's own decision, not a second one: see MIN_CHANGED_SHARE. */
	const changed = differsMeaningfully(row);

	return (
		<li className="py-3">
			<div className="flex flex-wrap items-baseline justify-between gap-3">
				<button
					className="max-w-full truncate text-left font-mono text-ink-soft text-xs hover:text-ink"
					disabled={reason !== null}
					onClick={() => setOpen(!open)}
					title={row.url}
					type="button"
				>
					{pathOf(row.url)}
				</button>

				{/*
				 * Every uncompared reason is a fact about us — a picture we could not
				 * take, a viewport we changed. Said out loud, because a page silently
				 * absent from the comparison reads as a page that was fine.
				 */}
				{reason !== null ? (
					<span className="text-ink-faint text-xs italic">{reason}</span>
				) : changed ? (
					<span className="tnum font-medium text-mark text-sm">
						{percent(share ?? 0)} of the page differs
					</span>
				) : (
					<span className="text-ink-faint text-xs">matches the baseline</span>
				)}
			</div>

			{open && reason === null ? (
				<div className="mt-3">
					<div className="flex gap-2">
						{(["side", "diff"] as const).map((option) => (
							<button
								className={`rounded-sm border px-2 py-1 font-mono text-xs ${
									view === option
										? "border-rule bg-sheet text-ink"
										: "border-transparent text-ink-faint hover:text-ink"
								}`}
								key={option}
								onClick={() => setView(option)}
								type="button"
							>
								{option === "side" ? "Side by side" : "Difference"}
							</button>
						))}
					</div>

					{view === "side" ? (
						<div className="mt-3 grid gap-4 sm:grid-cols-2">
							<Figure
								caption="Baseline"
								src={`/api/snapshots/${row.id}?view=baseline`}
							/>
							<Figure
								caption="This run"
								src={`/api/snapshots/${row.id}?view=current`}
							/>
						</div>
					) : (
						<Figure
							caption="Pixels that differ, highlighted"
							src={`/api/snapshots/${row.id}?view=diff`}
						/>
					)}
				</div>
			) : null}
		</li>
	);
}

function Figure({ caption, src }: { caption: string; src: string }) {
	return (
		<figure className="min-w-0">
			<figcaption className="font-mono text-ink-faint text-xs uppercase tracking-wider">
				{caption}
			</figcaption>
			{/* biome-ignore lint/performance/noImgElement: a stored PNG served by our
			    own route, not an asset the image optimiser can pre-process. */}
			<img
				alt={caption}
				className="mt-1.5 w-full border border-rule"
				loading="lazy"
				src={src}
			/>
		</figure>
	);
}

function pathOf(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return url;
	}
}
