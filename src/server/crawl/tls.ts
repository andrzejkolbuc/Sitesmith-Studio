import { connect } from "node:tls";

/**
 * What a site's certificate says about itself.
 *
 * A separate module from the crawler, and reached by a separate connection,
 * because the HTTP client cannot supply this: a WHATWG `fetch` Response exposes
 * no socket and no peer certificate, so there is nothing to read at the one call
 * site the rest of the crawl goes through.
 *
 * The cost is a single TLS handshake per origin rather than per page, which is
 * why this is affordable at all under NFR-1 — one connection against a run that
 * already makes hundreds of requests is not a load question.
 *
 * Nothing here judges. The rule decides what counts as a problem; this reports
 * what the server presented, including a certificate that would have been
 * rejected — which is the whole point, since a refused handshake teaches us
 * nothing about *why* it was refused.
 */

export type CertificateObservation = {
	origin: string;
	issuer: string | null;
	subject: string | null;
	/** ISO date, as the certificate states it. */
	validFrom: string | null;
	validTo: string | null;
	subjectAltNames: string[];
	/**
	 * Node's verdict on the chain, verbatim, or null when it accepted the
	 * certificate.
	 *
	 * Carried as the code rather than as a boolean because the codes distinguish
	 * problems a reader would act on differently — a name mismatch is a
	 * configuration error, an untrusted chain is usually a missing intermediate.
	 */
	authorizationError: string | null;
};

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A distinguished-name field, as one string.
 *
 * Node types these as `string | string[]` because a DN may legitimately repeat
 * an attribute. A finding quotes the issuer back to a reader, so the repeated
 * form is joined rather than dropped or picked from arbitrarily.
 */
function name(value: string | string[] | undefined): string | null {
	if (value === undefined) return null;
	return Array.isArray(value) ? value.join(", ") || null : value || null;
}

/** Certificate dates arrive in OpenSSL's format; ISO is what a finding quotes. */
function toIso(value: string | undefined): string | null {
	if (!value) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Opens one TLS connection to `origin` and reports the certificate presented.
 *
 * Returns null rather than throwing on every failure path — a plain-http origin,
 * a refused connection, a timeout. A probe that could not run is silence, not a
 * finding: reporting "we could not check your certificate" as a defect on the
 * client's site is a claim about us, which is the distinction
 * `context/foundation/lessons.md` exists to enforce.
 */
export function probeCertificate(
	origin: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<CertificateObservation | null> {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return Promise.resolve(null);
	}

	// A site served over plain http has no certificate to say anything about.
	if (url.protocol !== "https:") return Promise.resolve(null);

	const host = url.hostname;
	const port = url.port === "" ? 443 : Number(url.port);

	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: CertificateObservation | null) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};

		const socket = connect({
			host,
			port,
			/**
			 * Omitted for an IP literal, which RFC 6066 does not permit as an SNI
			 * name — Node warns today and will drop it later. A site addressed by IP
			 * has no name to ask for, so there is nothing lost.
			 */
			...(/^[\d.]+$/.test(host) || host.includes(":")
				? {}
				: { servername: host }),
			/**
			 * The load-bearing option.
			 *
			 * Left at its default, an expired or misnamed certificate aborts the
			 * handshake and we learn only that something failed — which is exactly
			 * the case the rule exists to describe. Accepting the connection lets us
			 * read the certificate *and* Node's verdict on it, and nothing is sent
			 * over the socket: it is opened, read and destroyed.
			 */
			rejectUnauthorized: false,
		});

		socket.setTimeout(timeoutMs, () => finish(null));
		socket.once("error", () => finish(null));

		socket.once("secureConnect", () => {
			const certificate = socket.getPeerCertificate();

			// An empty object is what Node returns when there is no peer certificate.
			if (!certificate || Object.keys(certificate).length === 0) {
				finish(null);
				return;
			}

			finish({
				origin: url.origin,
				issuer: name(certificate.issuer?.O) ?? name(certificate.issuer?.CN),
				subject: name(certificate.subject?.CN),
				validFrom: toIso(certificate.valid_from),
				validTo: toIso(certificate.valid_to),
				subjectAltNames: (certificate.subjectaltname ?? "")
					.split(",")
					.map((entry) => entry.trim().replace(/^DNS:/i, ""))
					.filter((entry) => entry !== ""),
				authorizationError: socket.authorized
					? null
					: ((socket.authorizationError as unknown as string) ?? "UNKNOWN"),
			});
		});
	});
}
