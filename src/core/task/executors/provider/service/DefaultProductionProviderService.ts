import { createIdentityFactory, type IdentityFactory } from "@core/api/transform/block-identity"
import type { ApiStreamChunk, ApiStreamServerToolChunk, ApiStreamToolCallsChunk } from "@core/api/transform/stream"
import { createStreamNormalizer, normalizeApiStream } from "@core/api/transform/stream-identity-normalizer"
import { declaredAnthropicHostedToolNames } from "@core/api/utils/messages_api_support"
import { parseAssistantMessage, type ToolUse } from "@core/assistant-message"
import { isDeterministicToolPairingError } from "@core/context/context-management/compaction-retryability"
import { checkContextWindowExceededError } from "@core/context/context-management/context-error-handling"
import type {
    ClineAssistantContent,
    ClineAssistantToolUseBlock,
    ClineStorageMessage,
    HostedToolReplayProtocol,
} from "@shared/messages/content"
import { projectInternalMessagesForProvider } from "@shared/messages/content"
import { splitResumedHostedResults } from "@shared/messages/hosted-tool-deferral"
import { Logger } from "@shared/services/Logger"
import { ClineError } from "@/services/error"
import { isTurnEndingToolName, orderTurnEndingContentBlocks } from "../../../assistant-message-order"
import { isRetryableProviderError, type ProviderIdentity, waitRetryDelayUnlessAborted } from "../../../auto-retry"
import { getRetryDelay, MAX_AUTO_RETRY_ATTEMPTS } from "../../../auto-retry-schedule"
import { ContextWindowReceivingTracker } from "../../../ContextWindowReceivingTracker"
import { type ApiRequestTiming, calculateApiRequestTiming } from "../../../performance/api-request-timing"
import { ReasoningIndicator } from "../../../reasoning-indicator"
import { StreamResponseHandler } from "../../../StreamResponseHandler"
import type { JournalWatermark } from "../../../stores"
import type {
    ProviderBlockOutput,
    ProviderDraftEnvelope,
    ToolInvocationEnvelope,
} from "../../../stores/payload/TaskPayloadEnvelopes"
import { describeExecutorFailure } from "../../contracts"
import type { ProductionProviderChunk, ProductionProviderService } from "../ProductionProviderAdapter"
import { ProviderFailure } from "../ProviderFailure"
import { closeQuietly, detachOnAbort } from "./detachOnAbort"
import {
    type McpToolResolver,
    materializeNativeToolCall,
    materializePartialNativeToolCall,
} from "./NativeToolCallMaterialization"
import { repairProviderPairing } from "./ProviderPairingRepair"
import type { PreparedProviderRequest, ProviderRequestFactory, ProviderServerToolRequestContext } from "./ProviderRequest"
import type { ProviderAttemptTiming } from "./ProviderRequestReport"
import { ProviderUsageIncrements } from "./ProviderUsageIncrements"
import { TurnRequest } from "./TurnRequest"
import { assistantProse, mayPreviewToolCall, proseOf, XmlToolPreview } from "./XmlToolPreview"

/** The automatic retries one turn may still spend, shared by every send of it. */
interface RetryBudget {
    attempts: number
}

/** When the attempt that produced a turn's stream was sent and first answered. */
interface AttemptClock {
    providerRequestStartedAtMs: number
    firstChunkAtMs: number
    /** The first chunk that carried content or reasoning; a usage-only opening chunk does not count. */
    firstContentAtMs?: number
}

/** Stream chunks that carry what the model generated, as opposed to usage bookkeeping. */
const CONTENT_CHUNK_TYPES: ReadonlySet<string> = new Set(["text", "reasoning", "tool_calls", "server_tool"])

/** The completed attempt's own timing; earlier attempts and their backoff never enter it. */
function attemptTimingOf(clock: AttemptClock, streamCompletedAtMs: number): ProviderAttemptTiming {
    const sentAt = clock.providerRequestStartedAtMs
    const durationMs = Math.max(0, Math.round(streamCompletedAtMs - sentAt))
    const firstContentAt = clock.firstContentAtMs
    if (firstContentAt === undefined) return { durationMs }
    return {
        durationMs,
        ttftMs: Math.max(0, Math.round(firstContentAt - sentAt)),
        generationMs: Math.max(0, Math.round(streamCompletedAtMs - firstContentAt)),
    }
}

/** What a retry chunk tells the chat about the attempt being waited for. */
type ProviderRetryNoticeInput = Extract<ProductionProviderChunk, { kind: "retry" }>["notice"]

interface PendingNativeTool {
    readonly functionId: string
    readonly dlineTid: string
    readonly presentationId: number
    name: string
    arguments: unknown
    signature?: string
}

/**
 * How a retry wait ended: `send` the next attempt, `cancelled` by the request's
 * signal, or `handed_back` to the user, which ends the request with the failure
 * the countdown was retrying.
 */
export type ProviderRetryWait = "send" | "cancelled" | "handed_back"

