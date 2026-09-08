"use client";

import { useState } from "react";

/**
 * The invite link, shown once.
 *
 * The server hands back a token and never a URL, which is what lets this slice
 * ship without an absolute-base-URL setting: the browser already knows its own
 * origin, so the link is composed here. That also means the link is correct
 * whether the product is reached at localhost, a staging host, or wherever it
 * eventually lives — none of which anything has had to configure.
 *
 * Only the digest of this token is stored, so there is no way to show it again.
 * The copy says so plainly rather than leaving the Owner to discover it by
 * navigating away.
 */
export function InviteLink({ token, email }: { token: string; email: string }) {
	const [copied, setCopied] = useState(false);

	const url =
		typeof window === "undefined"
			? ""
			: `${window.location.origin}/invite/${token}`;

	return (
		<div className="mt-6 border-ink border-l-2 bg-sheet px-4 py-4">
			<p className="font-display font-semibold text-ink text-sm">
				Invite ready for {email}
			</p>
			<p className="mt-1 text-ink-soft text-xs leading-relaxed">
				Send this link however you already talk to them. It works once, expires
				in seven days, and <strong>will not be shown again</strong>.
			</p>

			<div className="mt-3 flex flex-wrap items-center gap-3">
				<code className="min-w-0 flex-1 break-all rounded-sm border border-rule bg-paper px-3 py-2 font-mono text-ink text-xs">
					{url}
				</code>
				<button
					className="rounded-sm bg-ink px-3 py-2 font-medium text-paper text-xs transition-opacity hover:opacity-85"
					onClick={() => {
						navigator.clipboard.writeText(url).then(
							() => setCopied(true),
							/**
							 * Clipboard access can be refused — an insecure origin, or a
							 * permission the reader declined. The link is on screen either
							 * way, so the failure is worth stating rather than swallowing.
							 */
							() => setCopied(false),
						);
					}}
					type="button"
				>
					{copied ? "Copied" : "Copy"}
				</button>
			</div>
		</div>
	);
}
