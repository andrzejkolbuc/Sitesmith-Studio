import { and, eq, isNull } from "drizzle-orm";

import { auth } from "~/server/auth";
import { isOwner } from "~/server/auth/roles";
import { diffOverlay } from "~/server/crawl/visual";
import { db } from "~/server/db";
import {
	pageSnapshots,
	pages,
	projectAssignments,
	projects,
	runs,
	users,
} from "~/server/db/schema";

/**
 * The only surface in this product that answers with bytes.
 *
 * tRPC carries JSON through superjson, which is the wrong channel for a PNG, so
 * a snapshot reaches the browser through an ordinary route handler instead. That
 * makes this a place a result can appear — and NFR-2, that no client's data is
 * reachable from another client's session, is a binary commitment that holds on
 * *every* such surface. So this handler re-establishes ownership itself rather
 * than inheriting it: the id in the URL is not a permission, and a caller can
 * guess or replay one.
 *
 * A snapshot belonging to another tenant answers 404, not 403 — the same answer
 * a snapshot that does not exist gets, and the same choice the project page
 * makes. Telling a caller that a row exists is itself a leak.
 */

/** What the caller wants to look at. */
type View = "current" | "baseline" | "diff";

const VIEWS: View[] = ["current", "baseline", "diff"];

const notFound = () => new Response("Not found", { status: 404 });

/**
 * Never cached by a shared cache, and never written to disk.
 *
 * A snapshot is one tenant's client's site. `private` keeps it out of any proxy
 * between us and the reader, and `no-store` keeps it out of the reader's own
 * disk cache, where it would outlive the session that was allowed to see it.
 */
const HEADERS = {
	"content-type": "image/png",
	"cache-control": "private, no-store",
};

