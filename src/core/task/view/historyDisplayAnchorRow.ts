import type { UiMessage } from "@shared/ExtensionMessage"
import { createCanonicalAskRow } from "../ask-row"
import { getInteraction } from "../interaction/InteractionRegistry"
import type { HistoryDisplayProjection } from "./canonical/projectHistoryDisplayState"

/**
 * The ask row a synthesized history interaction anchors to, placed after the durable history.
 *
 * It exists only in the display: nothing is written until the user answers and
 * the task is promoted. A completed task asks to resume rather than replaying
 * its completion row. It lives outside the canonical view because it renders a
 * chat row, which the kernel-only projection must not depend on.
 */
export function historyDisplayAnchorRow(
    synthetic: NonNullable<HistoryDisplayProjection["synthetic"]>,
    durableMessages: readonly UiMessage[],
): UiMessage {
    const ts = durableMessages.reduce((latest, message) => Math.max(latest, message.ts), 0) + 1
    const ask = synthetic.kind === "completion" ? "resume_completed_task" : getInteraction(synthetic.kind).taskAsk
    return createCanonicalAskRow(ask, "", ts, synthetic.interactionId)
}
