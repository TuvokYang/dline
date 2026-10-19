import type { UiMessage } from "@shared/ExtensionMessage"
import { CheckmarkControl } from "@/components/common/CheckmarkControl"

/** The restore control of one `checkpoint_created` row, wired from the row's own fields. */
export function CheckpointMarker({ message }: { message: UiMessage }) {
    return (
        <CheckmarkControl
            hasWorkspaceCheckpoint={message.lastCheckpointHash?.some(Boolean) === true}
            isCheckpointCheckedOut={message.isCheckpointCheckedOut}
            messageTs={message.ts}
            pending={message.partial === true}
            source={message.checkpointSource}
            workspaceCheckpointCoverage={{
                available: message.lastCheckpointHash?.filter(Boolean).length ?? 0,
                total: message.checkpointWorkspaceRoots?.length ?? message.lastCheckpointHash?.length ?? 0,
            }}
        />
    )
}
