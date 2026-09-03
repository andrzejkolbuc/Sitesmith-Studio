import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { checkExternalLinks, isGone } from "./external";

/**
 * The external sweep: the first requests this product sends to hosts nobody
 * invited us to.
 *
 * Every case here is about restraint rather than detection. The crawl proper is
 * same-origin by construction and every politeness guarantee in `crawler.ts` was
 * written for that one relationship; none of it says anything about a third
 * party. So what is asserted below is that each URL is asked once, that a host
 * saying "stop" is obeyed, that a host not supporting HEAD is not punished for
 * it, and that a wall of dead hosts stops the sweep rather than the crawl.
 *
 * A local server stands in for the third parties. It records every request, so
 * the tests can assert about load rather than only about outcomes.
 */

let servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.map(
			(server) => new Promise<void>((resolve) => server.close(() => resolve())),
		),
	);
	servers = [];
});

type Route = (
	method: string,
	path: string,
) => { status: number; headers?: Record<string, string> };

async function host(route: Route) {
	const requests: Array<{ method: string; path: string }> = [];

	const server = createServer((req, res) => {
		const method = req.method ?? "GET";
		const path = req.url ?? "/";
		requests.push({ method, path });

		const { status, headers } = route(method, path);
		res.writeHead(status, headers ?? {});
		res.end();
	});

	servers.push(server);
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);

	const { port } = server.address() as AddressInfo;
	return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

/** A pacer that imposes nothing, so tests measure the sweep and not the clock. */
const instant = { claim: async () => {} };

const options = {
	pacer: instant,
	requestTimeoutMs: 2_000,
	perHostDelayMs: 0,
	maxRequests: 100,
};

