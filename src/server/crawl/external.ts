/**
 * Checking the links that leave the client's site.
 *
 * This is the first code in the product to send a request to a host nobody
 * invited us to. The crawl proper is same-origin by construction — the operator
 * pointed it at a site they are authorised to check — and every politeness
 * guarantee in `crawler.ts` was written for that one relationship. None of it
 * says anything about a third party.
 *
 * So this module adds what the same-origin model never needed: a per-host delay,
 * a bound on how many requests a sweep may make at all, a `429` that is actually
 * respected, and — most importantly — a failure budget of its own, so a batch of
 * dead third-party hosts cannot abort the crawl of the client's site.
 *
 * It shares the crawl's pacer rather than keeping its own, so the total rate
 * against the whole world stays what the operator configured.
 */

/**
 * The crawl's request pacer, lent to this module.
 *
 * Passed in rather than reconstructed, so a sweep cannot run at a rate the crawl
 * would not. `crawler.ts` does not export it, which keeps its own guarantee
 * intact: a caller cannot opt out of the ceiling by forgetting to wrap
 * something.
 */
export type Pacer = { claim: () => Promise<void> };

export type ExternalCheck = {
	url: string;
	httpStatus: number | null;
	fetchError: string | null;
	/** Whether a network error survived a second request. */
	confirmed: boolean;
};

export type ExternalSweep = {
	checked: ExternalCheck[];
	/**
	 * Whether the sweep got through everything it was given.
	 *
	 * False when a cap or the failure budget stopped it. A rule must stay silent
	 * about an incomplete sweep: an unchecked link is not a broken one.
	 */
	complete: boolean;
};

export type ExternalOptions = {
	urls: string[];
	pacer: Pacer;
	requestTimeoutMs: number;
	/**
	 * Minimum gap between two requests to the *same* host.
	 *
	 * The crawl's own inter-request delay, reused rather than reinvented: no
	 * third party should receive requests faster than the site we were actually
	 * invited to crawl. The global pacer bounds the total rate; nothing before
	 * this bounded the rate against any one host.
	 */
	perHostDelayMs: number;
	/**
	 * Ceiling on requests this sweep may make.
	 *
	 * Derived rather than chosen: the caller passes the number of pages the crawl
	 * recorded, so a sweep can at worst double the run. That is a bound an
	 * operator can reason about from the run they already agreed to.
	 */
	maxRequests: number;
};

/**
 * Statuses that mean the target is gone, as opposed to closed to us.
 *
 * The distinction is the whole of `context/foundation/lessons.md` applied to a
 * third party. `404` and `410` are the host saying the resource does not exist —
 * a fact about the link. `401`, `403` and `429` are the host saying *we* may not
 * have it, which is a fact about being a bot, and reporting it would put a
 * defect on the client's site for someone else's access policy.
 *
 * A `5xx` is excluded for a different reason: it is the host having a bad
 * moment, and a link to a site that is briefly down is not a broken link.
 */
const GONE = new Set([404, 410]);

/** Statuses that mean "this host does not do HEAD", per the HTTP specification. */
const HEAD_UNSUPPORTED = new Set([405, 501]);

/**
 * The share of network failures at which a sweep stops.
 *
 * The crawl's own failure-rate threshold and sample size, reused deliberately.
 * Both were argued out against a real site and are recorded in `crawler.ts`; a
 * second, differently-chosen number here would be a number nobody defended.
 *
 * What it protects against is different, though: not the client's site
 * struggling, but our own network being the problem. If a third of everything we
 * ask for is failing at the transport layer, the likeliest explanation is this
 * end, and every finding the sweep produced would be about us.
 */
const FAILURE_RATE = 0.3;
const FAILURE_RATE_SAMPLE = 20;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hostOf(url: string): string | null {
	try {
		return new URL(url).host;
	} catch {
		return null;
	}
}

/**
 * Reads `Retry-After`, which may be seconds or an HTTP date.
 *
 * Honoured rather than noted. A `429` is a host asking us to stop, and it is
 * invisible to every abort mechanism the crawl has — the failure predicate
 * counts only 5xx and network errors — so without this the sweep would keep
 * asking a host that explicitly said no.
 */
