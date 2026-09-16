/**
 * The surface through which the tool execution domain reaches a user.
 *
 * Every UI-bound capability must be obtained from here. A caller that holds no
 * surface therefore has no way to reach a message list, an approval prompt or a
 * visible editor, because the capability does not exist rather than because a
 * particular callback happened to be overridden.
 *
 * This is the structural replacement for enumerating subagent-specific
 * overrides: a handler that later acquires a UI need still cannot reopen the
 * leak, since it can only ask the surface it was assembled with.
 */

/** Why a surface refused to expose a capability. */
export type SurfaceDenialReason = "subagent_execution" | "detached_domain"

export class SurfaceDeniedError extends Error {
	constructor(
		readonly capability: string,
		readonly reason: SurfaceDenialReason,
	) {
		super(`Tool domain surface denied '${capability}' (${reason})`)
		this.name = "SurfaceDeniedError"
	}
}

/**
 * A surface that can present to a user.
 *
 * The concrete member set stays deliberately small: it is the complete list of
 * ways the tool domain is allowed to become visible. Adding a member here is a
 * reviewable decision, whereas inheriting a callback map silently was not.
 */
export interface UserFacingSurface {
	readonly kind: "user_facing"

	/** Ask the user something and resolve with their response. */
	ask(type: string, payload: string | undefined, partial: boolean | undefined): Promise<unknown>

	/** Emit a message row into the owning conversation. */
	say(type: string, payload: string | undefined, partial: boolean | undefined): Promise<void>

	/** Open a durable interaction, such as a tool approval. */
	openInteraction(request: unknown): Promise<unknown>

	/** Access the editor-visible diff surface. */
	diff(): unknown
}

/**
 * A surface that refuses every capability.
 *
 * Denial is explicit rather than a silent no-op: work that genuinely depends on
 * reaching a user fails loudly here instead of appearing to succeed while its
 * output lands somewhere it does not belong.
 */
export interface DeniedSurface {
	readonly kind: "denied"
	readonly reason: SurfaceDenialReason
}

export type ToolDomainSurface = UserFacingSurface | DeniedSurface

export function createDeniedSurface(reason: SurfaceDenialReason): DeniedSurface {
	return { kind: "denied", reason }
}

/** Narrow a surface to its user-facing form, or undefined when denied. */
export function asUserFacing(surface: ToolDomainSurface): UserFacingSurface | undefined {
	return surface.kind === "user_facing" ? surface : undefined
}

/**
 * Require a user-facing surface for a named capability.
 *
 * Callers that legitimately need a user use this and surface the denial; callers
 * that can degrade gracefully use {@link asUserFacing} and check for undefined.
 */
export function requireUserFacing(surface: ToolDomainSurface, capability: string): UserFacingSurface {
	if (surface.kind === "denied") {
		throw new SurfaceDeniedError(capability, surface.reason)
	}
	return surface
}

export function isDenied(surface: ToolDomainSurface): surface is DeniedSurface {
	return surface.kind === "denied"
}
