"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import { countPages, summariseList } from "./summarise";

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
	hreflang_family_inconsistent: "Language links that disagree",
	variant_diverged: "One variant broken, its siblings fine",
};

function Listed({ items }: { items: string[] }) {
	const { shown, hidden } = summariseList(items);

	return (
		<ul className="mt-1 flex flex-col gap-0.5">
			{shown.map((item) => (
				<li className="break-all text-neutral-500" key={item}>
					{item}
				</li>
			))}
			{hidden > 0 ? (
				<li className="text-neutral-500 italic">
					and {hidden} more {hidden === 1 ? "page" : "pages"}
				</li>
			) : null}
		</ul>
	);
}

/** A URL shortened to its path, since every member shares the same host. */
function pathOf(url: unknown): string {
	if (typeof url !== "string") return "?";
	try {
		return new URL(url).pathname;
	} catch {
		return url;
	}
}

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
					{/*
					 * Two numbers, because neither answers the question alone. The count
					 * of findings says how many separate problems of this kind there
					 * are; the count of pages says how much of the site they touch — and
					 * a family-level finding can be one problem across six pages, which
					 * a finding count on its own would understate as one.
					 */}
					<h3 className="flex flex-wrap items-baseline gap-x-2 font-medium text-neutral-200 text-sm">
						{FINDING_LABEL[type] ?? type}
						<span className="font-normal text-neutral-500 text-xs">
							{rows.length} {rows.length === 1 ? "finding" : "findings"}
							{" · "}
							{countPages(rows)} {countPages(rows) === 1 ? "page" : "pages"}
						</span>
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

		case "hreflang_family_inconsistent": {
			/**
			 * Each line is meant to read as an instruction: on this page, add a link
			 * for that language pointing at that page. Naming the page alone would be
			 * half an instruction, since the fix is a tag naming a language.
			 */
			const defects = Array.isArray(detail.defects)
				? (detail.defects as Array<Record<string, unknown>>)
				: [];

			const lines = defects.map((defect) => {
				const page = pathOf(defect.url);
				const sibling = pathOf(defect.sibling);

				if (defect.kind === "no_self_reference") {
					return `${page} — does not name itself as ${String(defect.locale ?? "?")}`;
				}
				const verb =
					defect.kind === "not_reciprocated"
						? "does not link back to"
						: "does not link to";
				return `${page} — ${verb} ${sibling} (${String(defect.siblingLocale ?? "?")})`;
			});

			const members = Array.isArray(detail.memberUrls)
				? (detail.memberUrls as string[])
				: [];

			return (
				<>
					<span className="text-neutral-100">
						{members.length} pages in this set do not all point at each other
					</span>
					<div className="mt-1 text-sm">
						<Listed items={lines} />
					</div>
				</>
			);
		}

		case "variant_diverged": {
			/**
			 * Stated as a comparison, because that is the finding: not that a page is
			 * broken, but that it is broken while its siblings are not. The declaring
			 * pages are named because each one carries a link that now points at an
			 * error, and each is somewhere the fix has to be checked.
			 */
			const declaredBy = Array.isArray(detail.declaredBy)
				? (detail.declaredBy as string[])
				: [];
			const healthy = Array.isArray(detail.healthyUrls)
				? (detail.healthyUrls as string[])
				: [];

			const status = detail.httpStatus
				? `returns ${String(detail.httpStatus)}`
				: `failed: ${str("fetchError") ?? "no response"}`;

			return (
				<>
					<span className="text-neutral-100">
						The <Code>{str("locale") ?? "?"}</Code> version {status}, while{" "}
						{healthy.length} {healthy.length === 1 ? "sibling" : "siblings"}{" "}
						{healthy.length === 1 ? "works" : "work"}
					</span>
					<div className="mt-1 break-all text-neutral-500">
						{str("brokenUrl")}
					</div>
					<div className="mt-1 text-sm">
						<span className="text-neutral-500">Linked from:</span>
						<Listed items={declaredBy.map(pathOf)} />
					</div>
				</>
			);
		}

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
