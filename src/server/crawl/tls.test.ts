import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { probeCertificate } from "./tls";

/**
 * The probe's contract, which is mostly about when it stays quiet.
 *
 * What a certificate *means* is asserted in `site-shapes.test.ts`, where the
 * observation is stated directly — the same split every other rule here uses, so
 * that a failure says whether the reading or the judging was wrong. Minting a
 * real certificate would need OpenSSL or a certificate authority, and this
 * bucket's promise is that it runs on a clone with only `npm install` behind it.
 *
 * That leaves the paths that need no certificate at all, and they are the ones
 * `context/foundation/lessons.md` cares about: every one of them must produce
 * silence rather than a finding, because a probe that could not run is a fact
 * about us and not about the client's site.
 */

describe("reading a site's certificate", () => {
	it("says nothing about an origin served over plain http", async () => {
		/**
		 * There is no certificate to describe. Reporting one as missing would be a
		 * finding about the scheme the operator chose rather than about the site —
		 * and the crawl is pointed wherever the operator pointed it.
		 */
		const plain = createServer((_, res) => res.end("ok"));
		await new Promise<void>((resolve) =>
			plain.listen(0, "127.0.0.1", () => resolve()),
		);
		const { port } = plain.address() as AddressInfo;

		const observed = await probeCertificate(`http://127.0.0.1:${port}`, 5_000);

		await new Promise<void>((resolve) => plain.close(() => resolve()));
		expect(observed).toBeNull();
	});

	it("says nothing when the connection is refused", async () => {
		expect(await probeCertificate("https://127.0.0.1:1", 2_000)).toBeNull();
	});

	it("says nothing when the port speaks http rather than TLS", async () => {
		/**
		 * A real shape: an origin recorded as https that is actually serving plain
		 * http on that port. The handshake fails, and the honest report is nothing.
		 */
		const plain = createServer((_, res) => res.end("ok"));
		await new Promise<void>((resolve) =>
			plain.listen(0, "127.0.0.1", () => resolve()),
		);
		const { port } = plain.address() as AddressInfo;

		const observed = await probeCertificate(`https://127.0.0.1:${port}`, 2_000);

		await new Promise<void>((resolve) => plain.close(() => resolve()));
		expect(observed).toBeNull();
	});

	it("says nothing about a malformed origin", async () => {
		expect(await probeCertificate("not a url", 2_000)).toBeNull();
	});
});
