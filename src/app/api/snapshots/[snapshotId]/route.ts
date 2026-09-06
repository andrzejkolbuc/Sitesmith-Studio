import { and, eq } from "drizzle-orm";

import { auth } from "~/server/auth";
import { compareSnapshots, diffOverlay } from "~/server/crawl/visual";
import { db } from "~/server/db";
import {
	pageSnapshots,
	pages,
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
		columns: { tenantId: true },
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
		where: and(
			eq(pageSnapshots.id, snapshotId),
			eq(pageSnapshots.tenantId, user.tenantId),
		),
	});
	if (!snapshot) return notFound();

	if (view === "current") {
		if (!snapshot.image) return notFound();
		return new Response(new Uint8Array(snapshot.image), { headers: HEADERS });
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

	const run = await db.query.runs.findFirst({
		columns: { projectId: true },
		where: and(eq(runs.id, snapshot.runId), eq(runs.tenantId, user.tenantId)),
	});
	if (!run) return notFound();

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
	const after = snapshot.image
		? {
				image: snapshot.image,
				viewportWidth: snapshot.viewportWidth,
				viewportHeight: snapshot.viewportHeight,
				maskSelectors: snapshot.maskSelectors,
			}
		: null;

	if (!compareSnapshots(before, after).comparable) return notFound();

	const overlay = diffOverlay(before, after);
	if (!overlay) return notFound();

	return new Response(new Uint8Array(overlay), { headers: HEADERS });
}
