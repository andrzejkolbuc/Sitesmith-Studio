"use client";

import { api } from "~/trpc/react";
import {
	bandFor,
	type Observation,
	orderObservations,
	parseCls,
	performanceState,
} from "./performance";

/**
 * What a browser saw, for the few pages a run rendered.
 *
 * The section states its own coverage in its header, because everything else on
 * this page describes the whole crawl and a reader carrying that habit here
 * would read a clean table as a statement about their site rather than about a
 * dozen of its pages.
 *
 * The colour vocabulary is the parity grid's: quiet unless something needs a
 * person. Google's thresholds decide which is which, and are attributed — they
 * are the one number here we did not take from the site, and the reader is
 * entitled to know whose they are.
 */

const BAND_STYLE: Record<string, string> = {
	good: "text-ink-soft",
	"needs-improvement": "text-flag",
	poor: "text-mark",
	unmeasured: "text-ink-faint",
};

const ms = (value: number | null): string =>
	value === null
		? "—"
		: value >= 1000
			? `${(value / 1000).toFixed(1)}s`
			: `${Math.round(value)}ms`;

const cls = (value: number | null): string =>
	value === null ? "—" : value.toFixed(3);

export function Performance({ runId }: { runId: string }) {
	const data = api.project.runObservations.useQuery({ runId });

	if (!data.data) return null;

	const { observations, summary, pagesCrawled } = data.data;
	const state = performanceState(summary, observations, pagesCrawled);

	/**
	 * A run that predates rendering says nothing at all. There is no absence to
	 * explain — the feature did not exist when the run happened — and a notice
	 * about it would be about us rather than about their site.
	 */
	if (state.kind === "not_recorded") return null;

	return (
		<section className="mt-12">
			<header className="flex flex-wrap items-baseline justify-between gap-3">
				<h2 className="font-display font-semibold text-ink text-xl">
					Performance
				</h2>
				{state.kind === "measured" ? (
					<p className="tnum text-ink-faint text-xs">{state.coverage}</p>
				) : null}
			</header>

			{state.kind === "unavailable" ? (
				<p className="mt-4 max-w-prose border-rule border-l-2 py-1 pl-4 text-ink-soft text-sm leading-relaxed">
					No browser was available during this run, so no page was measured.
					This says nothing about the site — the next run will measure a sample
					of pages.
				</p>
			) : null}

			{state.kind === "nothing_to_measure" ? (
				<p className="mt-4 max-w-prose border-rule border-l-2 py-1 pl-4 text-ink-soft text-sm leading-relaxed">
					This run found no page worth measuring — nothing that loaded as a page
					a browser could render.
				</p>
			) : null}

			{state.kind === "measured" ? (
				<>
					<div className="mt-4 overflow-x-auto">
						<table className="w-full min-w-[36rem] border-collapse text-left">
							<thead>
								<tr className="border-rule border-b">
									<th className="py-2 pr-4 font-mono font-normal text-ink-faint text-xs uppercase tracking-wider">
										Page
									</th>
									<th className="w-20 px-2 py-2 text-right font-mono font-normal text-ink-faint text-xs uppercase tracking-wider">
										TTFB
									</th>
									<th className="w-20 px-2 py-2 text-right font-mono font-normal text-ink-faint text-xs uppercase tracking-wider">
										LCP
									</th>
									<th className="w-20 px-2 py-2 text-right font-mono font-normal text-ink-faint text-xs uppercase tracking-wider">
										CLS
									</th>
									<th className="w-24 px-2 py-2 text-right font-mono font-normal text-ink-faint text-xs uppercase tracking-wider">
										Errors
									</th>
								</tr>
							</thead>
							<tbody>
								{orderObservations(observations).map((observation) => (
									<Row key={observation.url} observation={observation} />
								))}
							</tbody>
						</table>
					</div>

					<p className="mt-5 max-w-prose text-ink-faint text-xs">
						A sample, not the whole site: measuring every page in a browser
						takes hours. Pages are chosen from those the site links to most, in
						each language the project declares. Colour follows Google's
						published Core Web Vitals thresholds; the numbers are the browser's
						own.
					</p>
				</>
			) : null}
		</section>
	);
}

/**
 * A shape as well as a colour.
 *
 * The band was carried by colour alone — same glyph, same weight, same format
 * for good, needs-improvement and poor. Printed, or read by anyone who does not
 * separate amber from red, the entire verdict collapsed into three identical
 * grey numbers. Every other signal in this interface already pairs colour with a
 * shape or a word: the parity grid has its glyphs, a new finding says "New".
 * This was the one that did not.
 */
const BAND_MARK: Record<string, string> = {
	good: "",
	"needs-improvement": "△",
	poor: "▲",
	unmeasured: "",
};

const BAND_MEANING: Record<string, string> = {
	"needs-improvement": "needs improvement",
	poor: "poor",
};

function BandMark({ band }: { band: string }) {
	const mark = BAND_MARK[band];
	if (!mark) return null;

	return (
		<span className="ml-1 text-xs">
			<span aria-hidden="true">{mark}</span>
			<span className="sr-only">{BAND_MEANING[band]}</span>
		</span>
	);
}

function Row({ observation }: { observation: Observation }) {
	const shift = parseCls(observation.cls);

	if (observation.renderError !== null) {
		return (
			<tr className="border-rule-soft border-b">
				<th
					className="max-w-0 truncate py-2.5 pr-4 font-mono font-normal text-ink-soft text-xs"
					scope="row"
					title={observation.url}
				>
					{pathOf(observation.url)}
				</th>
				{/*
				 * Not zeroes across the row. A page that could not be measured has no
				 * vitals, and printing zeros would make the one page we know least
				 * about look like the fastest on the site.
				 */}
				<td className="px-2 py-2.5 text-ink-faint text-xs italic" colSpan={4}>
					not measured — {observation.renderError}
				</td>
			</tr>
		);
	}

	const ttfbBand = bandFor("ttfbMs", observation.ttfbMs);
	const lcpBand = bandFor("lcpMs", observation.lcpMs);
	const clsBand = bandFor("cls", shift);

	return (
		<tr className="border-rule-soft border-b">
			<th
				className="max-w-0 truncate py-2.5 pr-4 font-mono font-normal text-ink-soft text-xs"
				scope="row"
				title={observation.url}
			>
				{pathOf(observation.url)}
			</th>
			<td
				className={`tnum px-2 py-2.5 text-right text-sm ${BAND_STYLE[ttfbBand]}`}
			>
				{ms(observation.ttfbMs)}
				<BandMark band={ttfbBand} />
			</td>
			<td
				className={`tnum px-2 py-2.5 text-right text-sm ${BAND_STYLE[lcpBand]}`}
			>
				{ms(observation.lcpMs)}
				<BandMark band={lcpBand} />
			</td>
			<td
				className={`tnum px-2 py-2.5 text-right text-sm ${BAND_STYLE[clsBand]}`}
			>
				{cls(shift)}
				<BandMark band={clsBand} />
			</td>
			<td className="tnum px-2 py-2.5 text-right text-ink-soft text-sm">
				{observation.firstPartyErrors === 0 ? (
					<span className="text-ink-faint">0</span>
				) : (
					<span className="font-medium text-mark">
						{observation.firstPartyErrors}
					</span>
				)}
				{observation.thirdPartyErrors > 0 ? (
					<span
						className="ml-1 text-ink-faint text-xs"
						title={`${observation.thirdPartyErrors} from scripts loaded from other sites, not reported as findings`}
					>
						(+{observation.thirdPartyErrors})
					</span>
				) : null}
			</td>
		</tr>
	);
}

function pathOf(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return url;
	}
}
