"use client";

import { useMemo, useState } from "react";

import type { FindingStatus } from "~/server/crawl/comparison";
import { api } from "~/trpc/react";
import {
	comparisonState,
	newCount,
	REASON_HEADING,
	REASON_SENTENCE,
	splitResolved,
	spreadSentence,
	statusIndex,
} from "./comparison-view";
import { type CorrelatedProblem, correlate } from "./correlate";
import { buildParity, type Cell } from "./parity";
import { RunHistory } from "./run-history";
import { countPages, summariseList } from "./summarise";

/**
 * Triggering a run and reading what it found.
 *
 * A client component because a run takes minutes and progress has to appear
 * without a manual reload. It polls while a run is active and stops the moment
 * it settles — a crawl that has finished has nothing more to say.
 */

const ACTIVE_STATUSES = new Set(["queued", "running"]);

export const STATUS_LABEL: Record<string, string> = {
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
export const STATUS_STYLE: Record<string, string> = {
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
	content_untranslated: "Content that was never translated",
	content_structure_differs: "Variants that do not contain the same things",
	metadata_missing: "Pages missing a title or description",
	metadata_duplicated: "One title or description on several pages",
	canonical_missing: "Pages declaring no canonical URL",
	canonical_conflicting: "Canonical tags that disagree",
	canonical_target_broken: "Canonical pointing somewhere broken",
	noindex_present: "Pages asking not to be indexed",
	content_duplicated: "One page's content at several URLs",
	link_broken: "Links to a page that does not load",
	certificate_problem: "Certificate problems",
	security_header_contradiction:
		"Security headers the site disagrees with itself about",
	sitemap_url_failed: "Sitemap URLs that do not load",
	page_missing_from_sitemap: "Live pages the sitemap does not list",
	robots_blocks_indexable: "robots.txt blocks a page the sitemap submits",
	page_orphaned: "Pages the sitemap lists that nothing links to",
	link_external_broken: "Links to other sites that are gone",
	redirect_chain: "Redirects that go through several hops, or in circles",
};

/** Security headers in the reader's words, the same split `FIELD_LABEL` makes. */
const HEADER_LABEL: Record<string, string> = {
	"strict-transport-security": "HSTS (Strict-Transport-Security)",
	"content-security-policy": "Content-Security-Policy",
	"x-frame-options": "X-Frame-Options",
	"x-content-type-options": "X-Content-Type-Options",
	"referrer-policy": "Referrer-Policy",
	"permissions-policy": "Permissions-Policy",
};

/** What each certificate problem means, in a sentence the reader can act on. */
const CERTIFICATE_LABEL: Record<string, string> = {
	expired: "has expired",
	expiring_soon: "expires soon",
	hostname_mismatch: "was issued for a different hostname",
	untrusted_chain:
		"could not be verified — the chain is incomplete or untrusted",
};

/**
 * The two channels a robots directive travels on, in the reader's words.
 *
 * Naming the channel is the whole instruction: the fix is to edit a template or
 * a server config, and which one differs entirely by channel. "Header" alone
 * would leave them looking for it in the page source.
 */
const CHANNEL_LABEL: Record<string, string> = {
	markup: "the page markup",
	header: "the X-Robots-Tag response header",
};

/**
 * Metadata fields in the reader's words.
 *
 * The stored value is the markup's name for the thing; what to call it on
 * screen is a presentation decision, the same split `MARKER_LABEL` makes.
 */
const FIELD_LABEL: Record<string, string> = {
	title: "title",
	description: "meta description",
};

/** Block types in the reader's words, for the structure comparison. */
const BLOCK_LABEL: Record<string, string> = {
	heading: "headings",
	form: "a form",
	table: "a table",
	media: "images or video",
	list: "a list",
};

/**
 * Marker kinds in the reader's words.
 *
 * The stored value is a slug so that a run recorded today still means the same
 * thing when read back later; what to call it on screen is a presentation
 * decision and belongs here.
 */
const MARKER_LABEL: Record<string, string> = {
	lorem_ipsum: "placeholder text (lorem ipsum)",
	unrendered_expression: "an unrendered template expression",
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
	/**
	 * Null means "follow the latest run", which is the state the panel had before
	 * history existed and the state it returns to when a new check starts. An
	 * explicit id means the reader chose to look backwards.
	 */
	const [pinnedRunId, setPinnedRunId] = useState<string | null>(null);
	const utils = api.useUtils();

	/**
	 * Polling tracks the *latest* run regardless of what is being viewed. A crawl
	 * in progress has to keep reporting its page count even while the reader is
	 * looking at last week's run, and the start control's precondition is about
	 * the latest run, not the selected one.
	 */
	const latestRun = api.project.latestRun.useQuery(
		{ projectId },
		{
			refetchInterval: (query) => {
				const status = query.state.data?.status;
				return status && ACTIVE_STATUSES.has(status) ? 1_500 : false;
			},
		},
	);

	const latest = latestRun.data;
	const latestActive = latest ? ACTIVE_STATUSES.has(latest.status) : false;

	const history = api.project.runs.useQuery(
		{ projectId },
		{ enabled: Boolean(latest) },
	);

	const selectedRunId = pinnedRunId ?? latest?.id ?? null;
	const viewingLatest = selectedRunId === latest?.id;

	/**
	 * The run being shown. Taken from the history list when one is pinned, so the
	 * panel's stats describe the run whose findings are below them rather than
	 * whichever run happens to be newest.
	 */
	const run = viewingLatest
		? latest
		: (history.data?.find((r) => r.id === selectedRunId) ?? latest);

	const isActive = viewingLatest && latestActive;
	const settled = Boolean(run) && !isActive;

	const findings = api.project.findings.useQuery(
		{ runId: selectedRunId ?? "" },
		{ enabled: settled },
	);

	const pages = api.project.runPages.useQuery(
		{ runId: selectedRunId ?? "" },
		{ enabled: settled },
	);

	/**
	 * What changed since the run before this one.
	 *
	 * A separate query from `findings` rather than a replacement for it: the
	 * findings list must render even when the comparison declines, so the view
	 * never depends on a comparison it may not be allowed to make.
	 */
	const comparison = api.project.comparison.useQuery(
		{ runId: selectedRunId ?? "" },
		{ enabled: settled },
	);

	/**
	 * The comparison carries the same current findings the plain query does, plus
	 * the resolved ones. It leads, and `findings` stands in until it arrives or if
	 * it fails — the results must render whether or not a comparison was possible.
	 */
	const annotated = useMemo(
		() =>
			comparison.data?.findings ??
			(findings.data ?? []).map((finding) => ({
				...finding,
				status: null as FindingStatus | null,
			})),
		[comparison.data, findings.data],
	);

	const { present, resolved } = useMemo(
		() => splitResolved(annotated),
		[annotated],
	);

	const statuses = useMemo(() => statusIndex(annotated), [annotated]);

	const state = comparisonState(comparison.data?.comparability ?? null);

	/**
	 * The domain rule, run over rows the queries already fetched.
	 *
	 * Read time rather than at detection: the rule is young, and freezing its
	 * output into the run would mean every improvement to it left old runs
	 * describing a site by a rule nobody would write today. Cheap enough that the
	 * question does not arise — a few hundred findings against a few hundred
	 * pages, with a hash lookup per URL.
	 *
	 * Over the findings this run still has, never the resolved ones. Folding a
	 * fixed problem in with live ones would put an edit the reader no longer has
	 * to make in the section that exists to tell them what to do.
	 */
	const correlated = useMemo(
		() => correlate(present, pages.data ?? []),
		[present, pages.data],
	);

	const startRun = api.project.startRun.useMutation({
		onMutate: () => setStartError(null),
		onSuccess: async () => {
			/**
			 * Following the new run is the whole point of having started it. A reader
			 * who was looking at history and pressed the button would otherwise watch
			 * an old run while the new one crawled invisibly.
			 */
			setPinnedRunId(null);
			await utils.project.latestRun.invalidate({ projectId });
			await utils.project.runs.invalidate({ projectId });
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
				{/*
				 * Gated on the *latest* run, not the one being viewed. Reading an older
				 * run while a crawl is live must not re-enable the control — the server
				 * would refuse the second run, and the reader would have been invited
				 * to press a button that could only fail.
				 */}
				<button
					className="rounded-sm bg-ink px-5 py-2.5 font-medium text-paper text-sm transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-35"
					disabled={latestRun.isPending || latestActive || startRun.isPending}
					onClick={() => startRun.mutate({ projectId })}
					type="button"
				>
					{latestActive ? "Check in progress…" : "Run a check"}
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
					{/*
					 * Findings are worked out in one pass after the crawl, so during it
					 * there is no number to show. Displaying zero would be a claim, and
					 * a wrong one — an em dash says "not yet", which is the truth.
					 */}
					<Stat label="Findings" value={isActive ? "—" : run.findingsCount} />
					<Stat label="Started" value={formatTime(run.startedAt)} />
					<Stat label="Duration" value={formatDuration(run)} />
				</dl>
			) : null}

			{run?.error ? (
				<p className="mt-6 border-flag border-l-2 bg-flag-soft px-4 py-3 text-flag text-sm">
					{run.error}
				</p>
			) : null}

			<RunHistory
				onSelect={setPinnedRunId}
				runs={history.data ?? []}
				selectedRunId={selectedRunId}
				statusLabel={STATUS_LABEL}
				statusStyle={STATUS_STYLE}
			/>

			{/*
			 * Why no comparison is shown. An unexplained absence is what makes people
			 * stop trusting a tool, so the refusal names the precondition that failed
			 * — and the run's own findings still render underneath it.
			 */}
			{settled && state.kind === "refused" ? (
				<div className="mt-8 border-flag border-l-2 bg-flag-soft px-4 py-3">
					<p className="font-medium text-flag text-sm">
						{REASON_HEADING[state.reason]}
					</p>
					<p className="mt-1 max-w-prose text-flag text-sm leading-relaxed">
						{REASON_SENTENCE[state.reason]}
					</p>
				</div>
			) : null}

			{settled && pages.data && pages.data.length > 0 ? (
				<ParityGrid expectedLocales={expectedLocales} pages={pages.data} />
			) : null}

			{settled && correlated.problems.length > 0 ? (
				<Problems problems={correlated.problems} statuses={statuses} />
			) : null}

			{/*
			 * The list below shows what was not folded into a problem, so that every
			 * finding appears exactly once. It is skipped entirely when correlation
			 * accounted for all of them — otherwise its own empty state would read
			 * "Nothing found" on a run that found plenty.
			 */}
			{settled &&
			(correlated.remainder.length > 0 || correlated.problems.length === 0) ? (
				<Findings
					isLoading={findings.isLoading}
					items={correlated.remainder}
					runFailed={run?.status === "failed" || run?.status === "interrupted"}
					statuses={statuses}
				/>
			) : null}

			{/*
			 * What is no longer wrong, kept apart from what still is.
			 *
			 * Below the live findings and visually quieter, because a fixed page must
			 * not compete for attention with a broken one — that inversion is the
			 * thing this whole slice exists to prevent.
			 */}
			{settled && resolved.length > 0 ? <Resolved items={resolved} /> : null}

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

/**
 * Why a problem's findings are one problem, said in words.
 *
 * The requirement is that the product *infers* a shared cause and says so, not
 * that it collates. "28 findings" is a grouping; "one page family emits all of
 * these" is the claim, and a reader who disagrees with it can see what it rests
 * on and dismiss it. The vocabulary is deliberately three sentences long,
 * because three is how many relationships the evidence can actually support.
 *
 * None of them names the defect. That the language switcher builds its sibling
 * URLs from the wrong slug is true, and is our diagnosis rather than anything
 * the site asserted — so the product stops at what it can stand behind.
 */
function problemSentence(problem: CorrelatedProblem): string {
	const families = problem.families.length;
	const pages = problem.originPages.length;

	switch (problem.shape) {
		case "one-family":
			return "One page family emits all of these";
		case "family-set":
			return `The same ${families} page families exhibit all of these`;
		case "same-pages":
			return `The same ${pages} ${pages === 1 ? "page" : "pages"} emit all of these`;
	}
}

function Problems({
	problems,
	statuses,
}: {
	problems: CorrelatedProblem[];
	statuses: Map<string, FindingStatus | null>;
}) {
	return (
		<section className="mt-12">
			<header className="flex flex-wrap items-baseline justify-between gap-3">
				<h2 className="font-display font-semibold text-ink text-xl">
					Problems
				</h2>
				<p className="tnum text-ink-faint text-xs">
					{problems.length} {problems.length === 1 ? "problem" : "problems"}
				</p>
			</header>

			<p className="mt-2 max-w-prose text-ink-soft text-sm leading-relaxed">
				Findings the site's own language declarations say share a cause,
				reported once. Each is listed here instead of below, so nothing appears
				twice.
			</p>

			<div className="mt-6 flex flex-col gap-8">
				{problems.map((problem) => {
					const where = summariseList(problem.originPages);

					/**
					 * How much of this problem is new.
					 *
					 * A known problem that has spread reads differently from one that
					 * appeared whole, and the per-finding marks alone would make the
					 * reader count. Silent when the answer is all or none, since the
					 * badge beside it already says so.
					 */
					const added = newCount(
						problem.findings.map((f) => f.id),
						statuses,
					);
					const spread = spreadSentence(added, problem.findings.length);
					const entirelyNew = added > 0 && added === problem.findings.length;

					return (
						<article className="border-rule border-l-2 pl-5" key={problem.key}>
							<h3 className="flex flex-wrap items-baseline gap-x-3 font-display font-semibold text-base text-ink">
								{problemSentence(problem)}
								{entirelyNew ? <StatusMark status="new" /> : null}
								<span className="tnum font-mono font-normal text-ink-faint text-xs">
									{problem.findings.length} findings
									{" · "}
									{problem.originPages.length}{" "}
									{problem.originPages.length === 1 ? "page" : "pages"} to edit
									{spread ? ` · ${spread}` : ""}
								</span>
							</h3>

							{/*
							 * Where the work is. A template fault can put every page of every
							 * family behind one problem, so the list is capped for the same
							 * reason the finding evidence is — one problem must not push the
							 * rest off the screen.
							 */}
							<ul className="mt-3 flex flex-col gap-1">
								{where.shown.map((url) => (
									<li
										className="break-all font-mono text-ink text-xs"
										key={url}
									>
										{url}
									</li>
								))}
								{where.hidden > 0 ? (
									<li className="text-ink-faint text-xs">
										and {where.hidden} more
									</li>
								) : null}
							</ul>

							{/*
							 * The findings themselves, rendered exactly as they read in the
							 * list below. A reader who distrusts the grouping still gets the
							 * evidence as it was filed.
							 */}
							<ul className="mt-4 divide-y divide-rule-soft border-rule-soft border-t">
								{problem.findings.map((finding) => (
									<li className="py-3 text-sm" key={finding.id}>
										<span className="mr-2 font-mono text-ink-faint text-xs">
											{FINDING_LABEL[finding.type] ?? finding.type}
										</span>
										<Evidence detail={finding.detail} type={finding.type} />
									</li>
								))}
							</ul>
						</article>
					);
				})}
			</div>
		</section>
	);
}

type FindingRow = {
	id: string;
	type: string;
	detail: Record<string, unknown>;
};

/**
 * The mark on a finding that changed since the previous run.
 *
 * Only `new` is marked. "Still present" is the ordinary case and marking it
 * would put a badge on almost every row, which spends the reader's attention on
 * the one thing that needs none — the same reasoning that leaves a finished run
 * uncoloured above.
 */
function StatusMark({ status }: { status: FindingStatus | null | undefined }) {
	if (status !== "new") return null;

	return (
		<span className="rounded-full border border-mark/30 bg-mark-soft px-2 py-0.5 font-mono text-[11px] text-mark uppercase tracking-wider">
			New
		</span>
	);
}

function Findings({
	items,
	isLoading,
	runFailed,
	statuses,
}: {
	items: FindingRow[];
	isLoading: boolean;
	runFailed: boolean;
	statuses: Map<string, FindingStatus | null>;
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
							<li className="flex items-start gap-3 py-4 text-sm" key={row.id}>
								<div className="min-w-0 flex-1">
									<Evidence detail={row.detail} type={row.type} />
								</div>
								<StatusMark status={statuses.get(row.id)} />
							</li>
						))}
					</ul>
				</div>
			))}
		</div>
	);
}