export async function GET(
	request: Request,
	context: { params: Promise<{ snapshotId: string }> },
): Promise<Response> {
	const session = await auth();
	const userId = session?.user?.id;
	if (!userId) return notFound();

	const user = await db.query.users.findFirst({
		columns: { tenantId: true, role: true },
		where: eq(users.id, userId),
	});
	if (!user?.tenantId) return notFound();

	const { snapshotId } = await context.params;
	const requested = new URL(request.url).searchParams.get("view") ?? "current";
	if (!VIEWS.includes(requested as View)) return notFound();
	const view = requested as View;

	/**
	 * Scoped on the snapshot's own tenant column, which the run stamps at
	 * capture. Reachable by id alone is exactly what this must not be.
	 */
	const snapshot = await db.query.pageSnapshots.findFirst({
		/**
		 * Metadata only. The bytes are the largest column in the schema and the
		 * `view=baseline` path never touches them — it reads this row for its page
		 * and run, then fetches a different row's picture entirely. Selecting the
		 * whole row meant every baseline request in a report decoded a
		 * multi-megabyte blob in order to throw it away, and a report asks for one
		 * baseline per changed page.
		 */
		columns: {
			runId: true,
			pageId: true,
			viewportWidth: true,
			viewportHeight: true,
			maskSelectors: true,
		},
		where: and(
			eq(pageSnapshots.id, snapshotId),
			eq(pageSnapshots.tenantId, user.tenantId),
		),
	});
	if (!snapshot) return notFound();

	/**
	 * This snapshot's own picture, read only where it is actually returned.
	 *
	 * Scoped on the same tenant predicate as the row above, bound to a local
	 * because the narrowing on `user.tenantId` does not survive into a closure.
	 */
	const tenantId = user.tenantId;
	const ownImage = async (): Promise<Buffer | null> => {
		const [row] = await db
			.select({ image: pageSnapshots.image })
			.from(pageSnapshots)
			.where(
				and(
					eq(pageSnapshots.id, snapshotId),
					eq(pageSnapshots.tenantId, tenantId),
				),
			);
		return row?.image ?? null;
	};

	/**
	 * Which project this picture belongs to, resolved before any bytes are
	 * returned rather than only on the diff path below.
	 *
	 * Tenant scoping was the whole of the answer while an account either saw its
	 * agency's work or was not in the agency. It stopped being the whole answer
	 * the moment a Client-viewer could exist: they hold a legitimate session in a
	 * legitimate tenant, and a tenant-only predicate would hand them every
	 * screenshot of every other client the agency has.
	 *
	 * This handler inherits nothing — no tRPC middleware, no route-group layout —
	 * so the check is written out here rather than composed. That duplication is
	 * deliberate and matches the note above: the id in the URL is not a
	 * permission, and this handler re-establishes ownership itself.
	 */
	const run = await db.query.runs.findFirst({
		columns: { projectId: true },
		where: and(eq(runs.id, snapshot.runId), eq(runs.tenantId, user.tenantId)),
	});
	if (!run) return notFound();

	if (!isOwner(user.role)) {
		const assignment = await db.query.projectAssignments.findFirst({
			columns: { projectId: true },
			where: and(
				eq(projectAssignments.userId, userId),
				eq(projectAssignments.tenantId, user.tenantId),
				eq(projectAssignments.projectId, run.projectId),
			),
		});
		if (!assignment) return notFound();
	}

	/**
	 * A deleted project's pictures are deleted too.
	 *
	 * The same reasoning as the assignment check above, and the same reason it is
	 * written out rather than composed: this handler inherits no middleware, so
	 * the refusal `assertProjectAccess` gives every procedure has to be repeated
	 * here or it does not apply here. Without it the one surface that serves
	 * bytes rather than JSON would keep serving full-page screenshots of a
	 * project the owner removed.
	 */
	const live = await db.query.projects.findFirst({
		columns: { id: true },
		where: and(
			eq(projects.tenantId, user.tenantId),
			eq(projects.id, run.projectId),
			isNull(projects.archivedAt),
		),
	});
	if (!live) return notFound();

	if (view === "current") {
		const image = await ownImage();
		if (!image) return notFound();
		return new Response(new Uint8Array(image), { headers: HEADERS });
	}

	/**
	 * The baseline's picture of the *same page*, found by URL rather than by id.
	 *
	 * A page has a different row in every run, so the two snapshots share no
	 * identifier — the URL is what makes them two pictures of one thing, which is
	 * the same key the run's own comparison uses.
	 */
	const page = await db.query.pages.findFirst({
		columns: { url: true },
		where: eq(pages.id, snapshot.pageId),
	});
	if (!page) return notFound();

	const project = await db.query.projects.findFirst({
		columns: { baselineRunId: true },
		where: and(
			eq(projects.tenantId, user.tenantId),
			eq(projects.id, run.projectId),
		),
	});
	if (!project?.baselineRunId) return notFound();

	const [baseline] = await db
		.select({
			image: pageSnapshots.image,
			viewportWidth: pageSnapshots.viewportWidth,
			viewportHeight: pageSnapshots.viewportHeight,
			maskSelectors: pageSnapshots.maskSelectors,
		})
		.from(pageSnapshots)
		.innerJoin(pages, eq(pages.id, pageSnapshots.pageId))
		.where(
			and(
				eq(pageSnapshots.tenantId, user.tenantId),
				eq(pageSnapshots.runId, project.baselineRunId),
				eq(pages.url, page.url),
			),
		);

	if (!baseline?.image) return notFound();

	if (view === "baseline") {
		return new Response(new Uint8Array(baseline.image), { headers: HEADERS });
	}

	/**
	 * The overlay, made here rather than stored.
	 *
	 * A third image per compared page would be roughly half again as much of the
	 * one line item the PRD called most likely to force a hosting bill, and both
	 * inputs are already in hand. Built from the same comparison the count came
	 * from, so what the reader sees cannot contradict the number beside it.
	 */
	const before = {
		image: baseline.image,
		viewportWidth: baseline.viewportWidth,
		viewportHeight: baseline.viewportHeight,
		maskSelectors: baseline.maskSelectors,
	};
	const currentImage = await ownImage();
	const after = currentImage
		? {
				image: currentImage,
				viewportWidth: snapshot.viewportWidth,
				viewportHeight: snapshot.viewportHeight,
				maskSelectors: snapshot.maskSelectors,
			}
		: null;

	/**
	 * One comparison, not two. `diffOverlay` runs the same `diff` a count would
	 * and answers nothing on every refusal, so asking `compareSnapshots` first
	 * bought only a second decode of both files, a second pixelmatch pass and a
	 * region scan whose answer was thrown away — on a ten-thousand-pixel page,
	 * hundreds of megabytes to learn what the null below already says.
	 */
	const overlay = diffOverlay(before, after);
	if (!overlay) return notFound();

	return new Response(new Uint8Array(overlay), { headers: HEADERS });
}
