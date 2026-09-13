"use client";

/**
 * What the report shows when it cannot be assembled.
 *
 * This segment gets its own boundary because of who opens it. Everywhere else in
 * the product the reader is the operator — they know what a stack trace is, and
 * Next's default error page, ugly as it is, tells them something true. This URL
 * is the one we hand to a client contact, and the default page there reads as the
 * agency's software falling over in front of their customer.
 *
 * Deliberately says nothing about the cause. The reader cannot act on a failed
 * query and should not be handed one; the person who can is named instead.
 */
export default function ReportError({
	reset,
}: {
	error: Error;
	reset: () => void;
}) {
	return (
		<main className="min-h-screen">
			<div className="mx-auto max-w-3xl px-6 py-14">
				<h1 className="font-display font-semibold text-3xl text-ink tracking-tight">
					This report could not be opened
				</h1>
				<p className="mt-4 max-w-prose text-ink-soft text-sm leading-relaxed">
					Something went wrong while putting this report together. Nothing is
					wrong with your site because of this — it is a problem at our end.
				</p>
				<p className="mt-2 max-w-prose text-ink-soft text-sm leading-relaxed">
					Try again in a moment. If it keeps happening, let the person who sent
					you this link know.
				</p>
				<button
					className="mt-6 border border-rule px-3 py-1.5 font-mono text-ink-soft text-xs hover:text-ink"
					data-no-print
					onClick={reset}
					type="button"
				>
					Try again
				</button>
			</div>
		</main>
	);
}
