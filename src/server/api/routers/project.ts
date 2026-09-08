import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { z } from "zod";

import {
	assertProjectAccess,
	createTRPCRouter,
	ownerProcedure,
	tenantProcedure,
	tenantScope,
} from "~/server/api/trpc";
import { canRunChecks } from "~/server/auth/roles";
import { comparability, compareFindings } from "~/server/crawl/comparison";
import { MAX_MASKS, MAX_SELECTOR_LENGTH } from "~/server/crawl/masks";
import { RunAlreadyActiveError, startRun } from "~/server/crawl/run";
import {
	findings,
	pageObservations,
	pageSnapshots,
	pages,
	projects,
	runs,
} from "~/server/db/schema";

/**
 * The reference example every domain router should copy.
 *
 * Two things make it the pattern rather than the demo it replaced: it is built
 * on `tenantProcedure`, not `protectedProcedure`, and every query composes
 * {@link tenantScope}. A query that skips either can return another tenant's
 * rows while still looking correct at the call site.
 *
 * Note that scoping is applied even when a row is already reachable only via an
 * id the caller supplied. An id is not a permission — a caller can guess or
 * replay one, so ownership is re-established on every read.
 */
/**
 * How many runs the trend aggregate will look back over.
 *
 * Bounds the query as a project accumulates years of history. Kept in step with
 * `MAX_COLUMNS` in the grid; if the two drift, the grid still draws the most
 * recent runs, so the consequence is how much history is shown and never which
 * runs are trusted.
 */
const TREND_RUN_LIMIT = 12;

