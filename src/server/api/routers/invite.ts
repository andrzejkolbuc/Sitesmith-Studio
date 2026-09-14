import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import {
	createTRPCRouter,
	ownerProcedure,
	tenantScope,
} from "~/server/api/trpc";
import { createInviteToken, inviteExpiry } from "~/server/auth/invite";
import {
	invites,
	projectAssignments,
	projects,
	users,
} from "~/server/db/schema";

/**
 * Who else may sign in, and what they may reach.
 *
 * Every procedure here is `ownerProcedure`. Managing people is the one
 * capability the requirements reserve to the Owner outright — a Team-member
 * explicitly "cannot manage users" — so the refusal belongs at the builder
 * rather than repeated per procedure.
 *
 * A row in `invites` *is* a pending invite: accepting deletes it, revoking
 * deletes it, and there is no status column to misread. The token itself is
 * returned exactly once, by `issue`, and never stored in a form that could be
 * handed back.
 */

/**
 * An invite creates a Team-member or a Client-viewer, never another Owner.
 *
 * The role set has three members but only two are invitable: the Owner is the
 * account the workspace is seeded with, and a second one would be a
 * co-ownership model nothing in the requirements asks for.
 */
const INVITABLE_ROLES = ["member", "viewer"] as const;

/** Matches `scripts/seed-owner.ts` and the credentials provider exactly. */
const normaliseEmail = (email: string) => email.trim().toLowerCase();

export const inviteRouter = createTRPCRouter({
	/**
	 * Mint an invite and hand back the token.
	 *
	 * The token is returned rather than a URL. Building the absolute link is the
	 * browser's job, from its own origin — which is why this slice needs no
	 * base-URL environment variable and does not depend on the unresolved
	 * hosting decision.
	 */
	issue: ownerProcedure
		.input(
			z.object({
				email: z.string().trim().email(),
				role: z.enum(INVITABLE_ROLES),
				projectId: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const email = normaliseEmail(input.email);

			/**
			 * A Client-viewer exists only in relation to one project, so an invite
			 * without one would create an account that can sign in and see nothing —
			 * the partial state this codebase keeps refusing to create.
			 */
			if (input.role === "viewer" && !input.projectId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "A client viewer must be invited to a specific project.",
				});
			}

			if (input.projectId) {
				/**
				 * Archived projects are excluded here, as everywhere. Inviting a
				 * client viewer to a deleted project would mint a working credential
				 * for an account whose only reason to exist has been removed — the
				 * partial state this router refuses two checks above, arrived at from
				 * the other direction.
				 */
				const project = await ctx.db.query.projects.findFirst({
					columns: { id: true },
					where: and(
						tenantScope(projects, ctx.tenantId),
						eq(projects.id, input.projectId),
						isNull(projects.archivedAt),
					),
				});
				if (!project) throw new TRPCError({ code: "NOT_FOUND" });
			}

			/**
			 * Acceptance creates an account, so an address that already has one has
			 * nothing to accept. Refused at issue rather than at acceptance, where
			 * the person holding the link could do nothing about it.
			 */
			const existing = await ctx.db.query.users.findFirst({
				columns: { id: true },
				where: eq(users.email, email),
			});
			if (existing) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "That address already has an account.",
				});
			}

			const { token, tokenHash } = createInviteToken();

			const [invite] = await ctx.db
				.insert(invites)
				.values({
					tenantId: ctx.tenantId,
					email,
					role: input.role,
					projectId: input.projectId ?? null,
					tokenHash,
					expiresAt: inviteExpiry(),
					invitedByUserId: ctx.session.user.id,
				})
				.returning({ id: invites.id, expiresAt: invites.expiresAt });

			if (!invite) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

			return { id: invite.id, email, expiresAt: invite.expiresAt, token };
		}),

	/** Pending invites for this tenant. Never returns `tokenHash`. */
	list: ownerProcedure.query(async ({ ctx }) => {
		return ctx.db.query.invites.findMany({
			columns: {
				id: true,
				email: true,
				role: true,
				projectId: true,
				expiresAt: true,
				createdAt: true,
			},
			where: tenantScope(invites, ctx.tenantId),
			orderBy: (invite, { desc }) => [desc(invite.createdAt)],
		});
	}),

	revoke: ownerProcedure
		.input(z.object({ inviteId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const [deleted] = await ctx.db
				.delete(invites)
				.where(
					and(
						tenantScope(invites, ctx.tenantId),
						eq(invites.id, input.inviteId),
					),
				)
				.returning({ id: invites.id });

			if (!deleted) throw new TRPCError({ code: "NOT_FOUND" });
			return { id: deleted.id };
		}),

	/**
	 * Who is in this workspace and what each of them can reach.
	 *
	 * An Owner's `projectIds` is empty and means the opposite of what it means
	 * for anyone else — they reach everything by role, without rows. The caller
	 * gets `role` alongside so it never has to infer that from an empty list.
	 */
	members: ownerProcedure.query(async ({ ctx }) => {
		const people = await ctx.db.query.users.findMany({
			columns: { id: true, email: true, name: true, role: true },
			where: tenantScope(users, ctx.tenantId),
			orderBy: (user, { asc }) => [asc(user.email)],
		});

		if (people.length === 0) return [];

		const assignments = await ctx.db.query.projectAssignments.findMany({
			columns: { userId: true, projectId: true },
			where: and(
				tenantScope(projectAssignments, ctx.tenantId),
				inArray(
					projectAssignments.userId,
					people.map((person) => person.id),
				),
			),
		});

		return people.map((person) => ({
			...person,
			projectIds: assignments
				.filter((assignment) => assignment.userId === person.id)
				.map((assignment) => assignment.projectId),
		}));
	}),

	assign: ownerProcedure
		.input(
			z.object({
				userId: z.string(),
				projectId: z.string(),
				assigned: z.boolean(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const person = await ctx.db.query.users.findFirst({
				columns: { id: true, role: true },
				where: and(
					tenantScope(users, ctx.tenantId),
					eq(users.id, input.userId),
				),
			});
			if (!person) throw new TRPCError({ code: "NOT_FOUND" });

			/**
			 * An Owner reaches every project by role. Giving them rows here would
			 * create a second, contradictory answer to what they can see — and the
			 * first time the two disagreed, the rows would win somewhere.
			 */
			if (person.role === "owner") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "The workspace owner already reaches every project.",
				});
			}

			/** Archived projects are not assignable, for the reason `issue` gives. */
			const project = await ctx.db.query.projects.findFirst({
				columns: { id: true },
				where: and(
					tenantScope(projects, ctx.tenantId),
					eq(projects.id, input.projectId),
					isNull(projects.archivedAt),
				),
			});
			if (!project) throw new TRPCError({ code: "NOT_FOUND" });

			if (input.assigned) {
				await ctx.db
					.insert(projectAssignments)
					.values({
						tenantId: ctx.tenantId,
						userId: person.id,
						projectId: project.id,
					})
					.onConflictDoNothing();
			} else {
				await ctx.db
					.delete(projectAssignments)
					.where(
						and(
							tenantScope(projectAssignments, ctx.tenantId),
							eq(projectAssignments.userId, person.id),
							eq(projectAssignments.projectId, project.id),
						),
					);
			}

			return {
				userId: person.id,
				projectId: project.id,
				assigned: input.assigned,
			};
		}),
});
