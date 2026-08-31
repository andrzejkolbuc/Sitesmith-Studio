import Link from "next/link";

import { auth } from "~/server/auth";

/**
 * The hero is the product's own idea, drawn.
 *
 * A page family should mirror itself across languages; this tool exists to find
 * the cells where it does not. Rather than describe that, the page shows one —
 * a small parity strip in the same marks the application uses, so a visitor
 * understands the job before reading a word of it.
 */
const DEMO_LOCALES = ["en", "de", "fr", "es"] as const;

const DEMO_ROWS: Array<{ path: string; cells: string[] }> = [
	{ path: "/pricing", cells: ["·", "·", "○", "·"] },
	{ path: "/contact", cells: ["·", "✕", "·", "·"] },
	{ path: "/about-us", cells: ["·", "·", "·", "·"] },
	{ path: "/careers", cells: ["·", "·", "·", "○"] },
];

export default async function Home() {
	const session = await auth();

	return (
		<main className="flex min-h-screen items-center">
			<div className="mx-auto w-full max-w-3xl px-6 py-20">
				<h1 className="font-display font-semibold text-5xl text-ink tracking-tight sm:text-6xl">
					Sitesmith Studio
				</h1>
				<p className="mt-4 max-w-prose text-ink-soft text-lg leading-relaxed">
					Checks multilingual client sites before they go live.
				</p>

				<div className="mt-12 border-rule border-y py-6">
					<table className="w-full border-collapse text-left">
						<caption className="mb-4 text-left font-mono text-ink-faint text-xs uppercase tracking-wider">
							One page, four languages, two problems
						</caption>
						<thead>
							<tr>
								<th className="w-1/2 pb-2 font-normal" scope="col">
									<span className="sr-only">Page</span>
								</th>
								{DEMO_LOCALES.map((locale) => (
									<th
										className="pb-2 text-center font-medium font-mono text-ink text-xs"
										key={locale}
										scope="col"
									>
										{locale}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{DEMO_ROWS.map((row) => (
								<tr key={row.path}>
									<th
										className="py-2 font-mono font-normal text-ink-soft text-xs"
										scope="row"
									>
										{row.path}
									</th>
									{row.cells.map((cell, index) => (
										<td
											className={`py-2 text-center text-sm ${
												cell === "✕"
													? "font-medium text-mark"
													: cell === "○"
														? "font-medium text-flag"
														: "text-ink-faint"
											}`}
											key={`${row.path}-${DEMO_LOCALES[index]}`}
										>
											{cell}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>

				<p className="mt-6 max-w-prose text-ink-soft text-sm leading-relaxed">
					A crawl reads the hreflang a site already publishes, works out which
					pages are translations of each other, and reports only the gaps —{" "}
					<span className="text-flag">a language that was never published</span>
					, or <span className="text-mark">one that answers with an error</span>
					.
				</p>

				<Link
					className="mt-10 inline-block rounded-sm bg-ink px-6 py-3 font-medium text-paper text-sm transition-opacity hover:opacity-85"
					href={session?.user ? "/projects" : "/signin"}
				>
					{session?.user ? "Go to your projects" : "Sign in"}
				</Link>
			</div>
		</main>
	);
}
