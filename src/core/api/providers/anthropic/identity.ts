import type { TextBlockParam } from "@anthropic-ai/sdk/resources/index"
import {
	type BillingAttributionMessage,
	buildBillingAttributionBlock,
} from "@/integrations/anthropic-claude-code/billing-attribution"
import { buildClaudeCodeClientHeaders } from "@/integrations/anthropic-claude-code/client-headers"
import { getClaudeCodeClientVersionResolver } from "../../../model-registry/remote/vendors/claude-code-client-version"

/** The Claude Code client identity one request presents: a leading system block and matching headers. */
export interface ClaudeCodeIdentity {
	systemBlocks: TextBlockParam[]
	headers: Record<string, string>
}

/**
 * How a provider treats a Claude Code identity it cannot build.
 *
 * - `optional`: the identity is an opt-in disguise; without it the request is still valid, so it is dropped.
 * - `required`: the endpoint only accepts a caller presenting itself as Claude Code, so the request must not be sent.
 */
export type ClaudeCodeIdentityPolicy = "optional" | "required"

export interface ClaudeCodeIdentityRequest {
	policy: ClaudeCodeIdentityPolicy
	/** Prepared request messages the attribution block fingerprints. */
	messages: readonly BillingAttributionMessage[]
	/** Client version declared instead of the resolved one; blank values are ignored. */
	clientVersionOverride?: string
	entrypointOverride?: string
}

/**
 * Build the Claude Code identity for one request.
 *
 * The attribution block and the headers come from a single resolved version on purpose. Upstream compares the
 * User-Agent against the block's `cc_version`, so two independent resolutions could disagree across a cache
 * expiry and mark the request as a third-party client.
 */
export async function buildClaudeCodeIdentity(request: ClaudeCodeIdentityRequest): Promise<ClaudeCodeIdentity> {
	const override = request.clientVersionOverride?.trim()
	const clientVersion = override || (await getClaudeCodeClientVersionResolver().resolve()).version
	try {
		return {
			systemBlocks: [
				buildBillingAttributionBlock({
					messages: request.messages,
					clientVersion,
					entrypoint: request.entrypointOverride,
				}),
			],
			headers: buildClaudeCodeClientHeaders(clientVersion),
		}
	} catch (error) {
		// Declaring a malformed version is worse than declaring none, but a required identity cannot be skipped:
		// sending without it trades a local, explainable failure for a remote 401 that names the wrong cause.
		if (request.policy === "optional") return { systemBlocks: [], headers: {} }
		throw new Error(
			`Claude Code client identity could not be built, so the subscription request was not sent: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}
}
