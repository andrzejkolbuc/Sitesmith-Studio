"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import { buildParity, type Cell } from "./parity";
import { countPages, summariseList } from "./summarise";

/**
 * Triggering a run and reading what it found.
 *
 * A client component because a run takes minutes and progress has to appear
 * without a manual reload. It polls while a run is active and stops the moment
 * it settles — a crawl that has finished has nothing more to say.
 */

const ACTIVE_STATUSES = new Set(["queued", "running"]);

const STATUS_LABEL: Record<string, string> = {
	queued: "Queued",
	running: "Crawling",
	done: "Complete",
	failed: "Stopped early",
	interrupted: "Interrupted",
};

/**
 * Only a run that ended badly gets colour. A finished run is the expected
 * outcome and says so quietly; marking it green would spend the reader's
 * attention on the one thing that needs none.
 */
const STATUS_STYLE: Record<string, string> = {
	queued: "border-rule text-ink-soft",
	running: "border-ink text-ink",
	done: "border-rule text-ink-soft",
	failed: "border-mark bg-mark-soft text-mark",
	interrupted: "border-flag bg-flag-soft text-flag",
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
		<ul className="mt-1.5 flex flex-col gap-1">
			{shown.map((item) => (
				<li className="break-all font-mono text-ink-soft text-xs" key={item}>
					{item}
				</li>
			))}
			{hidden > 0 ? (
				<li className="text-ink-faint text-xs italic">
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
		return new URL(url).pathname || "/";
	} catch {
		return url;
	}
}

export function RunPanel({
	projectId,
	expectedLocales,
}: {
	projectId: string;
	expectedLocales: string[];
}) {
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
	const settled = Boolean(run) && !isActive;

	const findings = api.project.findings.useQuery(
		{ runId: run?.id ?? "" },
		{ enabled: settled },
	);

	const pages = api.project.runPages.useQuery(
		{ runId: run?.id ?? "" },
		{ enabled: settled },
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
		<section className="mt-10">
			<div className="flex flex-wrap items-center gap-4 border-rule border-t pt-6">
				{/*
				 * Held until the latest run is known. Offering the control before the
				 * query settles offers an action whose precondition is still unknown,
				 * and server-rendered markup is inert until hydration, so an enabled
				 * button in that window silently swallows the press.
				 */}
				<button
					className="rounded-sm bg-ink px-5 py-2.5 font-medium text-paper text-sm transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-35"
					disabled={latestRun.isPending || isActive || startRun.isPending}
					onClick={() => startRun.mutate({ projectId })}
					type="button"
				>
					{isActive ? "Check in progress…" : "Run a check"}
				</button>

				{run ? (
					<span
						className={`rounded-full border px-3 py-1 font-mono text-xs uppercase tracking-wider ${
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
					className="mt-4 border-mark border-l-2 bg-mark-soft px-4 py-3 text-mark text-sm"
					role="alert"
				>
					{startError}
				</p>
			) : null}

			{run ? (
				<dl className="mt-8 flex flex-wrap gap-x-14 gap-y-6">
					<Stat label="Pages crawled" value={run.pagesCrawled} />
					<Stat label="Findings" value={run.findingsCount} />
					<Stat label="Started" value={formatTime(run.startedAt)} />
					<Stat label="Duration" value={formatDuration(run)} />
				</dl>
			) : null}

			{run?.error ? (
				<p className="mt-6 border-flag border-l-2 bg-flag-soft px-4 py-3 text-flag text-sm">
					{run.error}
				</p>
			) : null}

			{settled && pages.data && pages.data.length > 0 ? (
				<ParityGrid expectedLocales={expectedLocales} pages={pages.data} />
			) : null}

			{settled ? (
				<Findings
					isLoading={findings.isLoading}
					items={findings.data ?? []}
					runFailed={run?.status === "failed" || run?.status === "interrupted"}
				/>
			) : null}

			{/* Only once the absence of a run is a fact rather than a pending answer. */}
			{!run && !latestRun.isPending ? (
				<p className="mt-8 max-w-prose text-ink-soft text-sm leading-relaxed">
					No checks have run yet. The first one will crawl the site and report
					pages missing a language variant.
				</p>
			) : null}
		</section>
	);
}

function Stat({ label, value }: { label: string; value: string | number }) {
	return (
		<div>
			<dt className="font-mono text-ink-faint text-xs uppercase tracking-wider">
				{label}
			</dt>
			<dd className="tnum mt-1 font-display font-normal text-3xl text-ink">
				{value}
			</dd>
		</div>
	);
}

/**
 * The signature of this interface: families down, languages across.
 *
 * Every other view answers one page at a time. This one answers the question an
 * operator actually holds in their head — *is this site in step across its
 * languages* — and it does so from rows the crawl already writes and nothing
 * previously displayed.
 *
 * A healthy cell is deliberately almost blank. Colour is reserved for the two
 * states that need a person, so a site in good shape reads as a quiet grid and
 * the eye lands only where there is work.
 */
function ParityGrid({
	pages,
	expectedLocales,
}: {
	pages: Array<{
		url: string;
		locale: string | null;
		variantGroupKey: string | null;
		httpStatus: number | null;
		fetchError: string | null;
	}>;
	expectedLocales: string[];
}) {
	const parity = buildParity(pages, expectedLocales);
	const total = parity.rows.length + parity.hidden;
	// Nothing to compare: no languages configured, or no page has a sibling.
	if (parity.locales.length === 0 || total === 0) return null;

	return (
		<section className="mt-12">
			<header className="flex flex-wrap items-baseline justify-between gap-3">
				<h2 className="font-display font-semibold text-ink text-xl">Parity</h2>
				<p className="tnum text-ink-faint text-xs">
					{parity.clean} of {total} page {total === 1 ? "family" : "families"}{" "}
					in step
				</p>
			</header>

			<div className="mt-4 overflow-x-auto">
				<table className="w-full min-w-[32rem] border-collapse text-left">
					<thead>
						<tr className="border-rule border-b">
							<th className="py-2 pr-4 font-mono font-normal text-ink-faint text-xs uppercase tracking-wider">
								Page family
							</th>
							{parity.locales.map((locale) => (
								<th
									className="w-16 px-2 py-2 text-center font-medium font-mono text-ink text-xs"
									key={locale}
									scope="col"
								>
									{locale}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{parity.rows.map((row) => (
							<tr className="border-rule-soft border-b" key={row.groupKey}>
								<th
									className="max-w-0 truncate py-2.5 pr-4 font-mono font-normal text-ink-soft text-xs"
									scope="row"
									title={row.groupKey}
								>
									{pathOf(row.groupKey)}
								</th>
								{row.cells.map((cell, index) => (
									<td
										className="px-2 py-2.5 text-center"
										key={`${row.groupKey}-${parity.locales[index]}`}
									>
										<Mark cell={cell} locale={parity.locales[index] ?? ""} />
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{parity.hidden > 0 ? (
				<p className="mt-3 text-ink-faint text-xs italic">
					and {parity.hidden} more {parity.hidden === 1 ? "family" : "families"}
					, all in step
				</p>
			) : null}

			{/*
			 * Said out loud rather than left as a silent omission. A page with no
			 * siblings is not something parity can be judged on — the detection rules
			 * ignore it for the same reason — but a grid covering five of eight pages
			 * should not imply it covered all eight.
			 */}
			{parity.singles > 0 ? (
				<p className="tnum mt-1 text-ink-faint text-xs italic">
					{parity.singles} {parity.singles === 1 ? "page has" : "pages have"} no
					language variants and {parity.singles === 1 ? "is" : "are"} not
					compared here
				</p>
			) : null}

			<p className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-ink-faint text-xs">
				<span className="flex items-center gap-1.5">
					<span aria-hidden className="text-ink-faint">
						·
					</span>
					published
				</span>
				<span className="flex items-center gap-1.5">
					<span aria-hidden className="font-medium text-flag">
						○
					</span>
					expected, not published
				</span>
				<span className="flex items-center gap-1.5">
					<span aria-hidden className="font-medium text-mark">
						✕
					</span>
					published but failing
				</span>
			</p>
		</section>
	);
}

/**
 * One cell.
 *
 * The glyphs carry a screen-reader label each, because a grid whose entire
 * meaning is conveyed by three small marks is unusable without one. A language
 * the project never asked for renders as genuinely nothing — not a faint mark,
 * not a dash — since a site that does not publish Portuguese is not missing it.
 */
function Mark({ cell, locale }: { cell: Cell; locale: string }) {
	if (cell === "not-expected") return null;

	if (cell === "broken") {
		return (
			<span
				className="font-medium text-mark text-sm"
				title={`${locale}: failing`}
			>
				<span aria-hidden>✕</span>
				<span className="sr-only">{locale} published but failing</span>
			</span>
		);
	}

	if (cell === "missing") {
		return (
			<span
				className="font-medium text-flag text-sm"
				title={`${locale}: missing`}
			>
				<span aria-hidden>○</span>
				<span className="sr-only">{locale} expected but not published</span>
			</span>
		);
	}

	return (
		<span className="text-ink-faint text-sm" title={`${locale}: published`}>
			<span aria-hidden>·</span>
			<span className="sr-only">{locale} published</span>
		</span>
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
		return <p className="mt-8 text-ink-faint text-sm">Loading findings…</p>;
	}

	/**
	 * A clean run is a real outcome and says so. Rendering an empty list here
	 * would look identical to something having gone wrong.
	 */
	if (items.length === 0) {
		return (
			<div className="mt-10 border-rule border-t pt-8">
				<p className="font-display font-semibold text-ink text-xl">
					{runFailed ? "No findings recorded" : "Nothing found"}
				</p>
				<p className="mt-2 max-w-prose text-ink-soft text-sm leading-relaxed">
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
		<div className="mt-12 flex flex-col gap-10">
			{[...byType.entries()].map(([type, rows]) => (
				<div key={type}>
					{/*
					 * Two numbers, because neither answers the question alone. The count
					 * of findings says how many separate problems of this kind there are;
					 * the count of pages says how much of the site they touch — and a
					 * family-level finding can be one problem across six pages.
					 */}
					<h3 className="flex flex-wrap items-baseline gap-x-3 border-rule border-b pb-2 font-display font-semibold text-ink text-lg">
						{FINDING_LABEL[type] ?? type}
						<span className="tnum font-mono font-normal text-ink-faint text-xs">
							{rows.length} {rows.length === 1 ? "finding" : "findings"}
							{" · "}
							{countPages(rows)} {countPages(rows) === 1 ? "page" : "pages"}
						</span>
					</h3>

					<ul className="divide-y divide-rule-soft">
						{rows.map((row) => (
							<li className="py-4 text-sm" key={row.id}>
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
					<span className="text-ink">
						No <Tag tone="flag">{str("missingLocale") ?? "?"}</Tag> version
					</span>
					<div className="mt-1.5 break-all font-mono text-ink-soft text-xs">
						{pathOf(str("groupKey"))}
						{present ? ` — has ${present}` : null}
					</div>
				</>
			);
		}

		case "hreflang_target_failed":
			return (
				<>
					<span className="text-ink">
						Declared <Tag tone="mark">{str("locale") ?? "?"}</Tag> version
						returns{" "}
						{String(detail.httpStatus ?? detail.fetchError ?? "an error")}
					</span>
					<div className="mt-1.5 break-all font-mono text-ink-soft text-xs">
						{pathOf(str("target"))}
						<div className="text-ink-faint">
							declared by {pathOf(str("declaredBy"))}
						</div>
					</div>
				</>
			);

		case "hreflang_target_unreached":
			return (
				<>
					<span className="text-ink">
						Declared <Tag tone="flag">{str("locale") ?? "?"}</Tag> version was
						never reached
					</span>
					<div className="mt-1.5 break-all font-mono text-ink-soft text-xs">
						{pathOf(str("target"))}
						<div className="text-ink-faint">
							declared by {pathOf(str("declaredBy"))}
						</div>
					</div>
				</>
			);

		case "no_hreflang":
			return (
				<>
					<span className="text-ink">
						A <Tag tone="flag">{str("impliedLocale") ?? "?"}</Tag> page
						declaring no alternates
					</span>
					<div className="mt-1.5 break-all font-mono text-ink-soft text-xs">
						{pathOf(str("url"))}
					</div>
				</>
			);

		case "hreflang_family_inconsistent": {
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
					<span className="text-ink">
						{members.length} pages in this set do not all point at each other
					</span>
					<Listed items={lines} />
				</>
			);
		}

		case "variant_diverged": {
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
					<span className="text-ink">
						The <Tag tone="mark">{str("locale") ?? "?"}</Tag> version {status},
						while {healthy.length}{" "}
						{healthy.length === 1 ? "sibling" : "siblings"}{" "}
						{healthy.length === 1 ? "works" : "work"}
					</span>
					<div className="mt-1.5 break-all font-mono text-ink-soft text-xs">
						{pathOf(str("brokenUrl"))}
					</div>
					<div className="mt-2 text-ink-faint text-xs">Linked from:</div>
					<Listed items={declaredBy.map(pathOf)} />
				</>
			);
		}

		default:
			return (
				<code className="break-all font-mono text-ink-faint text-xs">
					{JSON.stringify(detail)}
				</code>
			);
	}
}

/** A language tag, set in the face the rest of the data uses. */
function Tag({
	children,
	tone,
}: {
	children: React.ReactNode;
	tone: "mark" | "flag";
}) {
	const colour =
		tone === "mark"
			? "border-mark/30 bg-mark-soft text-mark"
			: "border-flag/30 bg-flag-soft text-flag";

	return (
		<code
			className={`rounded-sm border px-1.5 py-0.5 font-mono text-xs ${colour}`}
		>
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
