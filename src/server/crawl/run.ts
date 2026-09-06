import { and, eq, inArray, sql } from "drizzle-orm";

import type { db as database } from "~/server/db";
import {
	findings,
	pageObservations,
	pageSnapshots,
	pages,
	projects,
	runs,
} from "~/server/db/schema";
import { crawl } from "./crawler";
import { detectMissingVariants, FINDING_TYPES } from "./findings";
import { renderSample, SNAPSHOT_VIEWPORT } from "./render";
import { expireSnapshots } from "./retention";
import { chooseRenderSample, countInboundLinks } from "./sample";
import { inScopePath } from "./scope";
import { groupVariants } from "./variants";

/**
 * The run lifecycle.
 *
 * Nothing outside this module writes `runs.status`. Every transition lives here
 * so there is one place to reason about what a given status means and one place
 * a bug in that reasoning can hide.
 *
 *   queued → running → done
 *                    → failed       (the crawl aborted, reason recorded)
 *                    → interrupted  (the process died; closed by the boot sweep)
 *
 * The work happens in-process rather than in a queue. That is a deliberate
 * trade: no new infrastructure, identical behaviour in development and in a
 * container, and the run row that has to exist anyway doubles as the job's
 * state. What it costs is durability — a restart mid-crawl orphans the run,
 * which `sweepStaleRuns` handles by closing it rather than resuming it.
 */

type Database = typeof database;

