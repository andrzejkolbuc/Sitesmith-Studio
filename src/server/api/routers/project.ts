import {
	createTRPCRouter,
	tenantProcedure,
	tenantScope,
} from "~/server/api/trpc";
import { projects } from "~/server/db/schema";

/**
 * The reference example every domain router should copy.
 *
 * Two things make it the pattern rather than the demo it replaced:
 * it is built on `tenantProcedure`, not `protectedProcedure`, and its `where`
 * clause composes {@link tenantScope}. A query that skips either can return
 * another tenant's rows while still looking correct at the call site.
 */
export const projectRouter = createTRPCRouter({
	/**
	 * Projects belonging to the caller's tenant.
	 *
	 * Read-only for now — creating and configuring projects arrives with the
	 * crawling slice.
	 */
	list: tenantProcedure.query(async ({ ctx }) => {
		return ctx.db.query.projects.findMany({
			where: tenantScope(projects, ctx.tenantId),
			orderBy: (project, { asc }) => [asc(project.name)],
		});
	}),
});
