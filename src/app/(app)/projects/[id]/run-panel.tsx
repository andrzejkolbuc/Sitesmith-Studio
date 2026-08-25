"use client";

import { useState } from "react";

import { api } from "~/trpc/react";

/**
 * Triggering a run and watching it finish.
 *
 * A client component because a run takes minutes and the plan requires progress
 * to appear without a manual reload. It polls while a run is active and stops
 * the moment it settles — a crawl that has finished has nothing more to say, and
 * polling a finished run forever is the kind of thing that quietly burns a
 * laptop battery.
 */

const ACTIVE_STATUSES = new Set(["queued", "running"]);

const STATUS_LABEL: Record<string, string> = {
	queued: "Queued",
	running: "Crawling",
	done: "Complete",
	failed: "Stopped early",
	interrupted: "Interrupted",
};

const STATUS_STYLE: Record<string, string> = {
	queued: "border-neutral-700 text-neutral-300",
	running: "border-blue-800 bg-blue-950/40 text-blue-200",
	done: "border-emerald-900 bg-emerald-950/40 text-emerald-200",
	failed: "border-amber-900 bg-amber-950/40 text-amber-200",
	interrupted: "border-neutral-700 bg-neutral-900 text-neutral-300",
};

/** Human-readable description of each finding type. */
const FINDING_LABEL: Record<string, string> = {
	missing_locale: "Missing language variant",
	hreflang_target_failed: "Declared variant is broken",
	hreflang_target_unreached: "Declared variant was never reached",
	no_hreflang: "No language variants declared",
};

export function RunPanel({ projectId }: { projectId: string }) {
	const [startError, setStartError] = useState<string | null>(null);
	const utils = api.useUtils();

	const latestRun = api.project.latestRun.useQuery(
		{ projectId },
		{
			refetchInterval: (query) => {
				const status = query.state.data?.status;
				return status && ACTIVE_STATUSES.has(status) ? 1_500 : false;
			},
		},
	);

	const run = latestRun.data;
	const isActive = run ? ACTIVE_STATUSES.has(run.status) : false;

	const findings = api.project.findings.useQuery(
		{ runId: run?.id ?? "" },
		{ enabled: Boolean(run) && !isActive },
	);

	const startRun = api.project.startRun.useMutation({
		onMutate: () => setStartError(null),
		onSuccess: async () => {
			await utils.project.latestRun.invalidate({ projectId });
		},
		onError: (error) => {
			setStartError(
				error.data?.code === "CONFLICT"
					? "A run is already in progress for this project."
					: "Could not start the run.",
			);
		},
	});

	return (
		<section className="mt-8">
			<div className="flex flex-wrap items-center gap-3">
				{/*
				 * Held until the latest run is known.
				 *
				 * Offering the control before the query settles offers an action whose
				 * precondition is still unknown: a run may already be in progress, and
				 * pressing it would earn a conflict error the user did nothing to
				 * deserve. Server-rendered markup is also inert until hydration, so an
				 * enabled button in that window silently swallows the press.
				 */}
				<button
					className="rounded-md bg-neutral-100 px-4 py-2 font-medium text-neutral-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
					disabled={latestRun.isPending || isActive || startRun.isPending}
					onClick={() => startRun.mutate({ projectId })}
					type="button"
				>
					{isActive ? "Check in progress…" : "Run a check"}
				</button>

				{run ? (
					<span
						className={`rounded-full border px-3 py-1 text-xs ${
							STATUS_STYLE[run.status] ?? STATUS_STYLE.queued
						}`}
					>
						{STATUS_LABEL[run.status] ?? run.status}
						{isActive ? " …" : null}
					</span>
				) : null}
			</div>

			{startError ? (
				<p
					className="mt-4 rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-amber-200 text-sm"
					role="alert"
				>
					{startError}
				</p>
			) : null}

			{run ? (
				<div className="mt-6 rounded-lg border border-neutral-800">
					<dl className="grid grid-cols-2 gap-px bg-neutral-800 text-sm sm:grid-cols-4">
						<Stat label="Pages crawled" value={run.pagesCrawled} />
						<Stat label="Findings" value={run.findingsCount} />
						<Stat label="Started" value={formatTime(run.startedAt)} />
						<Stat label="Duration" value={formatDuration(run)} />
					</dl>

					{run.error ? (
						<p className="border-neutral-800 border-t px-4 py-3 text-amber-200 text-sm">
							{run.error}
						</p>
					) : null}
				</div>
			) : null}

			{run && !isActive ? (
				<Findings
					isLoading={findings.isLoading}
					items={findings.data ?? []}
					runFailed={run.status === "failed" || run.status === "interrupted"}
				/>
			) : null}

			{/* Only once the absence of a run is a fact rather than a pending answer. */}
			{!run && !latestRun.isPending ? (
				<p className="mt-6 text-neutral-500 text-sm">
					No checks have run yet. The first one will crawl the site and report
					pages missing a language variant.
				</p>
			) : null}
		</section>
	);
}