/** How a request that failed before its first chunk is sent again. */
export interface ProviderRetryPolicy {
    readonly maxAttempts: number
    /** Delay before one-based retry `attempt`. */
    delayMs(attempt: number): number
    /** Resolve `send` once the delay elapsed, `cancelled` as soon as the signal aborts. */
    wait(delayMs: number, signal: AbortSignal): Promise<ProviderRetryWait>
    /** The request left its retry loop: it produced a stream, failed for good, or was cancelled. */
    settled?(): void
    /** Whether the request starting now was opened by a manual Retry, which owns its failure. */
    claimManualTakeover?(): boolean
}

/** The automatic retry schedule the chat presents: five attempts, bounded at one minute. */
export const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
    maxAttempts: MAX_AUTO_RETRY_ATTEMPTS,
    delayMs: getRetryDelay,
    wait: async (delayMs, signal) => ((await waitRetryDelayUnlessAborted(delayMs, signal)) ? "send" : "cancelled"),
}

/** The request a reply is about to answer, as the deferred hosted calls of earlier replies see it. */
export interface DeferredHostedResumeRequest {
    /** History exactly as the endpoint receives it. */
    readonly history: readonly ClineStorageMessage[]
    readonly protocol?: HostedToolReplayProtocol
    /** Hosted tool names the request declares. */
    readonly replayHostedTools?: ReadonlySet<string>
}

export interface ProviderServerToolPresentationSession {
    consume(chunk: ApiStreamServerToolChunk): Promise<boolean>
    finalizeOpen(reason: string): Promise<void>
    /**
     * Settle the calls earlier replies deferred before this request is sent: fail those it cannot resume and
     * return, by provider call id, the trace id of each call it resumes, so the result completes the same row.
     */
    resumeDeferred?(request: DeferredHostedResumeRequest): Promise<ReadonlyMap<string, string>>
}

export interface ProviderServerToolPresentationPort {
    begin(context: ProviderServerToolRequestContext): ProviderServerToolPresentationSession
}

export type { ProviderServerToolRequestContext }

/**
 * How a request the provider refused as longer than its context window is recovered.
 *
 * Auto-compaction, when it is on, sizes the conversation from an estimate
 * before the request is sent, and nothing does when it is off; either way the
 * refusal is the first sign the request no longer fits. A compaction cannot
 * run inside the provider command that holds the turn, so the oldest settled
 * history is truncated and the request resent at once, instead of the user
 * reaching a dead end.
 */
export interface ProviderContextRecoveryPort {
    /** Remove settled history; resolves the position to resend through, or undefined when nothing is left to remove. */
    truncate(signal: AbortSignal): Promise<JournalWatermark | undefined>
}

export interface DefaultProductionProviderServiceOptions {
    readonly requests: ProviderRequestFactory
    readonly identities?: IdentityFactory
    readonly nextPresentationId?: () => number
    readonly onUsage?: (usage: Readonly<Record<string, number>>) => void
    readonly retry?: ProviderRetryPolicy
    readonly serverTools?: ProviderServerToolPresentationPort
    /** Resolve the server key and tool segment encoded in an advertised native MCP function name. */
    readonly resolveMcpTool?: McpToolResolver
    readonly contextRecovery?: ProviderContextRecoveryPort
    /**
     * Receives the phase timing of each request whose stream ran to its end.
     *
     * Local preparation covers everything before the attempt that answered was
     * sent, retries included, so it separates time spent in Dline from upstream
     * latency. A cancelled request reports nothing.
     */
    readonly onRequestTiming?: (timing: ApiRequestTiming) => void
}

/** What earlier deferred hosted calls need to know about the request this turn sends. */
function deferredHostedResumeRequest(request: PreparedProviderRequest): DeferredHostedResumeRequest {
    const protocol = request.api.getHostedToolReplayProtocol?.()
    return {
        history: projectForEndpoint(request, request.messages),
        protocol,
        // Only the Messages API defers a hosted call behind client tools.
        ...(protocol === "anthropic_messages"
            ? { replayHostedTools: declaredAnthropicHostedToolNames(request.options?.serverTools) }
            : {}),
    }
}

/** Yield a stream's first chunk again, then the rest of it, forwarding early close to the source. */
async function* continueFrom<T>(first: T, rest: AsyncIterator<T>): AsyncGenerator<T> {
    try {
        yield first
        yield* { [Symbol.asyncIterator]: () => rest }
    } finally {
        // A consumer that stops at the first chunk never reaches the delegation that would close the source.
        await closeQuietly(rest)
    }
}

/**
 * Shape the canonical history for the endpoint this request targets.
 *
 * Hosted tool blocks replay only to the protocol that produced them, and
 * attached PDFs become native documents only within the endpoint's document
 * budget; every other PDF is sent as its extracted text.
 */
function projectForEndpoint(request: PreparedProviderRequest, messages: ClineStorageMessage[]): ClineStorageMessage[] {
    return projectInternalMessagesForProvider(messages, {
        hostedToolReplayProtocol: request.api.getHostedToolReplayProtocol?.(),
        documentInput: request.api.getDocumentInputLimits?.(),
    })
}

