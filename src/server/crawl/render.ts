import { chromium } from "playwright";

/**
 * What a page does when a browser actually runs it.
 *
 * Everything else in this directory reads bytes a server sent. This module is
 * the first thing that executes a client's JavaScript, and the difference is
 * worth stating plainly: a fetch costs a request, a render costs seconds and a
 * process. That is why only a small, named sample reaches this code — see
 * `sample.ts` for the rule and the measurements behind it.
 *
 * Two things are collected, and only two. **Console errors**, which are the
 * page's own runtime reporting its own failure — as direct an assertion as a
 * site makes about itself. And **Core Web Vitals**, read from the browser's own
 * PerformanceObserver rather than computed by us, so the numbers are the
 * browser's and can be checked against anyone's devtools.
 *
 * What is deliberately absent is a score. FR-028 asks for "standard page
 * performance scores"; a 0-100 composite is an index this product would be
 * asserting, and the same argument that kept a quality score out of the trend
 * keeps a performance grade out of here. The measurements are observations; a
 * grade is an opinion of them.
 *
 * **Failure here must never fail the run.** The crawl aborts on a burst of
 * failures because a struggling site should not be hammered. A browser that
 * cannot launch, or a page that never settles, is our problem and not the
 * client's — so it is recorded as "not measured" and the run carries on. A run
 * that failed because our browser did would be reporting our infrastructure as
 * the client's defect.
 */

export type Vitals = {
	/** Time to first byte, in milliseconds. */
	ttfbMs: number | null;
	/** Largest Contentful Paint, in milliseconds. */
	lcpMs: number | null;
	/** Cumulative Layout Shift, unitless. */
	cls: number | null;
};

export type ConsoleSample = {
	/** Truncated at capture: a stack trace is unbounded and a row is not. */
	message: string;
	/** The origin of the script that failed, where the page reported one. */
	source: string | null;
	/** Whether that script came from the site being checked. */
	firstParty: boolean;
};

export type PageObservation = {
	url: string;
	vitals: Vitals;
	/** Errors from the site's own scripts. */
	firstPartyErrors: number;
	/** Errors from scripts the site loaded from elsewhere. */
	thirdPartyErrors: number;
	/** Up to {@link MAX_CONSOLE_SAMPLES} of the messages, for the finding to cite. */
	samples: ConsoleSample[];
	/** Why this page has no measurement, or null when it has one. */
	renderError: string | null;
};

export type RenderResult = {
	observations: PageObservation[];
	/**
	 * Whether the browser was usable at all.
	 *
	 * False means no page was measured and none could have been — a missing
	 * browser binary, a sandbox refusing to start. The rules must stay silent on
	 * an incomplete pass for the reason the sweeps do: a page we could not render
	 * has no console errors in the same sense that an unchecked link is not a
	 * working one.
	 */
	complete: boolean;
};

export type RenderOptions = {
	urls: string[];
	/** The origin whose scripts count as the site's own. */
	origin: string;
	/** Hard ceiling per page, so one page that never settles cannot stall a run. */
	perRenderTimeoutMs?: number;
};

/**
 * How many console messages are kept per page.
 *
 * A page in a redirect loop can emit thousands, and this record is written once
 * per sampled page. The counts above are exact; these are the evidence a reader
 * needs in order to recognise the error, and four is enough to do that.
 */
export const MAX_CONSOLE_SAMPLES = 4;

/** Longest a stored message may be. A stack trace is not a database column. */
export const MAX_MESSAGE_CHARS = 300;

const DEFAULT_RENDER_TIMEOUT_MS = 20_000;

/**
 * How long to wait after load for late shifts and a final LCP.
 *
 * Layout shift is cumulative and much of it happens after the load event — a
 * font swapping in, an ad slot filling. Measuring at load would systematically
 * report a better CLS than a visitor experiences, which is the direction of
 * error this product must never make.
 */
const SETTLE_MS = 1_500;

/**
 * The script the page runs on our behalf, to report what it observed itself.
 *
 * An immediately-invoked expression, not an arrow literal. `page.evaluate`
 * given a string evaluates it *as an expression*: a string beginning `() =>`
 * therefore produces the function and never calls it, and the caller receives
 * undefined where it expected the measurements.
 */
