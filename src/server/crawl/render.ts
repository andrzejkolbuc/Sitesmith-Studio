import { chromium, type Page } from "playwright";

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

export type Size = { width: number; height: number };

/**
 * Where a captured picture goes.
 *
 * A callback rather than a field on the result, because the result is small
 * structured data and a full-page PNG is not. Twelve of them held until the loop
 * ends is tens of megabytes, and the crawl's habit throughout this directory is
 * to write as it goes so memory stays flat. This also keeps the module free of
 * any database import: it hands over bytes and forgets them.
 */
export type SnapshotSink = (
	url: string,
	png: Buffer,
	size: Size,
) => Promise<void>;

export type SnapshotOptions = {
	/** CSS selectors painted over before the PNG exists. */
	masks: string[];
	onCapture: SnapshotSink;
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
	/**
	 * Why this page has no picture, or null when it was not asked for or was
	 * taken. Separate from `renderError` because a page can measure perfectly and
	 * still fail to photograph — an unparseable mask selector, a page too long to
	 * encode — and reporting the second as the first would lose the vitals.
	 */
	snapshotError: string | null;
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
	/** Absent means measure only, and no picture is taken. */
	snapshot?: SnapshotOptions;
};

/**
 * The size every snapshot is taken at.
 *
 * This number is **ours**, not the site's — the one place in the visual half
 * where the product picks something rather than reading it. That is exactly why
 * it is recorded on every snapshot row: a pair of pictures taken at different
 * viewports refuses comparison, rather than reporting every page on the site as
 * having changed the day we changed our mind about a width.
 *
 * A common desktop width, because a client site's desktop layout is the one the
 * agency looks at when deciding whether a deploy broke something. Mobile is a
 * second capture and a second set of bytes; it is deliberately out of scope.
 */
export const SNAPSHOT_VIEWPORT: Size = { width: 1280, height: 800 };

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

/**
 * How many viewport-heights the sweep will walk before giving up.
 *
 * A bound rather than a trust in `scrollHeight`: a page whose height grows as it
 * is scrolled — an infinite feed — would otherwise walk forever inside a
 * function whose whole job is to finish. Forty screens of 800px is 32,000px,
 * past the length of any page this product is meant to photograph.
 */
const MAX_SCROLL_STEPS = 40;

/** How long to pause on each screen, for whatever the scroll triggered. */
const SCROLL_DWELL_MS = 100;

/**
 * Walk the page to the bottom and back, so lazy content is actually there.
 *
 * `fullPage: true` does not do this. Playwright resizes to capture rather than
 * scrolling, so anything behind an `IntersectionObserver` — which on a modern
 * client site is most of the images — never loads, and every such region reads
 * as changed the moment one of them happens to load on a later run. The sweep is
 * what makes the picture a picture of the page rather than of its skeleton.
 *
 * An immediately-invoked expression for the reason `COLLECT_VITALS` is one:
 * `page.evaluate` given a string evaluates it as an expression, so a string
 * beginning `() =>` produces the function and never calls it.
 */
const SCROLL_SWEEP = `(() => new Promise((resolve) => {
	const step = window.innerHeight || 800;
	let screens = 0;

	/**
	 * The last screen is dwelt on before returning to the top.
	 *
	 * Scrolling to the bottom and back inside one synchronous block never renders
	 * the bottom at all, so the observer that was supposed to fire there never
	 * does — which silently defeats the entire sweep for whatever sits on the
	 * final screen. Every position, including the last, gets a frame to react in.
	 */
	const finish = () => {
		setTimeout(() => {
			window.scrollTo(0, 0);
			setTimeout(resolve, ${SCROLL_DWELL_MS * 3});
		}, ${SCROLL_DWELL_MS * 3});
	};

	const tick = () => {
		window.scrollTo(0, screens * step);
		screens += 1;

		const done =
			screens > ${MAX_SCROLL_STEPS} ||
			screens * step >= document.body.scrollHeight;

		setTimeout(done ? finish : tick, ${SCROLL_DWELL_MS});
	};

	tick();
}))()`;