function mergeArguments(current: unknown, incoming: unknown, mode: ApiStreamToolCallsChunk["argumentsMode"]): unknown {
    if (mode === "snapshot") return incoming ?? {}
    if (typeof current === "string" || typeof incoming === "string")
        return `${typeof current === "string" ? current : ""}${typeof incoming === "string" ? incoming : ""}`
    if (current && incoming && typeof current === "object" && typeof incoming === "object") return { ...current, ...incoming }
    return incoming ?? current ?? {}
}

/**
 * The card of a call written as markup, drawn before the call settles.
 *
 * Provisional: the turn either settles the call on this row or the presenter
 * withdraws it, so an unclosed or unmaterialized call leaves nothing behind.
 */
function xmlCardProjection(card: ToolUse): Readonly<Record<string, unknown>> {
    return { kind: "provider.tool_partial", dlineTid: `xml:${card.ts}`, provisional: true, block: card }
}

/**
 * The failure as the chat's error box renders it.
 *
 * A provider's own parser knows its error shapes best; the generic transform
 * is the fallback. Describing a failure must never replace it with another.
 */
function describeProviderError(request: PreparedProviderRequest, error: unknown, provider: ProviderIdentity): string {
    try {
        const parsed =
            request.api.parseError?.(error, provider.modelId) ??
            ClineError.transform(error, provider.modelId, provider.providerId)
        return parsed.serialize()
    } catch {
        return ClineError.transform(error, provider.modelId, provider.providerId).serialize()
    }
}

/**
 * The failure as it leaves this service: the original error, carrying how the
 * chat should explain it. Describing it must never replace it with another.
 */
function describedFailure(request: PreparedProviderRequest, error: unknown): unknown {
    try {
        const provider: ProviderIdentity = { providerId: request.api.getProviderId?.(), modelId: request.api.getModel().id }
        return new ProviderFailure(error, describeProviderError(request, error, provider))
    } catch {
        return error
    }
}

/** Closes a reply the user stopped, so the next request knows it was cut short on purpose. */
export const USER_INTERRUPTION_NOTICE = "[Response interrupted by user]"

/** Closes a hosted call whose stream dropped before the call returned, whether or not the reply is then sent again. */
const DROPPED_HOSTED_CALL_REASON = "Provider stream failed before this hosted tool call returned a result."

/**
 * What a stopped reply leaves in the conversation.
 *
 * Only what the model already said is kept: its reasoning and prose. A tool
 * call it was still writing never ran, so it is dropped rather than replayed.
 */
function interruptedTurn(
    reasoningContent: readonly ClineAssistantContent[],
    reasoningText: string,
    prose: string,
): { content: ClineAssistantContent[]; text: string; reasoning?: string } | undefined {
    if (reasoningContent.length === 0 && !prose.trim()) return undefined
    const content: ClineAssistantContent[] = [...reasoningContent]
    content.push({ type: "text", text: prose.trim() ? `${prose}\n\n${USER_INTERRUPTION_NOTICE}` : USER_INTERRUPTION_NOTICE })
    return { content, text: prose, ...(reasoningText ? { reasoning: reasoningText } : {}) }
}

/** Production provider executor: request preparation is injected; stream folding stays provider-domain local. */
export class DefaultProductionProviderService implements ProductionProviderService {
    private readonly identities: IdentityFactory
    private readonly nextPresentationId: () => number
    private readonly retry: ProviderRetryPolicy

    constructor(private readonly options: DefaultProductionProviderServiceOptions) {
        this.identities = options.identities ?? createIdentityFactory()
        let presentationId = Date.now()
        this.nextPresentationId = options.nextPresentationId ?? (() => ++presentationId)
        this.retry = options.retry ?? DEFAULT_PROVIDER_RETRY_POLICY
    }

