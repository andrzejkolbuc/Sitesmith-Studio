"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { api } from "~/trpc/react";

/**
 * The delete control for one project, and the confirmation in front of it.
 *
 * A client component for the reason `team-panel.tsx` is one: the list it sits in
 * is rendered on the server, but this action has something to say afterwards —
 * a refusal when a check is still running — and an inline server action can only
 * return that through the URL.
 *
 * **The confirmation is a second button, not `window.confirm`.** A native dialog
 * is untestable from the browser suite without special handling, cannot be
 * styled, and reads as a browser warning rather than as part of the product. Two
 * clicks on two labels is the same protection, stated in the page's own voice
 * and assertable by what the user can see.
 */
export function ArchiveProject({
	projectId,
	projectName,
}: {
	projectId: string;
	projectName: string;
}) {
	const router = useRouter();
	const [confirming, setConfirming] = useState(false);

	const archive = api.project.archive.useMutation({
		/**
		 * `router.refresh()` rather than a local filter. The list is a server
		 * component reading `project.list`, so the server is the only thing that
		 * knows what the list is now — hiding the row here would leave the page
		 * agreeing with itself and disagreeing with the database.
		 */
		onSuccess: () => {
			setConfirming(false);
			router.refresh();
		},
	});

	if (archive.isPending) {
		return <span className="text-ink-faint text-sm">Deleting…</span>;
	}

	if (!confirming) {
		return (
			<div className="flex flex-col items-end gap-1">
				<button
					className="text-ink-faint text-sm underline-offset-4 hover:text-ink hover:underline"
					onClick={() => setConfirming(true)}
					type="button"
				>
					Delete
				</button>

				{/**
				 * The refusal survives the return to the resting state, because it is
				 * the whole reason the delete did not happen and the user has to be
				 * able to read it after the buttons go back to normal.
				 */}
				{archive.error ? (
					<span className="max-w-xs text-right text-mark text-xs">
						{archive.error.message}
					</span>
				) : null}
			</div>
		);
	}

	return (
		<div className="flex flex-col items-end gap-1">
			{/**
			 * The name is quoted because it is a name. Without the quotes a project
			 * called "Delete This Site" renders as "Delete Delete This Site?", and
			 * any name that reads as a sentence does something similar — the user
			 * cannot tell where our question ends and their project begins.
			 */}
			<span className="text-ink-soft text-xs">Delete “{projectName}”?</span>

			<span className="flex items-center gap-3">
				<button
					className="font-medium text-mark text-sm underline-offset-4 hover:underline"
					onClick={() => archive.mutate({ projectId })}
					type="button"
				>
					Delete permanently
				</button>

				<button
					className="text-ink-faint text-sm underline-offset-4 hover:text-ink hover:underline"
					onClick={() => setConfirming(false)}
					type="button"
				>
					Keep
				</button>
			</span>

			{/**
			 * What is actually lost, said before the second click rather than after
			 * it. Run history is the thing a reader would not think to ask about, and
			 * it is the expensive half of what a project holds.
			 */}
			<span className="max-w-xs text-right text-ink-faint text-xs">
				Its run history and findings go with it.
			</span>
		</div>
	);
}
