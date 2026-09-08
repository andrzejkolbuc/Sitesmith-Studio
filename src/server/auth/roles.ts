/**
 * The three roles, and the questions the rest of the codebase asks about them.
 *
 * The set is closed at three — Owner, Team-member, Client-viewer — and a
 * platform-level administrator above Owners was considered and dropped during
 * shaping. Adding a fourth is a product decision, not a refactor.
 *
 * Role is a property of a person within their one tenant. Which *projects* they
 * may reach is a separate question, answered by `projectAssignments` rows and
 * `assertProjectAccess`, because an Owner reaches every project without any row
 * existing and a Team-member reaches only what they were assigned.
 *
 * The predicates below exist so that capability is asked about by name rather
 * than by comparing string literals at the call site. A role comparison spelled
 * out inline is a rule nobody can find later when it changes.
 */

export const USER_ROLES = ["owner", "member", "viewer"] as const;

export type UserRole = (typeof USER_ROLES)[number];

/** Full control of the tenant: projects, configuration, and user management. */
export const isOwner = (role: UserRole | null | undefined): boolean =>
	role === "owner";

/**
 * May trigger a check on a project they can reach.
 *
 * Owners and Team-members; a Client-viewer's access is read-only. Reaching the
 * project is a separate condition and is not answered here.
 */
export const canRunChecks = (role: UserRole | null | undefined): boolean =>
	role === "owner" || role === "member";

/**
 * May change what a project checks or what it is compared against — masks and
 * the visual baseline.
 *
 * Owner only. The requirements grant a Team-member "run checks and view
 * results" and reserve "configure checks" to the Owner; baseline pinning and
 * mask editing are configuration, not running.
 */
export const canConfigureProject = (
	role: UserRole | null | undefined,
): boolean => role === "owner";
