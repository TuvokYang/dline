import type { Anthropic } from "@anthropic-ai/sdk"
import { buildClaudeCodeBetas } from "@/integrations/anthropic-claude-code/beta-headers"
import type { AnthropicMessagesStreamEvent } from "../../utils/messages_api_support"
import type { AnthropicMessagesRequestBody } from "./request-builder"

export const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01"

type AnthropicMessagesStream = AsyncIterable<AnthropicMessagesStreamEvent>
type BetaCreate = (
	params: AnthropicMessagesRequestBody,
	options?: { headers: Record<string, string> },
) => Promise<AnthropicMessagesStream>

/**
 * Opens one Messages API response stream for a built request.
 *
 * One transport serves a whole logical request, including every pause_turn continuation, so state such as a
 * renewed credential carries over. A transport never retries a stream that has produced output; request-level
 * retry stays with the provider.
 */
export interface AnthropicMessagesTransport {
	open(body: AnthropicMessagesRequestBody, headers: Record<string, string>): Promise<AnthropicMessagesStream>
}

/** Per-request headers stay off the client defaults: the identity version is resolved for each request. */
function requestOptions(headers: Record<string, string>): { headers: Record<string, string> } | undefined {
	return Object.keys(headers).length > 0 ? { headers } : undefined
}

/**
 * API-key transport for the anthropic provider.
 *
 * Fast mode exists only on the beta endpoint, selected by its beta flag and `speed`. That route has never
 * carried per-request headers, so it keeps the exact request it sent before.
 */
export class ApiKeyAnthropicTransport implements AnthropicMessagesTransport {
	constructor(
		private readonly client: Anthropic,
		private readonly fastMode: boolean,
	) {}

	open(body: AnthropicMessagesRequestBody, headers: Record<string, string>): Promise<AnthropicMessagesStream> {
		if (this.fastMode) {
			return (this.client.beta.messages.create as unknown as BetaCreate)({
				...body,
				betas: [ANTHROPIC_FAST_MODE_BETA],
				speed: "fast",
			})
		}
		return this.client.messages.create(body, requestOptions(headers)) as Promise<AnthropicMessagesStream>
	}
}

/**
 * Whether upstream rejected the request because of the credential itself.
 *
 * Only 401 qualifies. A 403 is a decision about what the account may do, which a new token cannot change,
 * so refreshing would hide the real reason behind an unrelated failure.
 */
function isUnauthorized(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 401
}

/**
 * Subscription transport for the claude-code provider.
 *
 * Every request goes through the beta namespace (`/v1/messages?beta=true`): several declared betas are
 * beta-API features the stable route would not serve, and the SDK renders `betas` into the `anthropic-beta`
 * header so route and header cannot drift apart.
 *
 * Expiry is predicted from the stored lifetime, so a token revoked early still looks valid and upstream answers
 * 401. Opening is retried once with a renewed client; that is safe only here, before any event was yielded.
 * The renewed client then serves every later continuation instead of the rejected credential.
 */
export class ClaudeCodeSubscriptionTransport implements AnthropicMessagesTransport {
	constructor(
		private client: Anthropic,
		private readonly renewClient: () => Promise<Anthropic>,
	) {}

	async open(body: AnthropicMessagesRequestBody, headers: Record<string, string>): Promise<AnthropicMessagesStream> {
		try {
			return await this.post(body, headers)
		} catch (error) {
			if (!isUnauthorized(error)) throw error
			this.client = await this.renewClient()
			return this.post(body, headers)
		}
	}

	private post(body: AnthropicMessagesRequestBody, headers: Record<string, string>): Promise<AnthropicMessagesStream> {
		return (this.client.beta.messages.create as unknown as BetaCreate)(
			{ ...body, betas: buildClaudeCodeBetas() },
			{ headers },
		)
	}
}