    async *start(input: {
        readonly draftRef: string
        readonly draft: ProviderDraftEnvelope
        readonly turnId?: string
        readonly signal: AbortSignal
    }): AsyncIterable<ProductionProviderChunk> {
        const requestStartedAtMs = performance.now()
        const clock: AttemptClock = { providerRequestStartedAtMs: requestStartedAtMs, firstChunkAtMs: requestStartedAtMs }
        let streamCompletedAtMs: number | undefined
        // Shared by every send of this turn, before and after a first chunk.
        // A manual Retry owns this request, so its failure returns to the user
        // rather than opening a second automatic sequence.
        const retryBudget: RetryBudget = { attempts: this.retry.claimManualTakeover?.() ? this.retry.maxAttempts : 0 }
        // Prepared once: every retry below replays exactly this request, so a
        // prompt refresh or a newer journal entry cannot change a turn in flight.
        // Only a replaced handler prepares it again, for the same turn.
        let prepared: PreparedProviderRequest | undefined
        try {
            prepared = yield* this.prepareTurn(input.draft, input.signal, retryBudget)
        } finally {
            // A request that never reached its first send leaves no countdown behind.
            if (!prepared) this.retry.settled?.()
        }
        if (!prepared) return
        const turn = new TurnRequest(prepared, { ...input.draft, turnId: prepared.turnId })
        const transientId = `provider:${prepared.turnId}`
        let text = ""
        // What the chat shows of `text` so far; its tool markup is drawn as cards instead.
        let prose = ""
        // Kept across attempts: a resent stream redraws its calls on the rows the failed
        // one opened, and the presenter withdraws whichever rows the turn never settles.
        const xmlPreview = new XmlToolPreview(this.nextPresentationId)
        let reasoningText = ""
        let reasoningIndicator = new ReasoningIndicator()
        // Replay needs what the provider signed, not only what it said: Anthropic
        // drops an unsigned thinking block and the Responses API replays summaries
        // and encrypted items, so the same accumulator dev and subagents use folds them.
        const newReasoning = () => new StreamResponseHandler(() => Date.now()).getHandlers().reasonsHandler
        let reasoning = newReasoning()
        const nativeTools = new Map<string, PendingNativeTool>()
        // Hosted calls the provider ran (or deferred) in this reply; later requests replay them verbatim.
        const hostedToolBlocks: ClineAssistantContent[] = []
        // A cancelled command cannot authorize a tool in a later turn.
        const abort = () => turn.abandon()
        input.signal.addEventListener("abort", abort, { once: true })
        // Set once a turn-ending call is complete. From then on the user owns the
        // next interaction, so only the final usage is still read: anything else
        // the provider streams belongs to a continuation Dline will never render.
        let turnEnded = false
        let serverTools: ProviderServerToolPresentationSession | undefined
        let streamFailed = false
        // What the response occupies while it streams; the final usage settles it.
        let receiving = new ContextWindowReceivingTracker()
        let usage = new ProviderUsageIncrements()
        let receivingTokens = 0
        let authoritativeContextTokens = 0
        const replyRows = { reasoning: this.nextPresentationId(), text: this.nextPresentationId() }

        try {
            serverTools = this.options.serverTools?.begin(turn.request.serverToolContext)
            turn.carriedServerToolTraceIds =
                (await serverTools?.resumeDeferred?.(deferredHostedResumeRequest(turn.request))) ?? new Map()
            for (;;) {
                const stream = yield* this.openStream(turn, input.signal, retryBudget, clock)
                if (!stream) return
                try {
                    for await (const chunk of stream) {
                        if (input.signal.aborted) break
                        if (turnEnded && chunk.type !== "usage") {
                            // Leaving the loop closes the iterator; aborting the handler also
                            // ends a transport that would otherwise stay open behind it.
                            turn.request.api.abort?.()
                            break
                        }
                        if (clock.firstContentAtMs === undefined && CONTENT_CHUNK_TYPES.has(chunk.type)) {
                            clock.firstContentAtMs = performance.now()
                        }
                        switch (chunk.type) {
                            case "usage":
                                yield { kind: "usage", usage: usage.next(chunk) }
                                break
                            case "text": {
                                text += chunk.text
                                const frame = xmlPreview.read(text)
                                prose = frame.prose
                                // The prose first, so its row is opened above the cards of the calls it introduces.
                                yield { kind: "partial", transientId, text: prose, replyRows }
                                for (const card of frame.cards()) {
                                    yield {
                                        kind: "partial",
                                        transientId,
                                        text: prose,
                                        replyRows,
                                        projection: xmlCardProjection(card),
                                    }
                                }
                                break
                            }
                            case "reasoning":
                                reasoning.processReasoningDelta({
                                    provider_metadata: chunk.provider_metadata,
                                    reasoning: chunk.reasoning,
                                    signature: chunk.signature,
                                    details:
                                        chunk.details === undefined
                                            ? []
                                            : Array.isArray(chunk.details)
                                              ? chunk.details
                                              : [chunk.details],
                                    redacted_data: chunk.redacted_data,
                                    redacted_phase: chunk.redacted_phase,
                                })
                                const action = reasoningIndicator.decide({
                                    hasPlainReasoning: Boolean(chunk.reasoning),
                                    hasEncryptedReasoning: Boolean(chunk.redacted_data),
                                    assistantTextStarted: prose.length > 0,
                                    hasPendingNativeToolUse: nativeTools.size > 0,
                                })
                                if (chunk.reasoning) reasoningText += chunk.reasoning
                                if (action === "open_placeholder") {
                                    yield { kind: "partial", transientId, text: prose, reasoning: "", replyRows }
                                } else if (action === "publish_text") {
                                    yield {
                                        kind: "partial",
                                        transientId,
                                        text: prose,
                                        reasoning: reasoningText,
                                        replyRows,
                                    }
                                }
                                break
                            case "tool_calls":
                                // Reply rows were reserved before any native or XML call could claim a row.
                                this.consumeNativeTool(nativeTools, chunk)
                                const partialBlock = this.previewNativeTool(nativeTools.get(chunk.dline_tid))
                                // The completed chunk may omit the name, so it is read from the call
                                // the earlier deltas accumulated.
                                if (chunk.phase === "completed" && isTurnEndingToolName(nativeTools.get(chunk.dline_tid)?.name))
                                    turnEnded = true
                                yield {
                                    kind: "partial",
                                    transientId,
                                    text: prose,
                                    replyRows,
                                    projection: {
                                        kind: "provider.tool_partial",
                                        dlineTid: chunk.dline_tid,
                                        provisional: true,
                                        ...(partialBlock ? { block: partialBlock } : {}),
                                    },
                                }
                                break
                            case "server_tool":
                                if (chunk.replay) hostedToolBlocks.push(chunk.replay)
                                await serverTools?.consume(chunk)
                                yield {
                                    kind: "partial",
                                    transientId,
                                    text: prose,
                                    projection: {
                                        kind: "provider.server_tool",
                                        tool: chunk.tool,
                                        phase: chunk.phase,
                                        dlineTid: chunk.dline_tid,
                                    },
                                }
                                break
                        }
                        const estimate = receiving.apply(chunk)
                        if (
                            estimate.receivingTokens !== receivingTokens ||
                            estimate.authoritativeContextTokens !== authoritativeContextTokens
                        ) {
                            receivingTokens = estimate.receivingTokens
                            authoritativeContextTokens = estimate.authoritativeContextTokens
                            yield { kind: "receiving", receivingTokens, authoritativeContextTokens }
                        }
                    }
                    streamCompletedAtMs = performance.now()
                    break
                } catch (error) {
                    if (input.signal.aborted) throw error
                    // A provider can refuse a request for length after its first chunk too.
                    const overflow = checkContextWindowExceededError(error) && this.options.contextRecovery !== undefined
                    const notice = overflow ? undefined : this.midStreamRetry(error, turn.request, retryBudget)
                    if (!overflow && !notice) throw error
                    // The rows the failed stream showed are transient and keyed by this
                    // turn's stream, so the resent stream rewrites them from scratch.
                    // Nothing it streamed was acted on: tool calls only run from the
                    // final reply, so the resent stream starts the reply over.
                    text = ""
                    prose = ""
                    reasoningText = ""
                    reasoningIndicator = new ReasoningIndicator()
                    reasoning = newReasoning()
                    nativeTools.clear()
                    hostedToolBlocks.length = 0
                    receiving = new ContextWindowReceivingTracker()
                    usage = new ProviderUsageIncrements()
                    receivingTokens = 0
                    authoritativeContextTokens = 0
                    turnEnded = false
                    // Hosted calls the dropped stream left open get no result from it;
                    // the resent stream opens its own rows.
                    await serverTools?.finalizeOpen(DROPPED_HOSTED_CALL_REASON)
                    if (!notice) {
                        if (yield* this.truncateTurn(turn, input.signal, retryBudget)) continue
                        if (input.signal.aborted) return
                        throw error
                    }
                    yield { kind: "retry", notice }
                    const waited = await this.retry.wait(notice.delayMs, input.signal)
                    if (waited === "handed_back") throw error
                    if (waited !== "send" || input.signal.aborted) return
                    if (turn.stale && !(yield* this.reprepare(turn, input.signal, retryBudget))) return
                }
            }
        } catch (error) {
            streamFailed = true
            // A stream the user stopped ends however its transport reports it.
            if (!input.signal.aborted) throw describedFailure(turn.request, error)
        } finally {
            await serverTools?.finalizeOpen(
                input.signal.aborted
                    ? "Provider-hosted tool cancelled before it returned a result."
                    : streamFailed
                      ? DROPPED_HOSTED_CALL_REASON
                      : "Provider stream ended before this hosted tool call returned a result.",
            )
            input.signal.removeEventListener("abort", abort)
            // However the stream ends, no countdown remains for the chat to show.
            this.retry.settled?.()
        }
        if (input.signal.aborted) {
            const reasoningContent: ClineAssistantContent[] = [...reasoning.getRedactedThinking()]
            const thinking = reasoning.getCurrentReasoning()
            if (thinking) reasoningContent.push(thinking)
            const interrupted = interruptedTurn(reasoningContent, reasoningText, assistantProse(text))
            if (interrupted) yield { kind: "interrupted", transientId, ...interrupted }
            return
        }
        if (streamCompletedAtMs !== undefined) {
            this.options.onRequestTiming?.(calculateApiRequestTiming({ requestStartedAtMs, ...clock, streamCompletedAtMs }))
            yield { kind: "timing", timing: attemptTimingOf(clock, streamCompletedAtMs) }
        }

        // The request that produced the stream decides how its reply is read.
        // A provider can still return native tool_use blocks to a request that
        // described its tools as markup (Claude Code does); those calls are
        // the model's actual reply, so dropping them would lose the turn.
        const request = turn.request
        const materialized =
            request.nativeTools || nativeTools.size > 0
                ? this.materializeNativeTools(nativeTools, text, xmlPreview)
                : this.materializeXmlTools(text, xmlPreview)
        // The provider opens its reply with the results of calls an earlier reply
        // deferred, and only accepts the next request when the turn keeps them first.
        const hostedTurn = splitResumedHostedResults(hostedToolBlocks)
        const content: ClineAssistantContent[] = [...hostedTurn.resumed, ...reasoning.getRedactedThinking()]
        const thinking = reasoning.getCurrentReasoning()
        if (thinking) content.push(thinking)
        // Hosted calls ran before the visible answer, so they precede it in the stored turn.
        content.push(...hostedTurn.others)
        // History records what the model actually sent. A call it wrote as markup
        // beside native tools stays markup there: turning it into a native call
        // would replay an invented call id the provider never issued.
        const historyText = request.nativeTools ? text : materialized.text
        if (historyText.trim().length > 0) content.push({ type: "text", text: historyText })
        const recorded = (tool: ToolUse) => !request.nativeTools || tool.isNativeToolCall === true
        content.push(...materialized.tools.filter(recorded).map((tool) => this.toAssistantToolUse(tool)))
        // The execution pool then admits only the first ending and skips any later ending.
        const orderedTools = orderTurnEndingContentBlocks(materialized.tools)
        const firstEnding = orderedTools.find((tool) => isTurnEndingToolName(tool.name))
        const presentedTools = orderedTools.filter((tool) => !isTurnEndingToolName(tool.name) || tool === firstEnding)
        const blocks = await Promise.all(
            orderedTools.map((tool, index) => this.createBlock(request, tool, index, recorded(tool))),
        )
        const ending = usage.ending()
        yield {
            kind: "final",
            turnId: request.turnId,
            transientId,
            text: materialized.text,
            ...(reasoningText.length > 0 ? { reasoning: reasoningText } : {}),
            content,
            ...(request.modelInfo === undefined ? {} : { modelInfo: request.modelInfo }),
            ...(ending === undefined ? {} : { ending }),
            mode: blocks.length > 1 ? request.mode : "serial",
            blocks,
            ...(presentedTools.length > 0 ? { toolRows: presentedTools.map((tool) => tool.ts) } : {}),
        }
    }

