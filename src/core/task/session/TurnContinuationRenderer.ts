import { formatResponse } from "@core/prompts/responses"
import type { ComposeContinuationPort } from "../executors/compose/ProductionComposeAdapter"
import type { TurnContinuationReason } from "../kernel"

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
 * into the words the model reads, reusing the shared prompt text so the main
 * task and a subagent state the same contract.
 */
export class TurnContinuationRenderer implements ComposeContinuationPort {
    constructor(private readonly options: TurnContinuationRendererOptions) {}

    render(reason: TurnContinuationReason): string | undefined {
        if (reason !== "no_tools_used") return undefined
        return formatResponse.noToolsUsed(this.options.usesNativeToolCalls())
    }
}
