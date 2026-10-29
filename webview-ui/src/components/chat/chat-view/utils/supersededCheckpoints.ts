import { dropSupersededAdjacentCheckpoints } from "@shared/chat/checkpointAdjacency"
import type { UiMessage } from "@shared/ExtensionMessage"

/** Compatibility entry point; the shared projection owns checkpoint supersession. */
export function dropSupersededChatOnlyCheckpoints(drawn: readonly UiMessage[]): UiMessage[] {
    return dropSupersededAdjacentCheckpoints(drawn)
}