    recordUsage(usage: Readonly<Record<string, number>>): void {
        this.options.onUsage?.(usage)
    }

    /**
     * Open the request's stream, sending it again until it produces a first chunk.
     *
     * Only a failure before the first chunk is replayed here: nothing reached the
     * conversation or the chat yet, so the same request can simply be sent
     * again. A stream that fails later is sent again by `start`, which first
     * clears what the failed stream showed.
     *
     * A deterministic tool-pairing rejection is not transient, so waiting would
     * repeat it. The conversation is rebuilt with canonical pairing once and
     * sent immediately; a second rejection fails the request.
     *
     * A handler the task replaced meanwhile (a Profile, Mode or configuration
     * change) prepares the turn again before the next attempt. An attempt that
     * failed after its handler was replaced is sent again at once without
     * spending the retry budget: the replacement aborted it, or its failure
     * belonged to a provider the task no longer uses.
     *
     * Returns undefined when cancellation ended the attempt.
     */
    private async *openStream(
        turn: TurnRequest,
        signal: AbortSignal,
        budget: RetryBudget,
        clock: AttemptClock,
    ): AsyncGenerator<ProductionProviderChunk, AsyncIterable<ApiStreamChunk> | undefined> {
        try {
            return yield* this.sendUntilFirstChunk(turn, signal, budget, clock)
        } finally {
            // However the loop ends, no countdown remains for the chat to show.
            this.retry.settled?.()
        }
    }

