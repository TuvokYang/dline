import type { ToolUse } from "@core/assistant-message"
import type { IToolHandler } from "../tools/ToolExecutorCoordinator"
import type { ToolResponse } from "../tools/ToolResponse"
import type { TaskConfig } from "../tools/types/TaskConfig"
import type { InteractionKind } from "./Interaction"
import type { InteractionOutcome } from "./InteractionProtocol"
import { getInteraction } from "./InteractionRegistry"

export interface TurnEndContinuationHandler extends IToolHandler {
	continueInteraction(config: TaskConfig, block: ToolUse, outcome: InteractionOutcome): Promise<ToolResponse>
}

/** Return whether one interaction requires a handler continuation after its response. */
export function requiresTurnEndContinuation(kind: InteractionKind): boolean {
	const continuation = getInteraction(kind).continuation
	return continuation === "handler" || continuation === "completion"
}

/** Narrow a registered tool handler to the shared turn-end continuation contract. */
export function isTurnEndContinuationHandler(handler: IToolHandler): handler is TurnEndContinuationHandler {
	return "continueInteraction" in handler && typeof handler.continueInteraction === "function"
}