function Stat({ label, value }: { label: string; value: string | number }) {
	return (
		<div className="bg-neutral-950 px-4 py-3">
			<dt className="text-neutral-500 text-xs">{label}</dt>
			<dd className="mt-0.5 font-medium text-neutral-100">{value}</dd>
		</div>
	);
}

type FindingRow = {
	id: string;
	type: string;
	detail: Record<string, unknown>;
};

function Findings({
	items,
	isLoading,
	runFailed,
}: {
	items: FindingRow[];
	isLoading: boolean;
	runFailed: boolean;
}) {
	if (isLoading) {
		return <p className="mt-6 text-neutral-500 text-sm">Loading findings…</p>;
	}

	/**
	 * A clean run is a real outcome and says so. Rendering an empty list here
	 * would look identical to something having gone wrong.
	 */
	if (items.length === 0) {
		return (
			<div className="mt-6 rounded-lg border border-neutral-800 border-dashed p-8 text-center">
				<p className="font-medium text-neutral-200">
					{runFailed ? "No findings recorded" : "Nothing found"}
				</p>
				<p className="mt-2 text-neutral-500 text-sm">
					{runFailed
						? "The check stopped before it could finish, so this is not a clean result."
						: "Every page family published the locales this project expects."}
				</p>
			</div>
		);
	}

	const byType = new Map<string, FindingRow[]>();
	for (const item of items) {
		byType.set(item.type, [...(byType.get(item.type) ?? []), item]);
	}

	return (
		<div className="mt-6 flex flex-col gap-6">
			{[...byType.entries()].map(([type, rows]) => (
				<div key={type}>
					<h3 className="font-medium text-neutral-200 text-sm">
						{FINDING_LABEL[type] ?? type}
						<span className="ml-2 text-neutral-500">{rows.length}</span>
					</h3>

					<ul className="mt-2 divide-y divide-neutral-800 border-neutral-800 border-y">
						{rows.map((row) => (
							<li className="py-3 text-sm" key={row.id}>
								<Evidence detail={row.detail} type={row.type} />
							</li>
						))}
					</ul>
				</div>
			))}
		</div>
	);
}

/**
 * Renders a finding as a sentence rather than a payload dump.
 *
 * A finding has to be actionable without opening the database, so each type
 * states what was expected and what was observed in the terms the reader
 * already has: a URL and a language.
 */
function Evidence({
	type,
	detail,
}: {
	type: string;
	detail: Record<string, unknown>;
}) {
	const str = (key: string): string | null => {
		const value = detail[key];
		return typeof value === "string" ? value : null;
	};

	switch (type) {
		case "missing_locale": {
			const present = Array.isArray(detail.presentLocales)
				? (detail.presentLocales as string[]).join(", ")
				: "";
			return (
				<>
					<span className="text-neutral-100">
						No <Code>{str("missingLocale") ?? "?"}</Code> version
					</span>
					<div className="mt-1 break-all text-neutral-500">
						{str("groupKey")}
						{present ? ` — has ${present}` : null}
					</div>
				</>
			);
		}

		case "hreflang_target_failed":
			return (
				<>
					<span className="text-neutral-100">
						Declared <Code>{str("locale") ?? "?"}</Code> version returns{" "}
						{String(detail.httpStatus ?? detail.fetchError ?? "an error")}
					</span>
					<div className="mt-1 break-all text-neutral-500">
						{str("target")}
						<div>declared by {str("declaredBy")}</div>
					</div>
				</>
			);

		case "hreflang_target_unreached":
			return (
				<>
					<span className="text-neutral-100">
						Declared <Code>{str("locale") ?? "?"}</Code> version was never
						reached
					</span>
					<div className="mt-1 break-all text-neutral-500">
						{str("target")}
						<div>declared by {str("declaredBy")}</div>
					</div>
				</>
			);

		case "no_hreflang":
			return (
				<>
					<span className="text-neutral-100">
						A <Code>{str("impliedLocale") ?? "?"}</Code> page declaring no
						alternates
					</span>
					<div className="mt-1 break-all text-neutral-500">{str("url")}</div>
				</>
			);

		default:
			return (
				<code className="break-all text-neutral-400 text-xs">
					{JSON.stringify(detail)}
				</code>
			);
	}
}

function Code({ children }: { children: React.ReactNode }) {
	return (
		<code className="rounded bg-neutral-800 px-1 py-0.5 text-neutral-200 text-xs">
			{children}
		</code>
	);
}

function formatTime(value: Date | null): string {
	if (!value) return "—";
	return new Date(value).toLocaleTimeString();
}

function formatDuration(run: {
	startedAt: Date | null;
	finishedAt: Date | null;
}): string {
	if (!run.startedAt) return "—";
	const end = run.finishedAt ? new Date(run.finishedAt) : new Date();
	const seconds = Math.round(
		(end.getTime() - new Date(run.startedAt).getTime()) / 1000,
	);

	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}
