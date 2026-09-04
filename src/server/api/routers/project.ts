import { TRPCError } from "@trpc/server";
import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";

import {
	createTRPCRouter,
	tenantProcedure,
	tenantScope,
} from "~/server/api/trpc";
import { comparability, compareFindings } from "~/server/crawl/comparison";
import { RunAlreadyActiveError, startRun } from "~/server/crawl/run";
import { findings, pages, projects, runs } from "~/server/db/schema";

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