const COLLECT_VITALS = `(() => new Promise((resolve) => {
	let lcp = null;
	let cls = 0;

	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) lcp = entry.startTime;
		}).observe({ type: 'largest-contentful-paint', buffered: true });
	} catch {}

	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				if (!entry.hadRecentInput) cls += entry.value;
			}
		}).observe({ type: 'layout-shift', buffered: true });
	} catch {}

	setTimeout(() => {
		let ttfb = null;
		try {
			const nav = performance.getEntriesByType('navigation')[0];
			if (nav) ttfb = nav.responseStart;
		} catch {}
		resolve({ ttfbMs: ttfb, lcpMs: lcp, cls });
	}, ${SETTLE_MS});
}))()`;

const originOf = (url: string): string | null => {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
};

export async function renderSample(
	options: RenderOptions,
): Promise<RenderResult> {
	const {
		urls,
		origin,
		perRenderTimeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
	} = options;

	if (urls.length === 0) return { observations: [], complete: true };

	let browser: Awaited<ReturnType<typeof chromium.launch>>;
	try {
		browser = await chromium.launch({ headless: true });
	} catch {
		/**
		 * No browser, no measurements, and emphatically no findings. Reporting a
		 * site as free of console errors because we could not open a browser is
		 * the shape of claim this whole codebase is built to refuse.
		 */
		return { observations: [], complete: false };
	}

	const observations: PageObservation[] = [];

	try {
		for (const url of urls) {
			observations.push(
				await measure(browser, url, origin, perRenderTimeoutMs),
			);
		}
	} finally {
		await browser.close().catch(() => {});
	}

	return { observations, complete: true };
}

async function measure(
	browser: Awaited<ReturnType<typeof chromium.launch>>,
	url: string,
	origin: string,
	timeoutMs: number,
): Promise<PageObservation> {
	const empty: PageObservation = {
		url,
		vitals: { ttfbMs: null, lcpMs: null, cls: null },
		firstPartyErrors: 0,
		thirdPartyErrors: 0,
		samples: [],
		renderError: null,
	};

	/**
	 * A fresh context per page: no cookies, no cache and no service worker
	 * carried from the last one. A second page measured against a warm cache
	 * would report a speed no first-time visitor will ever see.
	 */
	const context = await browser.newContext();
	const page = await context.newPage();

	let firstPartyErrors = 0;
	let thirdPartyErrors = 0;
	const samples: ConsoleSample[] = [];

	const record = (message: string, source: string | null) => {
		const from = source === null ? null : originOf(source);
		const firstParty = from === null || from === origin;
		if (firstParty) firstPartyErrors += 1;
		else thirdPartyErrors += 1;

		if (samples.length < MAX_CONSOLE_SAMPLES) {
			samples.push({
				message: message.slice(0, MAX_MESSAGE_CHARS),
				source: from,
				firstParty,
			});
		}
	};

	page.on("console", (message) => {
		if (message.type() !== "error") return;
		record(message.text(), message.location().url || null);
	});

	/**
	 * An uncaught exception is a console error by any reading, and the page
	 * reports it on a different channel. Missing it would let the most serious
	 * class of failure — the one that stops the page working — go unreported
	 * while lesser ones were counted.
	 */
	page.on("pageerror", (error) => {
		record(error.message, null);
	});

	try {
		await page.goto(url, { waitUntil: "load", timeout: timeoutMs });

		const vitals = (await page.evaluate(COLLECT_VITALS)) as Vitals;

		return { ...empty, vitals, firstPartyErrors, thirdPartyErrors, samples };
	} catch (caught) {
		/**
		 * Recorded, not thrown. The page still gets a row saying why it has no
		 * measurement, because a page missing from the results and a page that
		 * timed out look identical to a reader otherwise.
		 *
		 * The console counts collected before the failure are kept: a page that
		 * threw on load told us something true about itself on the way down.
		 */
		return {
			...empty,
			firstPartyErrors,
			thirdPartyErrors,
			samples,
			renderError:
				caught instanceof Error
					? caught.message.slice(0, MAX_MESSAGE_CHARS)
					: String(caught).slice(0, MAX_MESSAGE_CHARS),
		};
	} finally {
		await context.close().catch(() => {});
	}
}