const originOf = (url: string): string | null => {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
};

/**
 * A PNG's own dimensions, read from its header.
 *
 * The IHDR chunk sits at a fixed offset — eight bytes of signature, four of
 * length, four of type, then width and height as big-endian 32-bit integers — so
 * this needs no decoder and no dependency. Width and height are stored beside
 * the image because a full-page capture's height is a property of the page, and
 * a comparison has to know the two pictures are the same shape before it starts.
 */
function pngSize(png: Buffer): Size | null {
	if (png.length < 24) return null;
	if (png.toString("ascii", 12, 16) !== "IHDR") return null;

	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export async function renderSample(
	options: RenderOptions,
): Promise<RenderResult> {
	const {
		urls,
		origin,
		perRenderTimeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
		snapshot,
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
				await measure(browser, url, origin, perRenderTimeoutMs, snapshot),
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
	snapshot?: SnapshotOptions,
): Promise<PageObservation> {
	const empty: PageObservation = {
		url,
		vitals: { ttfbMs: null, lcpMs: null, cls: null },
		firstPartyErrors: 0,
		thirdPartyErrors: 0,
		samples: [],
		renderError: null,
		snapshotError: null,
	};

	/**
	 * A fresh context per page: no cookies, no cache and no service worker
	 * carried from the last one. A second page measured against a warm cache
	 * would report a speed no first-time visitor will ever see.
	 *
	 * The viewport is pinned rather than left to Playwright's default, because a
	 * picture is a claim about a rendering at a size and the size has to be one
	 * we chose on purpose and recorded.
	 */
	const context = await browser.newContext({ viewport: SNAPSHOT_VIEWPORT });
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

		/**
		 * The picture, and only after the vitals are in hand.
		 *
		 * Ordering is load-bearing: the sweep below scrolls the page, and layout
		 * shift caused by our own scrolling would land in the CLS reading that
		 * `SETTLE_MS` exists to protect. Measure first, then disturb.
		 */
		const snapshotError = snapshot
			? await capture(page, url, timeoutMs, snapshot)
			: null;

		return {
			...empty,
			vitals,
			firstPartyErrors,
			thirdPartyErrors,
			samples,
			snapshotError,
		};
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

/**
 * Takes the picture, and returns why it could not rather than throwing.
 *
 * Every failure mode here is ours: a mask selector the browser will not parse, a
 * page too long to encode, a sink that could not write. None of them are
 * statements about the client's site, and a run that failed because our
 * screenshot did would be reporting our infrastructure as their defect — which
 * is the argument the whole render half already rests on.
 */
async function capture(
	page: Page,
	url: string,
	timeoutMs: number,
	options: SnapshotOptions,
): Promise<string | null> {
	try {
		/** Bounded by construction — see MAX_SCROLL_STEPS — so it cannot hang. */
		await page.evaluate(SCROLL_SWEEP);

		const png = await page.screenshot({
			fullPage: true,
			/**
			 * Stops CSS animation and transitions at their first frame. Without it
			 * a spinner or a fading hero reports a difference on every run while
			 * nothing about the page has changed.
			 */
			animations: "disabled",
			caret: "hide",
			/**
			 * Painted over before the PNG exists, so the volatile region never
			 * enters storage. Nothing to leak, and an old snapshot never needs
			 * re-masking when the project's list changes.
			 */
			mask: options.masks.map((selector) => page.locator(selector)),
			timeout: timeoutMs,
		});

		const size = pngSize(png);
		if (!size) return "The capture did not produce a readable PNG.";

		await options.onCapture(url, png, size);
		return null;
	} catch (caught) {
		return caught instanceof Error
			? caught.message.slice(0, MAX_MESSAGE_CHARS)
			: String(caught).slice(0, MAX_MESSAGE_CHARS);
	}
}