describe("checking links that leave the site", () => {
	it("asks for each URL once, with HEAD", async () => {
		/**
		 * HEAD because the status line is the whole question. Reading a stranger's
		 * body to learn what their status already said would be both rude and
		 * unbounded.
		 */
		const target = await host(() => ({ status: 200 }));

		const sweep = await checkExternalLinks({
			...options,
			urls: [`${target.baseUrl}/a`, `${target.baseUrl}/b`],
		});

		expect(sweep.complete).toBe(true);
		expect(target.requests).toEqual([
			{ method: "HEAD", path: "/a" },
			{ method: "HEAD", path: "/b" },
		]);
	});

	it("retries with GET only where the host says HEAD is not supported", async () => {
		/**
		 * `405` and `501` are the specification's answers for "this method is not
		 * available here". Any other status is the host answering the question we
		 * asked, and asking again would double the load to learn nothing.
		 */
		const target = await host((method) =>
			method === "HEAD" ? { status: 405 } : { status: 200 },
		);

		const sweep = await checkExternalLinks({
			...options,
			urls: [`${target.baseUrl}/only-get`],
		});

		expect(target.requests.map((r) => r.method)).toEqual(["HEAD", "GET"]);
		expect(sweep.checked[0]?.httpStatus).toBe(200);
	});

	it("does not retry a 403 with GET", async () => {
		/**
		 * A refusal is the host's answer. Retrying would be us arguing with it, and
		 * the finding rule ignores a 403 anyway — being turned away is a fact about
		 * being a bot, not about the link.
		 */
		const target = await host(() => ({ status: 403 }));

		await checkExternalLinks({
			...options,
			urls: [`${target.baseUrl}/closed`],
		});

		expect(target.requests).toHaveLength(1);
	});

	it("stops asking a host that answered 429", async () => {
		/**
		 * A `429` is a host asking us to stop, and it is invisible to every abort
		 * mechanism the crawl has — the failure predicate counts only 5xx and
		 * network errors. Without this the sweep would keep asking a host that
		 * explicitly said no.
		 */
		const target = await host(() => ({
			status: 429,
			headers: { "retry-after": "120" },
		}));

		const sweep = await checkExternalLinks({
			...options,
			urls: [
				`${target.baseUrl}/a`,
				`${target.baseUrl}/b`,
				`${target.baseUrl}/c`,
			],
		});

		expect(target.requests).toHaveLength(1);
		// Nothing was learned about any of them, so nothing is reported.
		expect(sweep.checked).toEqual([]);
	});

	it("confirms a network failure before believing it", async () => {
		/**
		 * A name that does not resolve twice is a dead domain; one that failed once
		 * may be a moment of ours. The same second look the crawl gives its own
		 * transient failures.
		 */
		const sweep = await checkExternalLinks({
			...options,
			urls: ["http://127.0.0.1:1/gone"],
		});

		expect(sweep.checked[0]?.confirmed).toBe(true);
		expect(
			isGone(
				sweep.checked[0] ?? {
					url: "",
					httpStatus: null,
					fetchError: null,
					confirmed: false,
				},
			),
		).toBe(true);
	});

	it("stops when its own request budget runs out", async () => {
		/**
		 * The bound is derived rather than chosen: the caller passes the number of
		 * pages crawled, so a sweep can at worst double the run — a limit an
		 * operator can reason about from the run they already agreed to.
		 */
		const target = await host(() => ({ status: 200 }));

		const sweep = await checkExternalLinks({
			...options,
			maxRequests: 2,
			urls: [
				`${target.baseUrl}/a`,
				`${target.baseUrl}/b`,
				`${target.baseUrl}/c`,
				`${target.baseUrl}/d`,
			],
		});

		expect(sweep.complete).toBe(false);
		expect(target.requests.length).toBeLessThanOrEqual(2);
	});

	it("stops when most of what it asks for fails at the transport layer", async () => {
		/**
		 * Not the client's site struggling — our own end, most likely. If a third of
		 * everything fails to connect, every finding the sweep produced would be
		 * about us, so it stops and says it did not finish.
		 *
		 * The threshold and sample are the crawl's own, reused rather than
		 * reinvented: a second differently-chosen number would be one nobody
		 * defended.
		 */
		const sweep = await checkExternalLinks({
			...options,
			urls: Array.from({ length: 40 }, (_, i) => `http://127.0.0.1:1/${i}`),
		});

		expect(sweep.complete).toBe(false);
		expect(sweep.checked.length).toBeLessThan(40);
	});

	it("waits between two requests to the same host", async () => {
		/**
		 * The global pacer bounds the total rate; nothing before this bounded the
		 * rate against any one host. The delay is the crawl's own, so no third party
		 * is asked faster than the site we were actually invited to crawl.
		 */
		const target = await host(() => ({ status: 200 }));

		const started = Date.now();
		await checkExternalLinks({
			...options,
			perHostDelayMs: 120,
			urls: [`${target.baseUrl}/a`, `${target.baseUrl}/b`],
		});

		expect(Date.now() - started).toBeGreaterThanOrEqual(100);
	});
});

describe("deciding whether an external link is broken", () => {
	const check = (
		httpStatus: number | null,
		fetchError: string | null = null,
	) => ({
		url: "https://elsewhere.test/x",
		httpStatus,
		fetchError,
		confirmed: fetchError !== null,
	});

	it("calls 404 and 410 gone", () => {
		expect(isGone(check(404))).toBe(true);
		expect(isGone(check(410))).toBe(true);
	});

	it("does not call a refusal a broken link", () => {
		/**
		 * `401`, `403` and `429` are the host saying *we* may not have it, which is
		 * a fact about being an automated client. Filing it as a defect would report
		 * someone else's access policy as the client's broken link — and with no
		 * suppression mechanism yet, it would do so in every future run.
		 */
		expect(isGone(check(401))).toBe(false);
		expect(isGone(check(403))).toBe(false);
		expect(isGone(check(429))).toBe(false);
	});

	it("does not call a host having a bad moment a broken link", () => {
		expect(isGone(check(500))).toBe(false);
		expect(isGone(check(503))).toBe(false);
	});

	it("says nothing about an unconfirmed network error", () => {
		expect(
			isGone({
				url: "https://elsewhere.test/x",
				httpStatus: null,
				fetchError: "boom",
				confirmed: false,
			}),
		).toBe(false);
	});
});