function retryAfterMs(value: string | null): number | null {
	if (value === null) return null;

	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

	const date = Date.parse(value);
	return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * Requests every URL once, HEAD first, and reports what each host said.
 *
 * Judging is left to the rule. This returns observations.
 */
export async function checkExternalLinks(
	options: ExternalOptions,
): Promise<ExternalSweep> {
	const { urls, pacer, requestTimeoutMs, perHostDelayMs, maxRequests } =
		options;

	const checked: ExternalCheck[] = [];
	/** Earliest a given host may be asked again. */
	const hostReadyAt = new Map<string, number>();
	/** Hosts that asked us to stop, skipped for the rest of the sweep. */
	const refused = new Set<string>();

	let attempted = 0;
	let networkFailures = 0;
	let complete = true;

	async function request(url: string, method: "HEAD" | "GET") {
		await pacer.claim();

		const host = hostOf(url);
		if (host !== null) {
			const readyAt = hostReadyAt.get(host) ?? 0;
			const wait = readyAt - Date.now();
			if (wait > 0) await sleep(wait);
			hostReadyAt.set(host, Date.now() + perHostDelayMs);
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

		try {
			const response = await fetch(url, {
				method,
				signal: controller.signal,
				redirect: "follow",
			});
			/**
			 * The body is never read. A HEAD has none, and on the GET fallback we
			 * want the status and nothing else — reading megabytes from a stranger's
			 * server to learn what its status line already said would be rude and
			 * unbounded, which is the response-size concern this sweep introduces.
			 */
			return { response, error: null as string | null };
		} catch (caught) {
			return {
				response: null,
				error: caught instanceof Error ? caught.message : String(caught),
			};
		} finally {
			clearTimeout(timer);
		}
	}

	for (const url of urls) {
		if (attempted >= maxRequests) {
			complete = false;
			break;
		}

		if (
			attempted >= FAILURE_RATE_SAMPLE &&
			networkFailures / attempted >= FAILURE_RATE
		) {
			complete = false;
			break;
		}

		const host = hostOf(url);
		if (host !== null && refused.has(host)) continue;

		attempted += 1;
		let outcome = await request(url, "HEAD");

		/**
		 * A host that does not implement HEAD, answered again with GET. Only for
		 * the two statuses the specification defines for it — anything else is the
		 * host's answer to the question we asked, and asking twice would double the
		 * load to learn nothing.
		 */
		if (
			outcome.response !== null &&
			HEAD_UNSUPPORTED.has(outcome.response.status)
		) {
			attempted += 1;
			outcome = await request(url, "GET");
		}

		if (outcome.response?.status === 429) {
			const wait = retryAfterMs(outcome.response.headers.get("retry-after"));
			/**
			 * Deferred rather than retried immediately, and the host is then left
			 * alone for the rest of the sweep. Waiting out a long `Retry-After`
			 * inside a run would stall it; the honest record is that we did not
			 * check this link.
			 */
			if (host !== null) {
				refused.add(host);
				if (wait !== null) hostReadyAt.set(host, Date.now() + wait);
			}
			continue;
		}

		if (outcome.error !== null) {
			networkFailures += 1;

			/**
			 * A second look, on the same terms the crawl gives its own failures. A
			 * name that does not resolve twice is a dead domain; one that failed once
			 * may be a moment of ours.
			 */
			attempted += 1;
			const second = await request(url, "HEAD");
			const confirmed = second.error !== null;

			checked.push({
				url,
				httpStatus: second.response?.status ?? null,
				fetchError: second.error ?? outcome.error,
				confirmed,
			});
			continue;
		}

		checked.push({
			url,
			httpStatus: outcome.response?.status ?? null,
			fetchError: null,
			confirmed: false,
		});
	}

	return { checked, complete };
}

/** Whether an observation is the host saying the resource is gone. */
export function isGone(check: ExternalCheck): boolean {
	if (check.fetchError !== null) return check.confirmed;
	return check.httpStatus !== null && GONE.has(check.httpStatus);
}
