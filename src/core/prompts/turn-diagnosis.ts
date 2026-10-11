import type { ApiStopReason } from "@core/api/transform/stream"

/**
 * Diagnosis of a model response that did not advance the task.
 *
 * A bare "you did not use a tool" tells the model nothing about what went wrong,
 * so it tends to repeat the same failure, or restart its analysis from scratch.
 * Naming the actual failure, the remaining budget of failed responses, and the
 * concrete next step gives it what it needs to recover. Runtime prompt text is
 * English, like every other runtime response.
 */

/** What a response contained when it produced no executable tool call. */
export interface ToollessTurnObservation {
    /** Visible text of the response, before tool parsing. */
    readonly visibleText: string
    /** Whether the provider streamed reasoning for the response. */
    readonly reasoningPresent: boolean
    /** Output tokens the provider billed for the response, when reported. */
    readonly outputTokens?: number
    /** Normalized reason the provider stopped, when reported. */
    readonly stopReason?: ApiStopReason
}

export type TurnFailureKind =
    | "empty_response"
    | "reasoning_only"
    | "output_limit"
    | "content_filter"
    | "tool_markup_in_text"
    | "text_only"
    | "missing_completion_result"
    | "convergence_violation"

export interface TurnFailure {
    readonly kind: TurnFailureKind
    readonly outputTokens?: number
    /** Tools called while only attempt_completion was accepted. */
    readonly rejectedTools?: readonly string[]
}

/** What the diagnosis states about the failure itself, independent of the next step. */
export interface TurnDiagnosisContext {
    /** Whether tools were offered as provider-native definitions rather than XML. */
    readonly usesNativeToolCalls: boolean
    /** Failed responses in a row, including this one. Omitted when the caller does not bound them. */
    readonly consecutiveFailures?: number
    readonly maxConsecutiveFailures?: number
    /** What happens when the limit is reached; defaults to the run stopping with a failure. */
    readonly limitOutcome?: string
}

export interface TurnFeedbackContext extends TurnDiagnosisContext {
    /** Tool names the model may call next. */
    readonly availableTools: readonly string[]
    /** True when only attempt_completion is accepted. */
    readonly finishing: boolean
}

/** Tag names models commonly emit when they imitate a tool call in text. */
const PSEUDO_TOOL_TAGS = new Set(["tool_call", "tool_use", "tool", "function_calls", "function_call", "invoke"])
const TAG_PATTERN = /<\/?([a-z][a-z0-9_:-]*)\b[^>]*>/gi
const COMPLETION_TOOL = "attempt_completion"
const DEFAULT_LIMIT_OUTCOME = "the run stops and reports failure"
const NO_RESTART_GUIDANCE = "Do not restart or repeat earlier analysis; everything found so far is still in this conversation."

/**
 * Classify a response that produced no executable tool call.
 *
 * Provider stop reasons win because they explain why nothing usable arrived.
 * Tool-shaped markup comes before plain text: the model tried to call a tool,
 * and telling it only "use a tool" would hide that the attempt was malformed.
 */
export function classifyToollessTurn(observation: ToollessTurnObservation, knownToolNames: readonly string[]): TurnFailure {
    const outputTokens = normalizeTokens(observation.outputTokens)
    const withTokens = <T extends TurnFailureKind>(kind: T): TurnFailure =>
        outputTokens === undefined ? { kind } : { kind, outputTokens }

    if (observation.stopReason === "output_limit") return withTokens("output_limit")
    if (observation.stopReason === "content_filter") return withTokens("content_filter")

    const text = observation.visibleText.trim()
    if (text && containsToolMarkup(text, knownToolNames)) return withTokens("tool_markup_in_text")
    if (text) return withTokens("text_only")
    if (observation.reasoningPresent) return withTokens("reasoning_only")
    return withTokens("empty_response")
}

/** One-sentence statement of what went wrong, shared by model feedback and run errors. */
export function describeTurnFailure(failure: TurnFailure, usesNativeToolCalls: boolean): string {
    const tokens = failure.outputTokens === undefined ? "" : ` (~${failure.outputTokens.toLocaleString()} output tokens)`
    switch (failure.kind) {
        case "empty_response":
            return "The previous response was empty: no text, no reasoning and no tool call reached the runtime."
        case "reasoning_only":
            return `The previous response contained only internal reasoning${tokens} and no tool call. Reasoning is not shown to anyone and does not advance the task.`
        case "output_limit":
            return `The previous response was cut off at the output token limit${tokens} before any tool call was complete.`
        case "content_filter":
            return `The provider stopped the previous response with a content filter${tokens} before any tool call.`
        case "tool_markup_in_text":
            return usesNativeToolCalls
                ? "The previous response wrote tool-call markup as plain text. Text is never executed; tools must be called through the native tool-calling interface."
                : "The previous response contained tool markup that could not be parsed into a valid tool call (unknown tool name, wrong nesting, or an unclosed tag)."
        case "text_only":
            return "The previous response contained text but no tool call. Text alone does not advance the task."
        case "missing_completion_result":
            return "attempt_completion was called without a non-empty result."
        case "convergence_violation": {
            const tools = failure.rejectedTools?.length ? failure.rejectedTools.join(", ") : "another tool"
            return `The previous response called ${tools} after you were told to finish; only attempt_completion is accepted now.`
        }
    }
}

