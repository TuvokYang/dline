import { monotonicFactory } from "ulid"

/** Canonical identities shared by one runtime tool use/result lifecycle. */
export interface RuntimeToolIdentity {
    function_id: string
    dline_tid: string
}

/** Allocates Dline-owned function and trace identities. */
export interface IdentityFactory {
    /** Allocate a Dline-owned function identity for non-native tool calls. */
    nextFunctionId(): string
    /**
     * Allocate the next Dline trace identity.
     *
     * @returns A prefixed trace identity.
     */
    nextTraceId(): string
}

/** Diagnostic metadata for a missing provider function identity. */
export interface MissingFunctionIdentityDetails {
    provider: string
    apiFormat: string
    itemId: string
    traceId: string
    toolName: string
}

/** Error raised when a native tool call lacks its provider pairing identity. */
export class MissingFunctionIdentityError extends Error {
    readonly details: MissingFunctionIdentityDetails

    /**
     * Create an execution-blocking native tool identity error.
     *
     * @param details Provider and block metadata used for diagnostics.
     */
    constructor(details: MissingFunctionIdentityDetails) {
        super(
            `Native tool call is missing function_id: provider=${details.provider} apiFormat=${details.apiFormat} item_id=${details.itemId} dline_tid=${details.traceId} tool=${details.toolName}`,
        )
        this.name = "MissingFunctionIdentityError"
        this.details = details
    }
}

/**
 * Create a task-local allocator for Dline-owned identities.
 *
 * @param nextUlid Optional deterministic ULID source used by tests.
 * @returns An allocator that never creates provider function identities.
 */
export function createIdentityFactory(nextUlid: () => string = monotonicFactory()): IdentityFactory {
    return {
        nextFunctionId: () => `dline_function_${nextUlid()}`,
        nextTraceId: () => `dline_tid_${nextUlid()}`,
    }
}
