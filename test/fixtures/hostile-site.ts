import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A site that misbehaves in the ways real sites misbehave.
 *
 * Kept apart from `site.ts` deliberately. That fixture is the description of
 * what each detection rule means and is edited whenever a rule changes; this one
 * describes failure modes, and mixing the two would mean a change to detection
 * quietly altering the conditions under which politeness is judged.
 *
 * The shapes here are chosen for one property: none of them trips a threshold.
 * A site that fails every request is easy — the crawl aborts and everyone is
 * happy. The dangerous site is the one that fails often enough to be in trouble
 * and rarely enough that a consecutive-failure counter never fills.
 */

export type HostileFixture = {
	baseUrl: string;
	/** Every path served, in order. */
	requests: string[];
	/** Concurrent in-flight requests, high-water mark. */
	peakConcurrency: number;
	/** How many responses were 5xx. */
	failuresServed: number;
	close: () => Promise<void>;
};

export type HostileOptions = {
	/** How many children each hub links to. */
	fanOut?: number;
	/**
	 * One response in this many fails with a 500. `2` alternates, which is the
	 * shape that defeats a consecutive-failure counter entirely. Zero never fails.
	 */
	failEvery?: number;
	/** Milliseconds a `/slow/*` page waits before responding. */
	slowMs?: number;
};

const html = (title: string, links: string[] = []): string =>
	`<!doctype html>
<html><head><title>${title}</title></head>
<body>${links.map((href) => `<a href="${href}">${href}</a>`).join("")}</body>
</html>`;

export async function startHostileSite(
	options: HostileOptions = {},
): Promise<HostileFixture> {
	const { fanOut = 20, failEvery = 2, slowMs = 50 } = options;

	const requests: string[] = [];
	let inFlight = 0;
	let peakConcurrency = 0;
	let failuresServed = 0;
	let served = 0;

	const children = (prefix: string) =>
		Array.from({ length: fanOut }, (_, index) => `${prefix}/${index}`);

	const server: Server = createServer(async (req, res) => {
		inFlight += 1;
		peakConcurrency = Math.max(peakConcurrency, inFlight);

		const path = (req.url ?? "/").split("?")[0] ?? "/";
		requests.push(path);

		try {
			if (path === "/flapping-hub") {
				res.writeHead(200, { "content-type": "text/html" });
				res.end(html("flapping hub", children("/flapping")));
				return;
			}

			if (path.startsWith("/flapping/")) {
				/**
				 * Counted per response rather than per path, so the alternation holds
				 * however the crawl orders its requests. At `failEvery: 2` the site is
				 * failing half the time and never twice in a row.
				 */
				served += 1;
				if (failEvery > 0 && served % failEvery === 0) {
					failuresServed += 1;
					res.writeHead(500, { "content-type": "text/html" });
					res.end(html("boom"));
					return;
				}
				res.writeHead(200, { "content-type": "text/html" });
				res.end(html(path));
				return;
			}

			if (path === "/slow-hub") {
				res.writeHead(200, { "content-type": "text/html" });
				res.end(html("slow hub", children("/slow")));
				return;
			}

			if (path.startsWith("/slow/")) {
				// Slow enough to hurt, fast enough that the request timeout never fires.
				await new Promise((resolve) => setTimeout(resolve, slowMs));
				res.writeHead(200, { "content-type": "text/html" });
				res.end(html(path));
				return;
			}

			/**
			 * Two pages linking to each other, plus a self-link. A crawl that does not
			 * remember where it has been never finishes here.
			 */
			if (path === "/loop/a") {
				res.writeHead(200, { "content-type": "text/html" });
				res.end(html("a", ["/loop/b", "/loop/a"]));
				return;
			}
			if (path === "/loop/b") {
				res.writeHead(200, { "content-type": "text/html" });
				res.end(html("b", ["/loop/a", "/loop/b"]));
				return;
			}

			res.writeHead(404, { "content-type": "text/html" });
			res.end(html("not found"));
		} finally {
			inFlight -= 1;
		}
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requests,
		get peakConcurrency() {
			return peakConcurrency;
		},
		get failuresServed() {
			return failuresServed;
		},
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}