/**
 * Findings the previous run had and this one does not.
 *
 * Rendered from the previous run's rows, since there is no current row to
 * render — they are the half of "what changed" that exists only in the older
 * run. Grouped by type like the live list, and deliberately plainer: this is
 * the section a reader confirms and moves on from.
 */
function Resolved({ items }: { items: FindingRow[] }) {
	const byType = new Map<string, FindingRow[]>();
	for (const item of items) {
		byType.set(item.type, [...(byType.get(item.type) ?? []), item]);
	}

	return (
		<div className="mt-14 border-rule border-t pt-8">
			<h2 className="font-display font-semibold text-ink text-xl">
				No longer reported
				<span className="ml-3 font-mono font-normal text-ink-faint text-xs">
					{items.length} {items.length === 1 ? "finding" : "findings"}
				</span>
			</h2>
			<p className="mt-2 max-w-prose text-ink-soft text-sm leading-relaxed">
				Present in the previous run and absent from this one. Both runs covered
				the same site under the same scope, so these are changes on the site
				rather than differences in what was checked.
			</p>

			<div className="mt-8 flex flex-col gap-8 opacity-75">
				{[...byType.entries()].map(([type, rows]) => (
					<div key={type}>
						<h3 className="flex flex-wrap items-baseline gap-x-3 border-rule-soft border-b pb-2 font-display font-semibold text-base text-ink-soft">
							{FINDING_LABEL[type] ?? type}
							<span className="tnum font-mono font-normal text-ink-faint text-xs">
								{rows.length} {rows.length === 1 ? "finding" : "findings"}
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

		case "content_untranslated": {
			if (detail.kind === "identical_to_siblings") {
				const urls = Array.isArray(detail.urls)
					? (detail.urls as string[])
					: [];
				const locales = Array.isArray(detail.locales)
					? (detail.locales as string[])
					: [];

				return (
					<>
						<span className="text-ink">
							{urls.length} pages serve the same content under different
							languages
						</span>
						<div className="mt-1.5 flex flex-wrap gap-1">
							{locales.map((locale) => (
								<Tag key={locale} tone="flag">
									{locale}
								</Tag>
							))}
						</div>
						<Listed items={urls.map(pathOf)} />
					</>
				);
			}

			const markers = Array.isArray(detail.markers)
				? (detail.markers as string[])
				: [];

			return (
				<>
					<span className="text-ink">
						This page shows{" "}
						{markers.map((m) => MARKER_LABEL[m] ?? m).join(", ")}
					</span>
					<div className="mt-1.5 break-all font-mono text-ink-soft text-xs">
						{pathOf(str("url"))}
					</div>
				</>
			);
		}

		case "content_structure_differs": {
			const differences = Array.isArray(detail.differences)
				? (detail.differences as Array<Record<string, unknown>>)
				: [];
			const members = Array.isArray(detail.memberUrls)
				? (detail.memberUrls as string[])
				: [];

			/**
			 * Both sides of each difference, and no culprit. With two members there
			 * is no basis to say which is wrong, and the editors know which way the
			 * content was meant to go.
			 */
			const lines = differences.map((difference) => {
				const block = String(difference.block ?? "?");
				const present = Array.isArray(difference.present)
					? (difference.present as string[])
					: [];
				const absent = Array.isArray(difference.absent)
					? (difference.absent as string[])
					: [];

				return `${BLOCK_LABEL[block] ?? block} — on ${present
					.map(pathOf)
					.join(", ")}; not on ${absent.map(pathOf).join(", ")}`;
			});

			return (
				<>
					<span className="text-ink">
						{members.length} variants of this page do not contain the same
						things
					</span>
					<Listed items={lines} />
				</>
			);
		}

		case "metadata_missing": {
			const fields = Array.isArray(detail.fields)
				? (detail.fields as string[])
				: [];

			return (
				<>
					<span className="text-ink">
						This page publishes no{" "}
						{fields
							.map((field) => FIELD_LABEL[field] ?? field)
							.join(" and no ")}
					</span>
					<div className="mt-1.5 break-all font-mono text-ink-soft text-xs">
						{pathOf(str("url"))}
					</div>
				</>
			);
		}

		case "metadata_duplicated": {
			const urls = Array.isArray(detail.urls) ? (detail.urls as string[]) : [];
			const field = str("field") ?? "";
			/**
			 * Null when nothing established a language for these pages — the bucket a
			 * monolingual site falls into. Rendered as its own sentence rather than as
			 * a tag reading "?", which looks like data we failed to load rather than a
			 * fact about the site.
			 */
			const language = str("language");

			/**
			 * The shared string itself, quoted. Which pages and which field are only
			 * half an instruction — the reader has to know *what* they are looking
			 * for before opening any of them, and the value is the thing they will
			 * search their CMS for.
			 */
			return (
				<>
					<span className="text-ink">
						{urls.length}{" "}
						{language ? (
							<>
								<Tag tone="flag">{language}</Tag>{" "}
							</>
						) : null}
						pages share one {FIELD_LABEL[field] ?? field}
					</span>
					{language ? null : (
						<div className="mt-1.5 text-ink-faint text-xs">
							No language established for these pages
						</div>
					)}
					<div className="mt-1.5 max-w-prose text-ink-soft text-xs italic">
						“{str("value")}”
					</div>
					<Listed items={urls.map(pathOf)} />
				</>
			);
		}

		case "canonical_missing": {
			const declaring = Number(detail.pagesDeclaringCanonical ?? 0);

			/**
			 * The narrowing's evidence, on screen. A canonical tag is optional, so
			 * "this page has none" is only a defect next to the fact that the site
			 * publishes them elsewhere — and a reader who cannot see that half is
			 * being asked to take the finding on trust.
			 */
			return (
				<>
					<span className="text-ink">
						This page declares no canonical URL, on a site that declares one on{" "}
						{declaring} other {declaring === 1 ? "page" : "pages"}
					</span>
					<div className="mt-1.5 break-all font-mono text-ink-soft text-xs">
						{pathOf(str("url"))}
					</div>
				</>
			);
		}

		case "canonical_conflicting": {
			if (detail.kind === "chain") {
				/**
				 * All three URLs. A chain is only legible as a sequence: the page, what
				 * it nominated, and what that nominated in turn — and the fix is
				 * usually to point the first straight at the last.
				 */
				return (
					<>
						<span className="text-ink">
							This page's canonical is itself not canonical
						</span>
						<div className="mt-1.5 break-all font-mono text-ink-soft text-xs">
							{pathOf(str("url"))}
							<div className="text-ink-faint">
								→ {pathOf(str("canonical"))} → {pathOf(str("targetCanonical"))}
							</div>
						</div>
					</>
				);
			}

			const canonicals = Array.isArray(detail.canonicals)
				? (detail.canonicals as string[])
				: [];

			return (
				<>
					<span className="text-ink">
						This page declares {canonicals.length} different canonical URLs
					</span>
					<div className="mt-1.5 break-all font-mono text-ink-soft text-xs">
						{pathOf(str("url"))}
					</div>
					<Listed items={canonicals.map(pathOf)} />
				</>
			);
		}

		case "canonical_target_broken":
			return (
				<>
					<span className="text-ink">
						{detail.kind === "unreached" ? (
							<>This page's canonical was never reached</>
						) : (
							<>
								This page's canonical returns{" "}
								{String(detail.httpStatus ?? detail.fetchError ?? "an error")}
							</>
						)}
					</span>
					<div className="mt-1.5 break-all font-mono text-ink-soft text-xs">
						{pathOf(str("canonical"))}
						<div className="text-ink-faint">
							declared by {pathOf(str("url"))}
						</div>
					</div>
				</>
			);

		case "noindex_present": {
			const sources = Array.isArray(detail.sources)
				? (detail.sources as Array<Record<string, unknown>>)
				: [];
			const indexing = Array.isArray(detail.indexingChannels)
				? (detail.indexingChannels as string[])
				: [];

			/**
			 * One line per source, naming the channel, the word found, and the
			 * crawler when the directive was scoped to one. A reader has to know
			 * which file to open, and a `googlebot`-scoped directive has a different
			 * blast radius from a generic one.
			 */
			const lines = sources.map((source) => {
				const channel = String(source.channel ?? "");
				const crawler = source.crawler;
				const scope =
					typeof crawler === "string" ? ` (scoped to ${crawler})` : "";

				return `${CHANNEL_LABEL[channel] ?? channel}${scope} — ${String(
					source.directive ?? "noindex",
				)}`;
			});

			return (
				<>
					<span className="text-ink">
						This page asks search engines not to index it
					</span>
					<Listed items={lines} />
					{indexing.length > 0 ? (
						/**
						 * The disagreement, stated rather than left implicit. It is why
						 * nobody noticed: everyone reading the page source saw `index`,
						 * and the channel that actually deindexed the page is one they
						 * cannot see.
						 */
						<div className="mt-2 text-flag text-xs">
							…while{" "}
							{indexing
								.map((channel) => CHANNEL_LABEL[channel] ?? channel)
								.join(" and ")}{" "}
							asks for it to be indexed
						</div>
					) : null}
					<div className="mt-1.5 break-all font-mono text-ink-soft text-xs">
						{pathOf(str("url"))}
					</div>
				</>
			);
		}

		case "content_duplicated": {
			const urls = Array.isArray(detail.urls) ? (detail.urls as string[]) : [];
			const length = Number(detail.textLength ?? 0);

			/**
			 * The length of the shared text, not the text itself — the crawl keeps a
			 * digest and never the words. It is still the number that decides how
			 * seriously to take the finding: three hundred identical characters is a
			 * stub, three thousand is a page published twice.
			 */
			return (
				<>
					<span className="text-ink">
						{urls.length} URLs serve the same content
					</span>
					<div className="mt-1.5 text-ink-soft text-xs">
						{length.toLocaleString()} characters, identical on every one
					</div>
					<Listed items={urls.map(pathOf)} />
				</>
			);
		}

		case "link_broken":
		case "link_external_broken": {
			const linkedFrom = Array.isArray(detail.linkedFrom)
				? (detail.linkedFrom as string[])
				: [];
			const status = detail.httpStatus;

			/**
			 * The target first, then the pages to edit. A broken link is the one
			 * finding here whose fix is not on the page it names — the dead URL may be
			 * gone on purpose, and what has to change is every page still pointing at
			 * it.
			 */
			return (
				<>
					<span className="text-ink">
						<Tag tone="mark">
							{typeof status === "number" ? status : "no response"}
						</Tag>{" "}
						{pathOf(str("target"))}
					</span>
					<div className="mt-1.5 text-ink-soft text-xs">
						{detail.confirmed === true
							? "Failed twice, asked again after the crawl"
							: null}
						{detail.confirmed === true ? " · " : null}
						Linked from {linkedFrom.length}{" "}
						{linkedFrom.length === 1 ? "page" : "pages"}
					</div>
					<Listed items={linkedFrom.map(pathOf)} />
				</>
			);
		}

		case "certificate_problem": {
			const kind = str("kind") ?? "";
			const days = detail.daysRemaining;

			/**
			 * The expiry date itself, always, whatever the kind. The thirty-day
			 * window is a cadence most of the web happens to run on rather than a
			 * law, so a reader on a different one needs the date to judge from.
			 */
			return (
				<>
					<span className="text-ink">
						The certificate for {str("origin")}{" "}
						{CERTIFICATE_LABEL[kind] ?? kind}
					</span>
					<div className="mt-1.5 text-ink-soft text-xs">
						{str("validTo") ? `Valid until ${str("validTo")}` : null}
						{typeof days === "number"
							? ` · ${days < 0 ? `${-days} days ago` : `${days} days from now`}`
							: null}
					</div>
					{str("issuer") ? (
						<div className="mt-1 text-ink-faint text-xs">
							Issued by {str("issuer")}
						</div>
					) : null}
				</>
			);
		}

		case "security_header_contradiction": {
			const affected = Array.isArray(detail.affectedUrls)
				? (detail.affectedUrls as string[])
				: [];
			const header = str("header") ?? "";
			const malformed = detail.kind === "malformed";

			return (
				<>
					<span className="text-ink">
						<Tag tone="flag">{HEADER_LABEL[header] ?? header}</Tag>{" "}
						{malformed
							? `published with a value that cannot be read, on ${affected.length} ${
									affected.length === 1 ? "page" : "pages"
								}`
							: `missing from ${affected.length} ${
									affected.length === 1 ? "page" : "pages"
								} the site sends it on elsewhere`}
					</span>
					{malformed ? (
						<div className="mt-1.5 max-w-prose break-all text-ink-soft text-xs italic">
							“{str("value")}”
						</div>
					) : (
						<div className="mt-1.5 text-ink-soft text-xs">
							Sent on {Number(detail.pagesPublishing ?? 0)} other pages
						</div>
					)}
					<Listed items={affected.map(pathOf)} />
				</>
			);
		}

		case "sitemap_url_failed": {
			const entries = Array.isArray(detail.entries)
				? (detail.entries as Array<Record<string, unknown>>)
				: [];

			return (
				<>
					<span className="text-ink">
						{entries.length} {entries.length === 1 ? "URL" : "URLs"} in the
						sitemap did not load
					</span>
					<Listed
						items={entries.map(
							(entry) =>
								`${pathOf(entry.normalised)} — ${
									typeof entry.httpStatus === "number"
										? entry.httpStatus
										: "no response"
								}`,
						)}
					/>
				</>
			);
		}

		case "page_missing_from_sitemap": {
			const urls = Array.isArray(detail.urls) ? (detail.urls as string[]) : [];

			/**
			 * The sitemap's length beside the count, because "twelve pages are
			 * missing" reads very differently against a sitemap of fifteen than
			 * against one of five hundred.
			 */
			return (
				<>
					<span className="text-ink">
						{urls.length} live {urls.length === 1 ? "page" : "pages"} are absent
						from a sitemap of {Number(detail.sitemapEntryCount ?? 0)}
					</span>
					<Listed items={urls.map(pathOf)} />
				</>
			);
		}

		case "redirect_chain": {
			const hops = Array.isArray(detail.hops)
				? (detail.hops as Array<Record<string, unknown>>)
				: [];
			const linkedFrom = Array.isArray(detail.linkedFrom)
				? (detail.linkedFrom as string[])
				: [];
			const loop = detail.kind === "loop";

			/**
			 * The route drawn out, hop by hop with its status. A chain is a sequence,
			 * and naming only its ends would leave the reader to walk it themselves
			 * to find which redirect to delete.
			 */
			return (
				<>
					<span className="text-ink">
						{loop ? (
							<>
								<Tag tone="mark">loop</Tag> {pathOf(str("from"))} redirects back
								to itself
							</>
						) : (
							<>
								{hops.length} redirects from {pathOf(str("from"))} to{" "}
								{pathOf(str("to"))}
							</>
						)}
					</span>
					<Listed
						items={hops.map(
							(hop) =>
								`${pathOf(hop.url)} → ${pathOf(hop.location)} (${
									typeof hop.status === "number" ? hop.status : "?"
								})`,
						)}
					/>
					{linkedFrom.length > 0 ? (
						<>
							<div className="mt-1.5 text-ink-soft text-xs">
								Still linked from {linkedFrom.length}{" "}
								{linkedFrom.length === 1 ? "page" : "pages"}
							</div>
							<Listed items={linkedFrom.map(pathOf)} />
						</>
					) : null}
				</>
			);
		}

		case "page_orphaned": {
			const urls = Array.isArray(detail.urls) ? (detail.urls as string[]) : [];

			/**
			 * Named as unreachable by navigation rather than as broken. The pages
			 * load; what is missing is any route a reader could take to them, which
			 * is a different fix from a dead link and belongs in different words.
			 */
			return (
				<>
					<span className="text-ink">
						{urls.length} {urls.length === 1 ? "page" : "pages"} in the sitemap
						with nothing linking to {urls.length === 1 ? "it" : "them"}
					</span>
					<Listed items={urls.map(pathOf)} />
				</>
			);
		}

		case "robots_blocks_indexable": {
			const urls = Array.isArray(detail.urls) ? (detail.urls as string[]) : [];

			/**
			 * The verbatim rule and the group it addresses. The whole finding is a
			 * quotation — the site said both of these things — so the line it said
			 * one of them on is the substance, not decoration.
			 */
			return (
				<>
					<span className="text-ink">
						<Tag tone="mark">{str("ruleLine")}</Tag> blocks {urls.length}{" "}
						{urls.length === 1 ? "URL" : "URLs"} the sitemap submits
					</span>
					<div className="mt-1.5 text-ink-soft text-xs">
						robots.txt line {Number(detail.ruleLineNumber ?? 0)}, in the{" "}
						<code className="font-mono">{str("userAgentGroup")}</code> group
					</div>
					<Listed items={urls.map(pathOf)} />
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