/**
 * The failure and how many failures remain, without a next step.
 *
 * For callers whose next steps are their own contract, such as the main task,
 * which may hand control back to the user rather than only call a tool.
 */
export function buildTurnDiagnosis(failure: TurnFailure, context: TurnDiagnosisContext): string {
    return [...diagnosisLines(failure, context), NO_RESTART_GUIDANCE].join("\n")
}

/** Build the feedback the model reads before its next response. */
export function buildTurnFailureFeedback(failure: TurnFailure, context: TurnFeedbackContext): string {
    const lines = diagnosisLines(failure, context)
    lines.push("", "Next step:", `- ${NO_RESTART_GUIDANCE}`)
    if (failure.kind === "output_limit") {
        lines.push("- Keep reasoning brief and emit the tool call early in the response.")
    }
    lines.push(`- ${describeNextAction(failure, context)}`)
    lines.push(`- ${describeCallFormat(context)}`)
    return lines.join("\n")
}

function diagnosisLines(failure: TurnFailure, context: TurnDiagnosisContext): string[] {
    const lines = [`[ERROR] ${describeTurnFailure(failure, context.usesNativeToolCalls)}`]
    if (context.consecutiveFailures !== undefined && context.maxConsecutiveFailures !== undefined) {
        lines.push(
            `Consecutive failed responses: ${context.consecutiveFailures} of ${context.maxConsecutiveFailures}. At ${context.maxConsecutiveFailures} ${context.limitOutcome ?? DEFAULT_LIMIT_OUTCOME}.`,
        )
    }
    return lines
}

function describeNextAction(failure: TurnFailure, context: TurnFeedbackContext): string {
    if (context.finishing) {
        return "Call attempt_completion now with a non-empty result that summarizes the findings already collected. No other tool is accepted."
    }
    if (failure.kind === "missing_completion_result") {
        return "Call attempt_completion again and put the findings in a non-empty result."
    }
    const tools = context.availableTools.length > 0 ? ` Available tools: ${context.availableTools.join(", ")}.` : ""
    return `Respond with exactly one tool call.${tools} If the findings are already sufficient, call attempt_completion with them.`
}

function describeCallFormat(context: TurnFeedbackContext): string {
    if (context.usesNativeToolCalls) {
        return "Use the native tool-calling interface; do not write tool calls as text."
    }
    const example = context.finishing
        ? `<${COMPLETION_TOOL}>\n<result>\nYour findings here\n</result>\n</${COMPLETION_TOOL}>`
        : "<tool_name>\n<parameter_name>value</parameter_name>\n</tool_name>"
    return `Write the tool call as XML with the exact tool name as the outer tag, for example:\n${example}`
}

function containsToolMarkup(text: string, knownToolNames: readonly string[]): boolean {
    const known = new Set(knownToolNames.map((name) => name.toLowerCase()))
    for (const match of text.matchAll(TAG_PATTERN)) {
        const tag = match[1]?.toLowerCase()
        if (!tag) continue
        if (known.has(tag) || PSEUDO_TOOL_TAGS.has(tag) || tag.includes(":")) return true
    }
    return false
}

function normalizeTokens(value: number | undefined): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/**
 * Failed responses in a row, cleared by any successfully executed tool.
 *
 * Counting all failure kinds together bounds a run that alternates between
 * them; separate counters let such a run spin forever without reaching any limit.
 */
export class ConsecutiveTurnFailures {
    private failures: TurnFailure[] = []

    constructor(readonly limit: number) {}

    record(failure: TurnFailure): void {
        this.failures.push(failure)
    }

    reset(): void {
        this.failures = []
    }

    get count(): number {
        return this.failures.length
    }

    get exhausted(): boolean {
        return this.failures.length >= this.limit
    }

    list(): readonly TurnFailure[] {
        return [...this.failures]
    }
}
