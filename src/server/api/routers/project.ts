import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";

import {
	createTRPCRouter,
	tenantProcedure,
	tenantScope,
} from "~/server/api/trpc";
import { comparability, compareFindings } from "~/server/crawl/comparison";
import { RunAlreadyActiveError, startRun } from "~/server/crawl/run";
import {
	findings,
	pageObservations,
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
	list: tenantProcedure.query(async ({ ctx }) => {
		return ctx.db.query.projects.findMany({
			where: tenantScope(projects, ctx.tenantId),
			orderBy: (project, { asc }) => [asc(project.name)],
		});
	}),

	byId: tenantProcedure
		.input(z.object({ projectId: z.string() }))
		.query(async ({ ctx, input }) => {
			const project = await ctx.db.query.projects.findFirst({
				where: and(
					tenantScope(projects, ctx.tenantId),
					eq(projects.id, input.projectId),
				),
			});
			if (!project) throw new TRPCError({ code: "NOT_FOUND" });
			return project;
		}),

	create: tenantProcedure
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

	latestRun: tenantProcedure
		.input(z.object({ projectId: z.string() }))
		.query(async ({ ctx, input }) => {
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

	runPages: tenantProcedure
		.input(z.object({ runId: z.string() }))
		.query(async ({ ctx, input }) => {
			return ctx.db.query.pages.findMany({
				where: and(
					tenantScope(pages, ctx.tenantId),
					eq(pages.runId, input.runId),
				),
				orderBy: (page, { asc }) => [asc(page.url)],
			});
		}),
});
