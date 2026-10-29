import type { UiMessage } from "@shared/ExtensionMessage"

/**
 * Interactions that end a turn: execution admits at most one per request round,
 * and the chat draws it as the last row of that round.
 */
const TURN_END_KINDS = new Set<string>([
    "completion_result",
    "followup",
    "make_plan",
    "qna_respond",
    "generate_report",
    "new_task",
])

/**
 * Turn-ending interactions that are only written after the model ended its turn
 * and ordinary tool execution drained (see `pool-admission.ts`).
 *
 * `new_task` is excluded: its row is a manual-approval prompt that can coexist
 * with sibling tools that are still running, so it says nothing about whether
 * the rows before it finished.
 */
const SETTLED_TURN_END_KINDS = new Set<string>(["completion_result", "followup", "make_plan", "qna_respond", "generate_report"])

function interactionKind(message: UiMessage): string | undefined {
    return message.type === "ask" ? message.ask : message.say
}

/** Whether the row is a turn-ending interaction, which owns the tail of its request round. */
export function isTurnEndRow(message: UiMessage): boolean {
    const kind = interactionKind(message)
    return kind !== undefined && TURN_END_KINDS.has(kind)
}

/**
 * Whether the row proves that every row before it belongs to a finished turn.
 *
 * A partial preview proves nothing yet: the model may still be streaming the
 * turn's last tool calls behind it.
 */
export function isSettledTurnEnd(message: UiMessage): boolean {
    const kind = interactionKind(message)
    return message.partial !== true && kind !== undefined && SETTLED_TURN_END_KINDS.has(kind)
}