export const RUN_STATUS = {
	QUEUED: "queued",
	RUNNING: "running",
	DONE: "done",
	FAILED: "failed",
	INTERRUPTED: "interrupted",
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

/** Statuses that mean the run is still owned by a live process. */
const ACTIVE: RunStatus[] = [RUN_STATUS.QUEUED, RUN_STATUS.RUNNING];

/** Ceiling on pages per run, so a misconfigured scope cannot run away. */
const MAX_PAGES = 2_000;

export class RunAlreadyActiveError extends Error {
	constructor() {
		super("A run is already in progress for this project.");
		this.name = "RunAlreadyActiveError";
	}
}

/**
 * Starts a run and returns its id **before** any crawling begins.
 *
 * The ordering is load-bearing. Crawling first and recording afterwards would
 * leave a window in which work is happening with nothing to attribute it to —
 * invisible to the stale sweep, unreportable, and impossible to stop.
 *
 * The returned promise resolves once the run row exists; the crawl continues in
 * the background. Callers that want to wait for completion should poll the run.
 */
export async function startRun(
	db: Database,
	input: {
		tenantId: string;
		projectId: string;
		/** See {@link runToCompletion}. Zero skips the render pass. */
		maxRenders?: number;
		/**
		 * Whether the render pass also photographs the pages it visits.
		 *
		 * Defaults to on: capture is what the visual half is for, and a run that
		 * quietly stopped taking pictures would leave a project's baseline slowly
		 * ageing out with nothing saying why. The flag exists so the test suite can
		 * exercise the render pass without paying for a full-page encode, and so a
		 * case can prove that no picture means no row.
		 */
		captureSnapshots?: boolean;
	},
): Promise<{ runId: string }> {
	const { tenantId, projectId } = input;

	const active = await db.query.runs.findFirst({
		where: and(
			eq(runs.tenantId, tenantId),
			eq(runs.projectId, projectId),
			inArray(runs.status, ACTIVE),
		),
	});
	if (active) throw new RunAlreadyActiveError();

	const project = await db.query.projects.findFirst({
		where: and(eq(projects.tenantId, tenantId), eq(projects.id, projectId)),
	});
	if (!project) throw new Error("Project not found for this tenant.");

	const [run] = await db
		.insert(runs)
		.values({ tenantId, projectId, status: RUN_STATUS.QUEUED })
		.returning();
	if (!run) throw new Error("Failed to create the run.");

	// Deliberately not awaited: the caller gets the id immediately.
	void execute(db, run.id, project, input).catch(async (caught) => {
		await db
			.update(runs)
			.set({
				status: RUN_STATUS.FAILED,
				finishedAt: new Date(),
				error: caught instanceof Error ? caught.message : String(caught),
			})
			.where(eq(runs.id, run.id));
	});

	return { runId: run.id };
}

/** Awaits the crawl instead of backgrounding it. Used by tests. */
export async function runToCompletion(
	db: Database,
	input: {
		tenantId: string;
		projectId: string;
		/**
		 * How many pages this run may render, overriding the default cap.
		 *
		 * Zero skips the render pass entirely, and exists for the test suite: a
		 * browser costs seconds per page, and the twenty-odd run-level cases that
		 * are about crawling, comparison or tenancy should not each pay for one.
		 * The pass has its own tests; making every unrelated case launch Chromium
		 * would buy no coverage and cost minutes.
		 *
		 * Not exposed to users — see the plan's note on why a per-project toggle
		 * would be a switch nobody can flip.
		 */
		maxRenders?: number;
		/**
		 * Whether the render pass also photographs the pages it visits.
		 *
		 * Defaults to on: capture is what the visual half is for, and a run that
		 * quietly stopped taking pictures would leave a project's baseline slowly
		 * ageing out with nothing saying why. The flag exists so the test suite can
		 * exercise the render pass without paying for a full-page encode, and so a
		 * case can prove that no picture means no row.
		 */
		captureSnapshots?: boolean;
	},
): Promise<{ runId: string }> {
	const { tenantId, projectId } = input;

	const project = await db.query.projects.findFirst({
		where: and(eq(projects.tenantId, tenantId), eq(projects.id, projectId)),
	});
	if (!project) throw new Error("Project not found for this tenant.");

	const [run] = await db
		.insert(runs)
		.values({ tenantId, projectId, status: RUN_STATUS.QUEUED })
		.returning();
	if (!run) throw new Error("Failed to create the run.");

	await execute(db, run.id, project, input);
	return { runId: run.id };
}

type ProjectRow = typeof projects.$inferSelect;

async function execute(
	db: Database,
	runId: string,
	project: ProjectRow,
	options: { maxRenders?: number; captureSnapshots?: boolean } = {},
): Promise<void> {
	const { maxRenders, captureSnapshots = true } = options;
	await db
		.update(runs)
		.set({ status: RUN_STATUS.RUNNING, startedAt: new Date() })
		.where(eq(runs.id, runId));

	/**
	 * The same scope the crawler applied, so the rules cannot disagree with it.
	 *
	 * This was a second copy of the predicate, and a copy is how the two drift:
	 * a rule that thinks a URL was in scope while the crawler never requested it
	 * reports a page as unreachable when the truth is that we never looked.
	 */
	const inScope = (url: string): boolean => {
		let path: string;
		try {
			path = new URL(url).pathname;
		} catch {
			return false;
		}
		return inScopePath(path, project.includePaths, project.excludePaths);
	};

	/**
	 * Pages are written as the crawl produces them, not batched at the end, so an
	 * aborted run still shows what it managed and memory stays flat across a
	 * large crawl. Locale and group key are filled in afterwards — grouping needs
	 * the whole set before it can decide anything.
	 */
	const result = await crawl({
		startUrl: project.startUrl,
		includePaths: project.includePaths,
		excludePaths: project.excludePaths,
		maxConcurrency: project.maxConcurrency,
		requestDelayMs: project.requestDelayMs,
		maxPages: MAX_PAGES,
		onPage: async (page) => {
			await db.insert(pages).values({
				tenantId: project.tenantId,
				runId,
				url: page.url,
				httpStatus: page.httpStatus,
				hreflangTargets: page.hreflangTargets,
				images: page.images,
				fetchError: page.fetchError,
			});

			/**
			 * Counted as it happens, so the interface has something true to show.
			 *
			 * The count was written once, at the end. Meanwhile the panel polled
			 * every 1.5s and displayed a duration computed against the current time —
			 * so it ticked convincingly beside a page count frozen at zero, and a
			 * long run was indistinguishable from a hung one.
			 *
			 * Incremented in SQL rather than read-then-written: workers run
			 * concurrently and two finishing together would otherwise lose a count.
			 */
			await db
				.update(runs)
				.set({ pagesCrawled: sql`${runs.pagesCrawled} + 1` })
				.where(eq(runs.id, runId));
		},
	});

	/**
	 * Statuses the crawl revised after asking again.
	 *
	 * Rows are written as pages arrive, which is what keeps memory flat and the
	 * progress count honest — but it means a page re-requested after the crawl
	 * drained has a row holding the first observation. Correcting them here rather
	 * than deferring the insert keeps both properties: the row appeared while the
	 * run was live, and it ends up saying what the crawl concluded.
	 */
	for (const entry of result.reverified) {
		await db
			.update(pages)
			.set({
				httpStatus: entry.second.httpStatus,
				fetchError: entry.second.fetchError,
			})
			.where(and(eq(pages.runId, runId), eq(pages.url, entry.url)));
	}

	const variants = groupVariants(result.pages);
	for (const variant of variants.values()) {
		await db
			.update(pages)
			.set({ locale: variant.locale, variantGroupKey: variant.groupKey })
			.where(and(eq(pages.runId, runId), eq(pages.url, variant.url)));
	}

	/**
	 * A run that stopped early cannot tell a missing page from an unvisited one,
	 * so the rules that reason from absence stay quiet.
	 *
	 * Named rather than inlined because it is now read twice: once by the rules
	 * below, and once by the run row, where it is what lets a later comparison
	 * decide whether this run may be compared at all. A comparison reasons from
	 * absence in exactly the same way — "this finding is gone" — so it needs the
	 * same answer, and a run that did not record one cannot be compared.
	 */
	const crawlComplete =
		result.abortedReason === null && !result.reachedPageLimit;

	/**
	 * What a browser saw, for the few pages the sample chose.
	 *
	 * After the crawl and before detection, because the console rule reads it —
	 * and deliberately wrapped so that nothing here can fail the run. A browser
	 * that will not launch is our problem; reporting it as the client's site
	 * failing would be the fourth entry in `lessons.md` written a fifth time.
	 */
	const inbound = countInboundLinks(result.pages);
	const sample = chooseRenderSample(
		result.pages.map((page) => ({
			url: page.url,
			/**
			 * The locale the run already derived for the pages table, not a second
			 * derivation. Two definitions of "this page is in that language" would
			 * eventually let the sample and the parity grid disagree on one screen.
			 */
			locale: variants.get(page.url)?.locale ?? null,
			httpStatus: page.httpStatus,
			fetchError: page.fetchError,
			isHtml: page.content.isHtml,
			inboundLinks: inbound.get(page.url) ?? 0,
		})),
		project.locales,
		result.entryUrl,
		maxRenders,
	);

	/**
	 * The page rows this run has already written, keyed by URL.
	 *
	 * Built once and read three times below — by the snapshot sink, by the
	 * findings insert and by the observations insert. The crawl writes a page row
	 * as each page arrives, so every one of them is already here; three separate
	 * queries for the same map was three chances for them to disagree.
	 */
	const pageIdByUrl = new Map(
		(
			await db.query.pages.findMany({
				where: eq(pages.runId, runId),
				columns: { id: true, url: true },
			})
		).map((page) => [page.url, page.id]),
	);

	/**
	 * A budget of zero means "do not render", and the pass is skipped rather than
	 * called with nothing — a browser launched to render an empty list would be
	 * seconds spent to learn what the caller already said.
	 */
	const render =
		maxRenders === 0
			? { observations: [], complete: true }
			: await renderSample({
					urls: sample.urls,
					origin: new URL(project.startUrl).origin,
					snapshot: captureSnapshots
						? {
								masks: project.maskSelectors,
								/**
								 * Written as each picture is taken rather than collected and
								 * inserted at the end, so a dozen full-page PNGs never sit in
								 * memory at once. Same reason the crawl writes page rows as it
								 * goes.
								 */
								onCapture: async (url, png, size) => {
									const pageId = pageIdByUrl.get(url);
									if (!pageId) return;

									await db.insert(pageSnapshots).values({
										tenantId: project.tenantId,
										runId,
										pageId,
										image: png,
										byteSize: png.byteLength,
										imageWidth: size.width,
										imageHeight: size.height,
										viewportWidth: SNAPSHOT_VIEWPORT.width,
										viewportHeight: SNAPSHOT_VIEWPORT.height,
										maskSelectors: project.maskSelectors,
									});
								},
							}
						: undefined,
				}).catch(() => ({ observations: [], complete: false }));

	const detected = detectMissingVariants({
		pages: result.pages,
		crawlComplete,
		expectedLocales: project.locales,
		inScope,
		reverified: result.reverified,
		certificate: result.certificate,
		robots: result.robots,
		sitemap: result.sitemap,
		entryUrl: result.entryUrl,
		requested: result.requested,
		external: result.external,
		imageWeights: result.imageWeights,
		render,
		aliases: result.aliases,
		/**
		 * A project that named the paths to check told the crawl not to visit the
		 * rest of its own site, and the orphan rule cannot reason from absence
		 * across a boundary it was told not to cross.
		 */
		scopeNarrowed: project.includePaths.length > 0,
	});

	if (detected.length > 0) {
		await db.insert(findings).values(
			detected.map((finding) => ({
				tenantId: project.tenantId,
				runId,
				type: finding.type,
				pageId: finding.url ? (pageIdByUrl.get(finding.url) ?? null) : null,
				detail: finding.detail,
			})),
		);
	}

	/**
	 * One row per measured page, and none for the rest.
	 *
	 * Absence is the representation: a page with no row was not measured, which
	 * is a different fact from a page that was measured and found nothing wrong.
	 * A row is written even when the render failed, because "this page timed out"
	 * and "this page was never in the sample" are also different facts, and a
	 * reader shown neither would assume the second.
	 */
	if (render.observations.length > 0) {
		const rows = render.observations.flatMap((observation) => {
			const pageId = pageIdByUrl.get(observation.url);
			if (!pageId) return [];

			return [
				{
					tenantId: project.tenantId,
					runId,
					pageId,
					ttfbMs:
						observation.vitals.ttfbMs === null
							? null
							: Math.round(observation.vitals.ttfbMs),
					lcpMs:
						observation.vitals.lcpMs === null
							? null
							: Math.round(observation.vitals.lcpMs),
					/** Text, so the precision the browser reported survives the round trip. */
					cls:
						observation.vitals.cls === null
							? null
							: String(observation.vitals.cls),
					firstPartyErrors: observation.firstPartyErrors,
					thirdPartyErrors: observation.thirdPartyErrors,
					samples: observation.samples,
					renderError: observation.renderError,
				},
			];
		});

		if (rows.length > 0) await db.insert(pageObservations).values(rows);
	}

	await db
		.update(runs)
		.set({
			status: result.abortedReason ? RUN_STATUS.FAILED : RUN_STATUS.DONE,
			finishedAt: new Date(),
			pagesCrawled: result.pages.length,
			findingsCount: detected.length,
			error: result.abortedReason,
			crawlComplete,
			reachedPageLimit: result.reachedPageLimit,
			/**
			 * From the project row this run was handed when it started, not a fresh
			 * read. An edit made while the crawl was in flight did not change what
			 * the crawl did, and the snapshot has to describe the crawl.
			 */
			scope: {
				includePaths: project.includePaths,
				excludePaths: project.excludePaths,
				locales: project.locales,
			},
			/**
			 * Derived from the rules this build actually has, so adding a rule
			 * updates the recorded set with no further action. Sorted so two runs
			 * of the same code produce an identical array whatever order the rules
			 * happen to be declared in.
			 *
			 * A run that threw never reaches here and leaves the column null, which
			 * is the correct answer: we do not know what it would have checked.
			 */
			ruleSet: [...Object.values(FINDING_TYPES)].sort(),
			/**
			 * What the render pass covered. A sample is a claim about coverage, so
			 * the claim is recorded beside the run rather than left for a reader to
			 * infer from how many observation rows happen to exist.
			 */
			renderSummary: {
				chosen: sample.urls.length,
				measured: render.observations.filter((o) => o.renderError === null)
					.length,
				cap: sample.cap,
				complete: render.complete,
			},
		})
		.where(eq(runs.id, runId));

	/**
	 * Retention, after the run has closed and its own pictures are safely stored.
	 *
	 * Here rather than on a timer because this is the moment the project gained a
	 * run, which is the only moment the window can have moved. Wrapped so that a
	 * failure to expire old bytes cannot fail a run that has already succeeded —
	 * carrying too much storage is a problem we can fix later, and a run marked
	 * failed for it is a lie about the site.
	 */
	await expireSnapshots(db, {
		tenantId: project.tenantId,
		projectId: project.id,
	}).catch(() => ({ expiredRuns: [] }));
}

/**
 * Closes runs that a previous process left open.
 *
 * Because the work is in-process, a run still marked queued or running at
 * startup cannot have a live owner — the process that owned it is gone. Left
 * alone such a row is indistinguishable from a slow crawl, which is exactly the
 * ambiguity that makes people stop trusting a tool.
 *
 * Runs once per process start, not per request.
 */
export async function sweepStaleRuns(db: Database): Promise<number> {
	const stale = await db
		.update(runs)
		.set({
			status: RUN_STATUS.INTERRUPTED,
			finishedAt: new Date(),
			error: "The process running this check restarted before it finished.",
		})
		.where(inArray(runs.status, ACTIVE))
		.returning({ id: runs.id });

	return stale.length;
}
