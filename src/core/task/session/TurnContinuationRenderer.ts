import { formatResponse } from "@core/prompts/responses"
import { buildTurnDiagnosis, classifyToollessTurn, type ToollessTurnObservation } from "@core/prompts/turn-diagnosis"
import type { ClineStorageMessage } from "@shared/messages/content"
import { DlineDefaultTool } from "@shared/tools"
import type {
    ComposeContinuationPort,
    PreviousResponseObservation,
    TurnContinuationInput,
} from "../executors/compose/ProductionComposeAdapter"

const KNOWN_TOOL_NAMES: readonly string[] = Object.values(DlineDefaultTool)
const LIMIT_OUTCOME = "the task pauses and asks the user for guidance"

export interface TurnContinuationRendererOptions {
    /**
     * Whether the model is being given provider-native tool definitions.
     *
     * The reminder has to match how tools were offered: an XML profile needs the
     * usage instructions repeated, while a native profile already has the schema
     * and only needs to be told that no call arrived.
     */
    readonly usesNativeToolCalls: () => boolean
}

/**
 * Says why a round the user did not ask for was opened.
 *
 * The kernel decides that a toolless answer continues; this turns that decision
 * into the words the model reads. The diagnosis names what the previous
 * response actually contained, with the same classifier a subagent uses, and
 * the main task's own next steps follow it because only the main task may hand
 * control back to the user.
 */
export class TurnContinuationRenderer implements ComposeContinuationPort {
    constructor(private readonly options: TurnContinuationRendererOptions) {}

    render(input: TurnContinuationInput): string | undefined {
        if (input.reason !== "no_tools_used") return undefined
        const usesNativeToolCalls = this.options.usesNativeToolCalls()
        const reminder = formatResponse.noToolsUsed(usesNativeToolCalls)
        const observation = observeToollessTurn(input.previousResponse)
        if (!observation) return reminder
        const diagnosis = buildTurnDiagnosis(classifyToollessTurn(observation, KNOWN_TOOL_NAMES), {
            usesNativeToolCalls,
            consecutiveFailures: input.toollessStreak,
            maxConsecutiveFailures: input.toollessLimit,
            limitOutcome: LIMIT_OUTCOME,
        })
        return `${diagnosis}\n\n${reminder}`
    }
}

/** What the previous response contained, or undefined when nothing can be concluded. */
function observeToollessTurn(previous: PreviousResponseObservation): ToollessTurnObservation | undefined {
    if (previous.kind === "unobserved") return undefined
    const content =
        previous.kind === "not_journaled" ? { visibleText: "", reasoningPresent: false } : observeStoredResponse(previous.message)
    const ending = previous.ending
    return {
        ...content,
        ...(ending?.stopReason === undefined ? {} : { stopReason: ending.stopReason }),
        ...(ending?.outputTokens === undefined ? {} : { outputTokens: ending.outputTokens }),
    }
}

function observeStoredResponse(message: ClineStorageMessage): Pick<ToollessTurnObservation, "visibleText" | "reasoningPresent"> {
    if (typeof message.content === "string") return { visibleText: message.content, reasoningPresent: false }
    const visibleText = message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .filter(Boolean)
        .join("\n")
    const reasoningPresent = message.content.some((block) => block.type === "thinking" || block.type === "redacted_thinking")
    return { visibleText, reasoningPresent }
}