    /**
     * Prepare the turn's request, preparing it again while its failure may pass.
     *
     * Preparation rebuilds the handler, validates its credentials and resolves
     * the prompt, so a dropped connection or a briefly unavailable owner fails
     * it as easily as a send. It spends the turn's retry budget and shows the
     * same countdown; a failure only the user can resolve, such as a Profile
     * that cannot be admitted, ends the request at once. The caller settles
     * the countdown, which may go on into the sends that follow.
     *
     * Returns undefined when cancellation ended it.
     */
    private async *prepareTurn(
        draft: ProviderDraftEnvelope,
        signal: AbortSignal,
        budget: RetryBudget,
    ): AsyncGenerator<ProductionProviderChunk, PreparedProviderRequest | undefined> {
        for (;;) {
            let failure: unknown
            try {
                return await this.options.requests.prepare(draft, signal)
            } catch (error) {
                failure = error
            }
            if (signal.aborted) return undefined
            if (budget.attempts >= this.retry.maxAttempts || !isRetryableProviderError(failure)) throw failure
            budget.attempts++
            const delayMs = this.retry.delayMs(budget.attempts)
            Logger.warn(`[provider] request preparation failed; retry ${budget.attempts} in ${delayMs}ms`, failure)
            yield {
                kind: "retry",
                notice: {
                    attempt: budget.attempts,
                    maxAttempts: this.retry.maxAttempts,
                    delayMs,
                    errorMessage: describeExecutorFailure("provider", failure),
                },
            }
            const waited = await this.retry.wait(delayMs, signal)
            if (waited === "cancelled" || signal.aborted) return undefined
            // The user took the failure back, so it ends the request as an exhausted budget would.
            if (waited === "handed_back") throw failure
        }
    }

    /**
     * Prepare the same turn again and send it from now on: for the handler that
     * replaced its own, or through `through` after a truncation. False only
     * when cancellation ended it.
     */
    private async *reprepare(
        turn: TurnRequest,
        signal: AbortSignal,
        budget: RetryBudget,
        through?: JournalWatermark,
    ): AsyncGenerator<ProductionProviderChunk, boolean> {
        if (!through) Logger.info("[provider] the task replaced its handler; preparing the turn for the new handler")
        const prepared = yield* this.prepareTurn(turn.draftThrough(through), signal, budget)
        if (!prepared) return false
        turn.adopt(prepared, through)
        return true
    }

