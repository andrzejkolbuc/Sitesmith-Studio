/**
 * Runs once per server process start.
 *
 * The only thing here is closing runs that a previous process left open. Because
 * crawls execute in-process, a run still marked queued or running at startup
 * cannot have a live owner, and a row like that is indistinguishable from a slow
 * crawl — which is the ambiguity that makes people stop trusting a tool.
 *
 * @see https://nextjs.org/docs/app/guides/instrumentation
 */
export async function register() {
	// The database driver is Node-only; the edge runtime also evaluates this file.
	if (process.env.NEXT_RUNTIME !== "nodejs") return;

	const { db } = await import("~/server/db");
	const { sweepStaleRuns } = await import("~/server/crawl/run");

	try {
		const closed = await sweepStaleRuns(db);
		if (closed > 0) {
			console.log(
				`[startup] Closed ${closed} run(s) left open by a previous process.`,
			);
		}
	} catch (caught) {
		// A failed sweep must not stop the server from starting; the consequence is
		// a stale row, not a broken application.
		console.error("[startup] Stale-run sweep failed:", caught);
	}
}
