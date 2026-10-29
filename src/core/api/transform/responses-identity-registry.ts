import type { ApiRawStreamToolCallsChunk, ApiToolCallPhase } from "./stream"

/** Canonical provider identities for one OpenAI Responses function item. */
export interface ResponsesFunctionIdentity {
    /** Provider-native output item identity. */
    item_id: string
    /** Provider-native function call and result pairing identity. */
    function_id: string
    /** Provider-native function name. */
    name: string
}

/** Input used to register one OpenAI Responses function item. */
export interface ResponsesItemInput {
    itemId: string
    functionId: string
    name: string
}

/** Diagnostic metadata for conflicting Responses function identities. */
export interface ResponsesConflictDetails {
    provider: string
    itemId: string
    existingFunctionId: string
    incomingFunctionId: string
}

/** Error raised when one Responses item changes its provider function identity. */
export class ResponsesIdentityConflictError extends Error {
    readonly details: ResponsesConflictDetails

    /**
     * Create a Responses identity conflict error.
     *
     * @param details Provider and conflicting identity metadata.
     */
    constructor(details: ResponsesConflictDetails) {
        super(
            `Responses identity conflict: provider=${details.provider} item_id=${details.itemId} existing_function_id=${details.existingFunctionId} incoming_function_id=${details.incomingFunctionId}`,
        )
        this.name = "ResponsesIdentityConflictError"
        this.details = details
    }
}

/** Diagnostic metadata for a missing Responses item identity. */
export interface ResponsesMissingDetails {
    provider: string
    itemId: string
}

/** Error raised when a Responses delta references an unknown item. */
export class ResponsesIdentityMissingError extends Error {
    readonly details: ResponsesMissingDetails

    /**
     * Create a missing Responses identity error.
     *
     * @param details Provider and missing item metadata.
     */
    constructor(details: ResponsesMissingDetails) {
        super(`Responses identity is missing: provider=${details.provider} item_id=${details.itemId}`)
        this.name = "ResponsesIdentityMissingError"
        this.details = details
    }
}

/** Stores provider-native Responses identities across added, delta, and done events. */
export interface ResponsesIdentityRegistry {
    registerItem(input: ResponsesItemInput): ResponsesFunctionIdentity
    resolveItem(itemId: string): ResponsesFunctionIdentity | undefined
    requireItem(itemId: string): ResponsesFunctionIdentity
}

/**
 * Create a raw native tool chunk from registered Responses identities.
 *
 * @param identity Provider-native item and function identities.
 * @param argumentsText Function argument delta or completed JSON. Omit for a lifecycle-only boundary.
 * @param phase Provider lifecycle phase when known.
 * @returns Raw tool chunk ready for Dline identity normalization.
 */
export function createResponsesToolChunk(
    identity: ResponsesFunctionIdentity,
    argumentsText?: string,
    phase?: ApiToolCallPhase,
): ApiRawStreamToolCallsChunk {
    return {
        type: "tool_calls",
        function_id: identity.function_id,
        provider_metadata: { item_id: identity.item_id },
        ...(phase ? { phase } : {}),
        tool_call: {
            function: {
                name: identity.name,
                ...(argumentsText !== undefined ? { arguments: argumentsText } : {}),
            },
        },
    }
}

/**
 * Create a request-local OpenAI Responses identity registry.
 *
 * @param provider Provider name used for conflict diagnostics.
 * @returns Registry that never synthesizes provider function identities.
 */
export function createResponsesRegistry(provider: string): ResponsesIdentityRegistry {
    const identityByItem = new Map<string, ResponsesFunctionIdentity>()

    return {
        registerItem(input: ResponsesItemInput): ResponsesFunctionIdentity {
            const existing = identityByItem.get(input.itemId)
            if (existing) {
                if (existing.function_id !== input.functionId) {
                    throw new ResponsesIdentityConflictError({
                        provider,
                        itemId: input.itemId,
                        existingFunctionId: existing.function_id,
                        incomingFunctionId: input.functionId,
                    })
                }
                return existing
            }

            const identity: ResponsesFunctionIdentity = {
                item_id: input.itemId,
                function_id: input.functionId,
                name: input.name,
            }
            identityByItem.set(input.itemId, identity)
            return identity
        },
        resolveItem(itemId: string): ResponsesFunctionIdentity | undefined {
            return identityByItem.get(itemId)
        },
        requireItem(itemId: string): ResponsesFunctionIdentity {
            const identity = identityByItem.get(itemId)
            if (!identity) {
                throw new ResponsesIdentityMissingError({ provider, itemId })
            }
            return identity
        },
    }
}