    /**
     * Answer a refusal for length by removing settled history and preparing the
     * turn through what is left. Waiting cannot make the request fit, so this
     * spends no retry, and it repeats while each truncation removes more. False
     * when nothing more can be removed (a single item larger than the window),
     * or when cancellation ended it.
     */
    private async *truncateTurn(
        turn: TurnRequest,
        signal: AbortSignal,
        budget: RetryBudget,
    ): AsyncGenerator<ProductionProviderChunk, boolean> {
        const through = await this.options.contextRecovery?.truncate(signal)
        if (!through || signal.aborted || !turn.advancesTo(through)) return false
        Logger.warn("[provider] request exceeded the context window; resending with truncated history")
        return yield* this.reprepare(turn, signal, budget, through)
    }

    /**
     * Decide whether a stream that failed after its first chunk is sent again.
     *
     * A dropped stream is retried the same way however far it got, whether it
     * had streamed prose, reasoning, tool calls, hosted calls or a turn-ending
     * call: nothing in it is acted on before the reply completes, so the resent
     * request rebuilds the whole reply. Only a non-retryable error or a spent
     * budget makes the failure final. Returns the notice to show, or undefined
     * when the failure is final.
     */
    private midStreamRetry(
        error: unknown,
        request: PreparedProviderRequest,
        budget: RetryBudget,
    ): ProviderRetryNoticeInput | undefined {
        if (budget.attempts >= this.retry.maxAttempts) return undefined
        const provider: ProviderIdentity = { providerId: request.api.getProviderId?.(), modelId: request.api.getModel().id }
        if (!isRetryableProviderError(error, provider)) return undefined
        budget.attempts++
        const delayMs = this.retry.delayMs(budget.attempts)
        Logger.warn(`[provider] stream failed after its first chunk; retry ${budget.attempts} in ${delayMs}ms`, error)
        return {
            attempt: budget.attempts,
            maxAttempts: this.retry.maxAttempts,
            delayMs,
            errorMessage: describeProviderError(request, error, provider),
        }
    }

    private async *sendUntilFirstChunk(
        turn: TurnRequest,
        signal: AbortSignal,
        budget: RetryBudget,
        clock: AttemptClock,
    ): AsyncGenerator<ProductionProviderChunk, AsyncIterable<ApiStreamChunk> | undefined> {
        let pairingRebuilt = false
        const messagesOf = (request: PreparedProviderRequest): ClineStorageMessage[] =>
            projectForEndpoint(request, pairingRebuilt ? repairProviderPairing(request.messages) : request.messages)
        let messages = messagesOf(turn.request)
        for (;;) {
            const request = turn.request
            const provider: ProviderIdentity = { providerId: request.api.getProviderId?.(), modelId: request.api.getModel().id }
            let iterator: AsyncIterator<ApiStreamChunk> | undefined
            let failure: unknown
            try {
                clock.providerRequestStartedAtMs = performance.now()
                clock.firstContentAtMs = undefined
                const apiStream = request.api.createMessage(request.systemPrompt, messages, request.tools, {
                    ...request.options,
                    telemetryRole: "task",
                    telemetryRequestId: request.turnId,
                    telemetryAttempt: budget.attempts,
                })
                const normalizer = createStreamNormalizer(this.identities, {
                    carriedServerToolTraceId: (functionId) => turn.carriedServerToolTraceIds.get(functionId),
                })
                // Detached on abort: a transport that cannot abort a pending read must not
                // hold Cancel until the provider decides to end the stream.
                iterator = detachOnAbort(normalizeApiStream(apiStream, normalizer), signal)[Symbol.asyncIterator]()
                const first = await iterator.next()
                if (!first.done) {
                    clock.firstChunkAtMs = performance.now()
                    return continueFrom(first.value, iterator)
                }
                failure = new Error("API stream ended without producing any content")
            } catch (error) {
                failure = error
            }
            await closeQuietly(iterator)
            if (signal.aborted) return undefined
            if (turn.stale) {
                if (!(yield* this.reprepare(turn, signal, budget))) return undefined
                messages = messagesOf(turn.request)
                continue
            }
            if (isDeterministicToolPairingError(failure)) {
                if (pairingRebuilt) throw failure
                pairingRebuilt = true
                messages = messagesOf(request)
                Logger.warn("[provider] request rejected for tool pairing; sending it once with canonical pairing")
                continue
            }
            if (checkContextWindowExceededError(failure) && this.options.contextRecovery) {
                if (yield* this.truncateTurn(turn, signal, budget)) {
                    messages = messagesOf(turn.request)
                    continue
                }
                if (signal.aborted) return undefined
                throw failure
            }
            if (budget.attempts >= this.retry.maxAttempts || !isRetryableProviderError(failure, provider)) throw failure
            budget.attempts++
            const retries = budget.attempts
            const delayMs = this.retry.delayMs(retries)
            Logger.warn(`[provider] request failed before its first chunk; retry ${retries} in ${delayMs}ms`, failure)
            yield {
                kind: "retry",
                notice: {
                    attempt: retries,
                    maxAttempts: this.retry.maxAttempts,
                    delayMs,
                    errorMessage: describeProviderError(request, failure, provider),
                },
            }
            const waited = await this.retry.wait(delayMs, signal)
            if (waited === "cancelled" || signal.aborted) return undefined
            // The user took the failure back, so it ends the request as an
            // exhausted budget would, and the chat offers Retry for it.
            if (waited === "handed_back") throw failure
            if (turn.stale) {
                if (!(yield* this.reprepare(turn, signal, budget))) return undefined
                messages = messagesOf(turn.request)
            }
        }
    }

