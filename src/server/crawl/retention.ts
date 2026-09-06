import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { db as database } from "~/server/db";
import { pageSnapshots, projects, runs } from "~/server/db/schema";

/**
 * How long a picture is kept.
 *
 * Every other artifact this product stores is a row measured in kilobytes, so
 * nothing until now has needed to expire and nothing in the codebase deletes
 * anything. Snapshots are different in kind: the PRD called them the line item
 * most likely to force a hosting bill, and resolved the conflict between a
 * bounded footprint and persistent history by splitting retention per artifact
 * class rather than picking one window for both.
 *
 * The rule, from PRD Open Question 5: **the pinned baseline never expires;
 * beyond it only the most recent runs keep their images.** Run metadata and
 * findings — the rows a trend reads — are untouched by any of this and are kept
 * indefinitely, so the history stays complete even where the pictures do not.
 *
 * What expires is bytes, never rows. See {@link expireSnapshots}.
 */

type Database = typeof database;

/**
 * How many runs beyond the baseline keep their images.
 *
 * Three, from the PRD. Small enough to bound the footprint, and enough that a
 * reader comparing today against the baseline can still look at what the two
 * runs before it saw.
 */
export const SNAPSHOTS_KEPT = 3;

/**
 * Which of a project's runs should lose their images.
 *
 * Pure, so the rule can be read without tracing a query and tested without a
 * database — the same reason `sample.ts` and `comparison.ts` are pure.
 *
 * @param runIds - the project's run ids, newest first
 * @param baselineRunId - the pinned baseline, or null when there is none
 * @param keep - how many recent runs keep their images
 */
export function runsToExpire(
	runIds: string[],
	baselineRunId: string | null,
	keep: number = SNAPSHOTS_KEPT,
): string[] {
	/**
	 * The baseline does not consume a slot.
	 *
	 * Counting it would mean that pinning an old run silently shortens the recent
	 * window, and that pinning the newest run shortens it by one for no reason a
	 * reader could see. The two rules are independent: the baseline is kept
	 * because it is the baseline, and the window keeps what it keeps.
	 */
	const recent = runIds.filter((id) => id !== baselineRunId).slice(0, keep);
	const survivors = new Set(recent);
	if (baselineRunId !== null) survivors.add(baselineRunId);

	return runIds.filter((id) => !survivors.has(id));
}

/**
 * Drops the bytes the rule says may go, and keeps everything else.
 *
 * **Updates, never deletes.** A deleted row would make a snapshot that expired
 * indistinguishable from one that was never taken, and only the first is a
 * statement about our own storage. The row survives carrying `expiredAt`, so a
 * reader asking why there is no picture gets an answer instead of a silence.
 *
 * Idempotent: a second call over the same project finds the images already gone
 * and changes nothing.
 */
export async function expireSnapshots(
	db: Database,
	input: { tenantId: string; projectId: string },
): Promise<{ expiredRuns: string[] }> {
	const { tenantId, projectId } = input;

	const project = await db.query.projects.findFirst({
		where: and(eq(projects.tenantId, tenantId), eq(projects.id, projectId)),
		columns: { baselineRunId: true },
	});
	if (!project) return { expiredRuns: [] };

	const ordered = await db.query.runs.findMany({
		where: and(eq(runs.tenantId, tenantId), eq(runs.projectId, projectId)),
		columns: { id: true },
		orderBy: (run, { desc }) => [desc(run.createdAt)],
	});

	const expiring = runsToExpire(
		ordered.map((run) => run.id),
		project.baselineRunId,
	);
	if (expiring.length === 0) return { expiredRuns: [] };

	await db
		.update(pageSnapshots)
		.set({ image: null, byteSize: null, expiredAt: new Date() })
		.where(
			and(
				eq(pageSnapshots.tenantId, tenantId),
				inArray(pageSnapshots.runId, expiring),
				/**
				 * Only rows that still hold bytes. Without this the second call would
				 * rewrite `expiredAt` on rows it expired the first time, which would
				 * move the recorded moment away from the one that actually happened.
				 */
				isNotNull(pageSnapshots.image),
			),
		);

	return { expiredRuns: expiring };
}