export const projectRouter = createTRPCRouter({
	/**
	 * The one procedure whose result set differs for all three roles.
	 *
	 * An Owner sees the tenant; everyone else sees what they were assigned. The
	 * empty case is returned early rather than folded into the query, because
	 * `inArray(column, [])` is not reliably an empty result across drivers — and
	 * getting that wrong here would turn "assigned to nothing" into "assigned to
	 * everything", which is the one mistake in this file that would be silent.
	 */
	list: tenantProcedure.query(async ({ ctx }) => {
		const assigned = ctx.assignedProjectIds;
		if (assigned !== null && assigned.length === 0) return [];

		return ctx.db.query.projects.findMany({
			where:
				assigned === null
					? tenantScope(projects, ctx.tenantId)
					: and(
							tenantScope(projects, ctx.tenantId),
							inArray(projects.id, assigned),
						),
			orderBy: (project, { asc }) => [asc(project.name)],
		});
	}),

	byId: tenantProcedure
		.input(z.object({ projectId: z.string() }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx, input.projectId);

			const project = await ctx.db.query.projects.findFirst({
				where: and(
					tenantScope(projects, ctx.tenantId),
					eq(projects.id, input.projectId),
				),
			});
			if (!project) throw new TRPCError({ code: "NOT_FOUND" });
			return project;
		}),

	create: ownerProcedure
		.input(
			z.object({
				name: z.string().min(1).max(255),
				startUrl: z.string().url(),
				locales: z.array(z.string().min(2).max(32)).default([]),
				/**
				 * Scope, as path prefixes. Excluded paths are the safety-relevant half:
				 * a client's admin area, checkout, or anything that does work on being
				 * fetched has no business being crawled, and the requirement that
				 * causing an incident is worse than the regression being hunted makes
				 * this a control the operator needs before the first real run, not a
				 * refinement afterwards.
				 */
				includePaths: z.array(z.string().min(1).max(255)).default([]),
				excludePaths: z.array(z.string().min(1).max(255)).default([]),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const [project] = await ctx.db
				.insert(projects)
				.values({
					tenantId: ctx.tenantId,
					name: input.name,
					startUrl: input.startUrl,
					locales: input.locales.map((l) => l.toLowerCase()),
					includePaths: input.includePaths,
					excludePaths: input.excludePaths,
				})
				.returning();

			if (!project) {
				throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
			}
			return project;
		}),

	startRun: tenantProcedure
		.input(z.object({ projectId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			/**
			 * Reachability first, capability second, and the order matters. A caller
			 * who cannot reach the project gets `NOT_FOUND` and learns nothing;
			 * answering `FORBIDDEN` first would confirm the project exists to
			 * somebody who should not know that.
			 */
			await assertProjectAccess(ctx, input.projectId);

			if (!canRunChecks(ctx.role)) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "This account has read-only access to this project.",
				});
			}

			try {
				return await startRun(ctx.db, {
					tenantId: ctx.tenantId,
					projectId: input.projectId,
				});
			} catch (caught) {
				/**
				 * A run already being in progress is an ordinary outcome of clicking
				 * twice, not a fault. CONFLICT lets the interface say so plainly
				 * instead of showing an error.
				 */
				if (caught instanceof RunAlreadyActiveError) {
					throw new TRPCError({ code: "CONFLICT", message: caught.message });
				}
				throw caught;
			}
		}),

	/**
	 * "This is what the site is supposed to look like."
	 *
	 * Pinning does more than name a comparison target: it fixes the set of pages
	 * later runs will render. The sample `chooseRenderSample` picks is stable only
	 * across runs where nothing changed, because it ranks by inbound links — and
	 * navigation changing is one of the deploys most likely to break a page
	 * visually. A set that reshuffled under exactly the condition being hunted
	 * would drop pages out of comparison silently.
	 */
	pinBaseline: ownerProcedure
		.input(z.object({ projectId: z.string(), runId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx, input.projectId);

			const project = await ctx.db.query.projects.findFirst({
				where: and(
					tenantScope(projects, ctx.tenantId),
					eq(projects.id, input.projectId),
				),
			});
			if (!project) throw new TRPCError({ code: "NOT_FOUND" });

			/**
			 * The run must be this project's and this tenant's. An id is not a
			 * permission, and a baseline pointing at another project's run would
			 * compare a site against a different site.
			 */
			const run = await ctx.db.query.runs.findFirst({
				where: and(
					tenantScope(runs, ctx.tenantId),
					eq(runs.id, input.runId),
					eq(runs.projectId, input.projectId),
				),
			});
			if (!run) throw new TRPCError({ code: "NOT_FOUND" });

			/**
			 * A run with no picture left cannot be a baseline. Pinning one would
			 * produce a project that looks configured and compares nothing — the
			 * silent-empty-state failure this codebase keeps refusing.
			 */
			const [usable] = await ctx.db
				.select({ total: count() })
				.from(pageSnapshots)
				.where(
					and(
						tenantScope(pageSnapshots, ctx.tenantId),
						eq(pageSnapshots.runId, run.id),
						isNotNull(pageSnapshots.image),
					),
				);

			if (!usable || usable.total === 0) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"That run holds no snapshots to compare against — either it captured none, or they have since expired.",
				});
			}

			const [updated] = await ctx.db
				.update(projects)
				.set({ baselineRunId: run.id, baselinePinnedAt: new Date() })
				.where(
					and(
						tenantScope(projects, ctx.tenantId),
						eq(projects.id, input.projectId),
					),
				)
				.returning();

			if (!updated) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
			return { baselineRunId: updated.baselineRunId, watched: usable.total };
		}),

	/**
	 * Which regions never count as changed.
	 *
	 * Validated for shape only. A selector that is valid CSS but matches nothing
	 * is indistinguishable here from one that will match — that depends on their
	 * markup, which we do not have at this point — so a selector the browser
	 * cannot parse is caught at capture and recorded there instead.
	 */
	setMasks: ownerProcedure
		.input(
			z.object({
				projectId: z.string(),
				/**
				 * Both bounds come from `masks.ts`, which the textarea's own check
				 * also reads — so the button never stays enabled for a list this
				 * would refuse, and never refuses one this would take.
				 */
				selectors: z
					.array(z.string().min(1).max(MAX_SELECTOR_LENGTH))
					.max(MAX_MASKS),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx, input.projectId);

			const [updated] = await ctx.db
				.update(projects)
				.set({ maskSelectors: input.selectors })
				.where(
					and(
						tenantScope(projects, ctx.tenantId),
						eq(projects.id, input.projectId),
					),
				)
				.returning();

			if (!updated) throw new TRPCError({ code: "NOT_FOUND" });
			return { maskSelectors: updated.maskSelectors };
		}),

	latestRun: tenantProcedure
		.input(z.object({ projectId: z.string() }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx, input.projectId);

			return (
				(await ctx.db.query.runs.findFirst({
					where: and(
						tenantScope(runs, ctx.tenantId),
						eq(runs.projectId, input.projectId),
					),
					orderBy: [desc(runs.createdAt)],
				})) ?? null
			);
		}),

	runStatus: tenantProcedure
		.input(z.object({ runId: z.string() }))
		.query(async ({ ctx, input }) => {
			const run = await ctx.db.query.runs.findFirst({
				where: and(tenantScope(runs, ctx.tenantId), eq(runs.id, input.runId)),
			});
			if (!run) throw new TRPCError({ code: "NOT_FOUND" });
			await assertProjectAccess(ctx, run.projectId);
			return run;
		}),

	findings: tenantProcedure
		.input(z.object({ runId: z.string() }))
		.query(async ({ ctx, input }) => {
			/**
			 * The run is re-checked against the tenant before its findings are read.
			 * Scoping the findings alone would be enough today, but this keeps the
			 * ownership question in one obvious place as more finding types arrive.
			 */
			const run = await ctx.db.query.runs.findFirst({
				where: and(tenantScope(runs, ctx.tenantId), eq(runs.id, input.runId)),
			});
			if (!run) throw new TRPCError({ code: "NOT_FOUND" });
			await assertProjectAccess(ctx, run.projectId);

			return ctx.db.query.findings.findMany({
				where: and(
					tenantScope(findings, ctx.tenantId),
					eq(findings.runId, input.runId),
				),
				orderBy: (finding, { asc }) => [asc(finding.type), asc(finding.id)],
			});
		}),

	/**
	 * The project's run history, newest first.
	 *
	 * Run rows only — never their findings. The list exists to be scanned, and a
	 * project with fifty runs of five hundred findings would otherwise send a
	 * quarter of a million rows to render a date column.
	 */
	runs: tenantProcedure
		.input(z.object({ projectId: z.string() }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx, input.projectId);

			return ctx.db.query.runs.findMany({
				where: and(
					tenantScope(runs, ctx.tenantId),
					eq(runs.projectId, input.projectId),
				),
				orderBy: [desc(runs.createdAt)],
			});
		}),

	/**
	 * One run's findings, annotated against the run before it.
	 *
	 * Computed here rather than in the browser: it saves sending two full finding
	 * sets over the wire, and it keeps the comparability guard next to the run
	 * metadata it reads. Not stored, for the reason correlation is not stored —
	 * the rule is young, and freezing it would leave old runs described by a rule
	 * nobody would write today.
	 */
	comparison: tenantProcedure
		.input(z.object({ runId: z.string() }))
		.query(async ({ ctx, input }) => {
			const run = await ctx.db.query.runs.findFirst({
				where: and(tenantScope(runs, ctx.tenantId), eq(runs.id, input.runId)),
			});
			if (!run) throw new TRPCError({ code: "NOT_FOUND" });
			await assertProjectAccess(ctx, run.projectId);

			const current = await ctx.db.query.findings.findMany({
				where: and(
					tenantScope(findings, ctx.tenantId),
					eq(findings.runId, run.id),
				),
				orderBy: (finding, { asc }) => [asc(finding.type), asc(finding.id)],
			});

			const previous = await ctx.db.query.runs.findFirst({
				where: and(
					tenantScope(runs, ctx.tenantId),
					eq(runs.projectId, run.projectId),
					lt(runs.createdAt, run.createdAt),
				),
				orderBy: [desc(runs.createdAt)],
			});

			/**
			 * A first run is an ordinary state, not a fault. It returns its own
			 * findings unannotated rather than an error, so the view renders exactly
			 * as it did before comparison existed.
			 */
			if (!previous) {
				return {
					previousRunId: null,
					comparability: null,
					findings: current.map((finding) => ({
						...finding,
						status: null,
					})),
				};
			}

			const verdict = comparability(previous, run);
			if (!verdict.comparable) {
				return {
					previousRunId: previous.id,
					comparability: verdict,
					findings: current.map((finding) => ({ ...finding, status: null })),
				};
			}

			const before = await ctx.db.query.findings.findMany({
				where: and(
					tenantScope(findings, ctx.tenantId),
					eq(findings.runId, previous.id),
				),
			});

			return {
				previousRunId: previous.id,
				comparability: verdict,
				findings: compareFindings(before, current),
			};
		}),

	/**
	 * Per-type finding counts across the runs of a project that may be trended.
	 *
	 * Eligibility is `comparability` itself rather than a second check written to
	 * resemble it. "May these two runs be drawn on one axis" is the comparison's
	 * question, and a trend that answered it differently would eventually
	 * contradict the diff sitting above it on the same page.
	 *
	 * The most recent run is the reference: it is the one the reader is looking
	 * at, and it is the one whose conditions the older runs have to match to be
	 * plotted beside it.
	 *
	 * Counted here rather than in the browser, for the reason the comparison is:
	 * a project with fifty runs of five hundred findings would otherwise send a
	 * quarter of a million rows to draw two dozen numbers.
	 */
	trend: tenantProcedure
		.input(z.object({ projectId: z.string() }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx, input.projectId);

			const history = await ctx.db.query.runs.findMany({
				where: and(
					tenantScope(runs, ctx.tenantId),
					eq(runs.projectId, input.projectId),
				),
				orderBy: [desc(runs.createdAt)],
				limit: TREND_RUN_LIMIT,
			});

			/**
			 * The reference is the most recent run that is sound on its own terms —
			 * one that recorded what it covered and covered the whole of it. That is
			 * exactly `comparability(run, run)`, so the definition is still the
			 * guard's and not a second one written to resemble it.
			 *
			 * Not simply the newest run, because a run is not comparable to itself
			 * when it was truncated: taking one of those as the axis would reject
			 * every other run with it and erase a project's whole history over a
			 * single interrupted crawl. The interrupted run drops out of the series;
			 * the runs either side of it still belong on one axis.
			 */
			const reference = history.find(
				(run) => comparability(run, run).comparable,
			);
			/**
			 * No sound run yet is an ordinary state, not a fault — a project created
			 * five minutes ago, or one whose only runs predate this recording. It
			 * returns an empty series and lets the view say so.
			 */
			if (!reference) return { runs: [], counts: [] };

			const qualifying = history.filter(
				(run) => comparability(run, reference).comparable,
			);

			/**
			 * Oldest first, which is the reading order of the grid. A project with
			 * fewer than two qualifying runs still returns what it has: the emptiness
			 * is a fact the view has to explain, not one to hide by returning nothing.
			 */
			const ordered = [...qualifying].reverse();
			if (ordered.length === 0) return { runs: ordered, counts: [] };

			const counts = await ctx.db
				.select({
					runId: findings.runId,
					type: findings.type,
					count: count(),
				})
				.from(findings)
				.where(
					and(
						tenantScope(findings, ctx.tenantId),
						inArray(
							findings.runId,
							ordered.map((run) => run.id),
						),
					),
				)
				.groupBy(findings.runId, findings.type);

			return { runs: ordered, counts };
		}),

	/**
	 * What a browser saw during one run, and how much of the site that was.
	 *
	 * The summary travels with the observations rather than being inferred from
	 * how many there are: a reader has to be told the sample was a sample, and a
	 * pass that could not run at all has zero observations for a reason that is
	 * not "the site was fine".
	 */
	runObservations: tenantProcedure
		.input(z.object({ runId: z.string() }))
		.query(async ({ ctx, input }) => {
			const run = await ctx.db.query.runs.findFirst({
				where: and(tenantScope(runs, ctx.tenantId), eq(runs.id, input.runId)),
			});
			if (!run) throw new TRPCError({ code: "NOT_FOUND" });
			await assertProjectAccess(ctx, run.projectId);

			const observed = await ctx.db
				.select({
					id: pageObservations.id,
					url: pages.url,
					ttfbMs: pageObservations.ttfbMs,
					lcpMs: pageObservations.lcpMs,
					cls: pageObservations.cls,
					firstPartyErrors: pageObservations.firstPartyErrors,
					thirdPartyErrors: pageObservations.thirdPartyErrors,
					renderError: pageObservations.renderError,
				})
				.from(pageObservations)
				.innerJoin(pages, eq(pages.id, pageObservations.pageId))
				.where(
					and(
						tenantScope(pageObservations, ctx.tenantId),
						eq(pageObservations.runId, run.id),
					),
				)
				.orderBy(pages.url);

			return {
				observations: observed,
				summary: run.renderSummary,
				/** How many pages the run recorded, so the sample can be put in proportion. */
				pagesCrawled: run.pagesCrawled,
			};
		}),

	/**
	 * The watched pages of one run, and how much of the site that was.
	 *
	 * **Never selects `image`.** The bytes reach the browser through
	 * `/api/snapshots/[snapshotId]`, one picture per request; pulling a dozen
	 * full-page PNGs through a JSON response would be tens of megabytes of
	 * base64 for a list nobody has scrolled to yet. The columns here are what the
	 * list needs in order to say what it holds.
	 *
	 * The summary travels alongside for the reason `runObservations` carries
	 * `renderSummary`: a reader has to be told the watched set was a set, and a
	 * run with no baseline has zero comparisons for a reason that is not "the
	 * site was fine".
	 */
	runSnapshots: tenantProcedure
		.input(z.object({ runId: z.string() }))
		.query(async ({ ctx, input }) => {
			const run = await ctx.db.query.runs.findFirst({
				where: and(tenantScope(runs, ctx.tenantId), eq(runs.id, input.runId)),
			});
			if (!run) throw new TRPCError({ code: "NOT_FOUND" });
			await assertProjectAccess(ctx, run.projectId);

			const rows = await ctx.db
				.select({
					id: pageSnapshots.id,
					url: pages.url,
					byteSize: pageSnapshots.byteSize,
					captureError: pageSnapshots.captureError,
					expiredAt: pageSnapshots.expiredAt,
					imageWidth: pageSnapshots.imageWidth,
					imageHeight: pageSnapshots.imageHeight,
					/**
					 * As the run concluded it, not recomputed here. Recomputing would
					 * let the view disagree with the finding beside it, and would make
					 * an old run's numbers change whenever this code did.
					 */
					comparison: pageSnapshots.comparison,
				})
				.from(pageSnapshots)
				.innerJoin(pages, eq(pages.id, pageSnapshots.pageId))
				.where(
					and(
						tenantScope(pageSnapshots, ctx.tenantId),
						eq(pageSnapshots.runId, run.id),
					),
				)
				.orderBy(pages.url);

			/**
			 * The project's baseline *now*, alongside what this run compared
			 * against. They differ whenever a baseline was pinned or re-pinned after
			 * the run, and the difference is what stops the view telling a reader to
			 * pin something they have already pinned.
			 */
			const project = await ctx.db.query.projects.findFirst({
				columns: { baselineRunId: true, maskSelectors: true },
				where: and(
					tenantScope(projects, ctx.tenantId),
					eq(projects.id, run.projectId),
				),
			});

			return {
				snapshots: rows,
				summary: run.visualSummary,
				projectBaselineRunId: project?.baselineRunId ?? null,
				/**
				 * The masks in force *now*, which the section both explains and edits.
				 * Returned here rather than fetched separately because the panel cannot
				 * render its own state without them, and two round trips would let the
				 * list and the pictures it describes disagree for a frame.
				 */
				maskSelectors: project?.maskSelectors ?? [],
				/** How many pages the run recorded, so the watched set has a proportion. */
				pagesCrawled: run.pagesCrawled,
			};
		}),

	runPages: tenantProcedure
		.input(z.object({ runId: z.string() }))
		.query(async ({ ctx, input }) => {
			/**
			 * The run is resolved here purely to have a project to authorise against.
			 * Tenant scoping on `pages` was sufficient while tenant was the only
			 * question; it cannot answer which project a caller may reach, because
			 * `pages` carries no project id.
			 */
			const run = await ctx.db.query.runs.findFirst({
				columns: { projectId: true },
				where: and(tenantScope(runs, ctx.tenantId), eq(runs.id, input.runId)),
			});
			if (!run) throw new TRPCError({ code: "NOT_FOUND" });
			await assertProjectAccess(ctx, run.projectId);

			return ctx.db.query.pages.findMany({
				where: and(
					tenantScope(pages, ctx.tenantId),
					eq(pages.runId, input.runId),
				),
				orderBy: (page, { asc }) => [asc(page.url)],
			});
		}),
});