    private consumeNativeTool(tools: Map<string, PendingNativeTool>, chunk: ApiStreamToolCallsChunk): void {
        const existing = tools.get(chunk.dline_tid)
        const pending = existing ?? {
            functionId: chunk.function_id,
            dlineTid: chunk.dline_tid,
            presentationId: this.nextPresentationId(),
            name: "",
            arguments: "",
        }
        if (chunk.tool_call.function.name) pending.name = chunk.tool_call.function.name
        pending.arguments = mergeArguments(pending.arguments, chunk.tool_call.function.arguments, chunk.argumentsMode)
        if (chunk.signature) pending.signature = chunk.signature
        tools.set(chunk.dline_tid, pending)
    }

    /**
     * The card of a native call still streaming, or none while it has no name
     * or is a call only the tool gate may reveal once it settles.
     */
    private previewNativeTool(tool: PendingNativeTool | undefined): ToolUse | undefined {
        if (!tool?.name) return undefined
        const call = materializePartialNativeToolCall(tool.name, tool.arguments, this.options.resolveMcpTool)
        if (!mayPreviewToolCall(call.name)) return undefined
        return {
            type: "tool_use",
            ...call,
            partial: true,
            ts: tool.presentationId,
            isNativeToolCall: true,
            function_id: tool.functionId,
            dline_tid: tool.dlineTid,
        }
    }

    /**
     * Native tool calls arrive beside the assistant's prose, not instead of it.
     *
     * The streamed text is carried through rather than dropped: a provider that
     * answers in words and calls no tool produced a turn whose entire content was
     * discarded here, so the reply never reached the conversation or the chat.
     *
     * A model offered native tools can still write a call as markup in its prose.
     * That markup is materialized as a call like any other, so the tool gate
     * decides it: left as text it would bypass authorization entirely and show a
     * refused call to the user as if the model had said it.
     */
    private materializeNativeTools(
        tools: Map<string, PendingNativeTool>,
        text: string,
        preview: XmlToolPreview,
    ): { text: string; tools: ToolUse[] } {
        const written = this.materializeXmlTools(text, preview)
        return {
            text: written.text,
            tools: [
                ...written.tools,
                ...[...tools.values()].map(
                    (tool): ToolUse => ({
                        type: "tool_use",
                        ...materializeNativeToolCall(tool.name, tool.arguments, this.options.resolveMcpTool),
                        partial: false,
                        ts: tool.presentationId,
                        isNativeToolCall: true,
                        function_id: tool.functionId,
                        dline_tid: tool.dlineTid,
                        ...(tool.signature === undefined ? {} : { signature: tool.signature }),
                    }),
                ),
            ],
        }
    }

    /**
     * The calls the reply wrote as markup, each on the row its preview drew.
     *
     * Only a call whose closing tag arrived is materialized; one the stream left
     * open never runs, and its card is withdrawn rather than shown as prose.
     */
    private materializeXmlTools(text: string, preview: XmlToolPreview): { text: string; tools: ToolUse[] } {
        const identities = new Map<string, { function_id: string; dline_tid: string }>()
        const blocks = parseAssistantMessage(
            text,
            preview.registry((key) => {
                const existing = identities.get(key)
                if (existing) return existing
                const created = { function_id: this.identities.nextFunctionId(), dline_tid: this.identities.nextTraceId() }
                identities.set(key, created)
                return created
            }),
        )
        return {
            text: proseOf(blocks),
            tools: blocks.filter((block): block is ToolUse => block.type === "tool_use" && !block.partial),
        }
    }

    private async createBlock(
        request: PreparedProviderRequest,
        tool: ToolUse,
        index: number,
        recorded: boolean,
    ): Promise<ProviderBlockOutput> {
        const planned = await request.planTool(tool)
        const invocation: ToolInvocationEnvelope = {
            kind: "tool_invocation",
            toolName: tool.name,
            input: tool.params,
            functionId: tool.function_id,
            dlineTid: tool.dline_tid,
            presentationId: tool.ts,
            isNativeToolCall: tool.isNativeToolCall === true,
            ...(tool.signature === undefined ? {} : { signature: tool.signature }),
            ...(recorded ? {} : { resultReplay: "text" as const }),
        }
        return {
            blockId: tool.dline_tid,
            attempt: planned.attempt,
            index,
            lanes: planned.lanes,
            turnEnding: planned.turnEnding,
            invocation,
            approval: planned.approval,
        }
    }

    private toAssistantToolUse(tool: ToolUse): ClineAssistantToolUseBlock {
        return {
            type: "tool_use",
            function_id: tool.function_id,
            dline_tid: tool.dline_tid,
            name: tool.name,
            input: tool.params,
            ...(tool.signature === undefined ? {} : { signature: tool.signature }),
        }
    }
}
