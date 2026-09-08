"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import { InviteLink } from "./invite-link";

/**
 * Who is in the workspace, and the controls to change that.
 *
 * A client component driving tRPC mutations, rather than the inline server
 * action the other forms in this product use. The reason is `issue`: it returns
 * a token that is shown exactly once, and a server action can only hand
 * something back to the page through the URL. A live invite link in the address
 * bar would be a bearer credential written into browser history and every
 * server log between here and there. Keeping it in mutation state costs one
 * client component and keeps the token off every surface that persists.
 */
export function TeamPanel() {
	const utils = api.useUtils();
	const members = api.invite.members.useQuery();
	const pending = api.invite.list.useQuery();
	const projects = api.project.list.useQuery();

	const [issued, setIssued] = useState<{ token: string; email: string } | null>(
		null,
	);
	const [role, setRole] = useState<"member" | "viewer">("member");

	const issue = api.invite.issue.useMutation({
		onSuccess: async (result) => {
			setIssued({ token: result.token, email: result.email });
			await utils.invite.list.invalidate();
		},
	});

	const revoke = api.invite.revoke.useMutation({
		onSuccess: async () => {
			await utils.invite.list.invalidate();
		},
	});

	const assign = api.invite.assign.useMutation({
		onSuccess: async () => {
			await utils.invite.members.invalidate();
		},
	});

	const projectName = (projectId: string | null) =>
		projects.data?.find((project) => project.id === projectId)?.name ??
		"a project";

	return (
		<>
			<section className="mt-12">
				<h2 className="font-display font-semibold text-2xl text-ink">
					Invite someone
				</h2>

				<form
					className="mt-5 flex flex-wrap items-end gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						const form = new FormData(event.currentTarget);
						const projectId = String(form.get("projectId") ?? "");

						issue.mutate({
							email: String(form.get("email") ?? ""),
							role,
							projectId: projectId || undefined,
						});
					}}
				>
					<label className="flex min-w-56 flex-1 flex-col gap-2 text-sm">
						<span className="font-mono text-ink-faint text-xs uppercase tracking-wider">
							Email
						</span>
						<input
							className="rounded-sm border border-rule bg-sheet px-3 py-2.5 text-ink text-sm outline-none focus:border-ink"
							name="email"
							required
							type="email"
						/>
					</label>

					<label className="flex flex-col gap-2 text-sm">
						<span className="font-mono text-ink-faint text-xs uppercase tracking-wider">
							Role
						</span>
						<select
							className="rounded-sm border border-rule bg-sheet px-3 py-2.5 text-ink text-sm outline-none focus:border-ink"
							name="role"
							onChange={(event) =>
								setRole(event.target.value as "member" | "viewer")
							}
							value={role}
						>
							<option value="member">Team member</option>
							<option value="viewer">Client viewer</option>
						</select>
					</label>

					<label className="flex flex-col gap-2 text-sm">
						<span className="font-mono text-ink-faint text-xs uppercase tracking-wider">
							Project
						</span>
						<select
							className="rounded-sm border border-rule bg-sheet px-3 py-2.5 text-ink text-sm outline-none focus:border-ink"
							name="projectId"
							/**
							 * A client viewer exists only in relation to one project, so the
							 * field stops being optional for them. The server refuses the
							 * combination too — this only keeps the form from offering it.
							 */
							required={role === "viewer"}
						>
							{role === "viewer" ? null : (
								<option value="">No project yet</option>
							)}
							{projects.data?.map((project) => (
								<option key={project.id} value={project.id}>
									{project.name}
								</option>
							))}
						</select>
					</label>

					<button
						className="rounded-sm bg-ink px-4 py-2.5 font-medium text-paper text-sm transition-opacity hover:opacity-85 disabled:opacity-50"
						disabled={issue.isPending}
						type="submit"
					>
						{issue.isPending ? "Creating…" : "Create invite"}
					</button>
				</form>

				{issue.error ? (
					<p
						className="mt-4 border-mark border-l-2 bg-mark-soft px-4 py-3 text-mark text-sm"
						role="alert"
					>
						{issue.error.message}
					</p>
				) : null}

				{issued ? (
					<InviteLink email={issued.email} token={issued.token} />
				) : null}
			</section>

			<section className="mt-14">
				<h2 className="font-display font-semibold text-2xl text-ink">
					Pending invites
				</h2>

				{pending.data && pending.data.length > 0 ? (
					<ul className="mt-4">
						{pending.data.map((invite) => (
							<li
								className="flex flex-wrap items-center justify-between gap-4 border-rule-soft border-b py-4"
								key={invite.id}
							>
								<span className="min-w-0">
									<span className="block font-mono text-ink text-sm">
										{invite.email}
									</span>
									<span className="mt-0.5 block text-ink-faint text-xs">
										{invite.role === "viewer"
											? `Client viewer on ${projectName(invite.projectId)}`
											: "Team member"}{" "}
										· expires {invite.expiresAt.toLocaleDateString()}
									</span>
								</span>

								<button
									className="text-ink-faint text-sm underline-offset-4 hover:text-ink hover:underline"
									disabled={revoke.isPending}
									onClick={() => revoke.mutate({ inviteId: invite.id })}
									type="button"
								>
									Revoke
								</button>
							</li>
						))}
					</ul>
				) : (
					<p className="mt-3 text-ink-soft text-sm">
						No invites are waiting to be accepted.
					</p>
				)}
			</section>

			<section className="mt-14">
				<h2 className="font-display font-semibold text-2xl text-ink">
					Who has access
				</h2>
				<p className="mt-2 max-w-prose text-ink-soft text-sm leading-relaxed">
					An owner reaches every project. Everyone else reaches only what is
					ticked.
				</p>

				<ul className="mt-4">
					{members.data?.map((person) => (
						<li className="border-rule-soft border-b py-5" key={person.id}>
							<span className="block font-mono text-ink text-sm">
								{person.email}
							</span>
							<span className="mt-0.5 block text-ink-faint text-xs">
								{person.role === "owner"
									? "Owner — every project"
									: person.role === "member"
										? "Team member"
										: "Client viewer"}
							</span>

							{person.role === "owner" ? null : (
								<div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
									{projects.data?.map((project) => {
										const assigned = person.projectIds.includes(project.id);
										return (
											<label
												className="flex items-center gap-2 text-ink-soft text-sm"
												key={project.id}
											>
												<input
													checked={assigned}
													disabled={assign.isPending}
													onChange={() =>
														assign.mutate({
															userId: person.id,
															projectId: project.id,
															assigned: !assigned,
														})
													}
													type="checkbox"
												/>
												{project.name}
											</label>
										);
									})}
								</div>
							)}
						</li>
					))}
				</ul>
			</section>
		</>
	);
}
