import type { ReactNode } from "react"
import { TaskRuntimeControls } from "./TaskRuntimeControls"

interface ChatInputRuntimeControlsProps {
    profileControl: ReactNode
}

/** Existing Profile entry followed by Task-local runtime controls in the chat input toolbar. */
export function ChatInputRuntimeControls({ profileControl }: ChatInputRuntimeControlsProps) {
    return (
        <div
            className="flex h-[18.5px] min-w-0 flex-[0_1_auto] items-center gap-[4px] overflow-hidden"
            data-chat-input-runtime-controls>
            <div className="min-w-0 max-w-full flex-[0_1_auto] overflow-hidden" data-chat-input-slot="profile">
                {profileControl}
            </div>
            <TaskRuntimeControls />
        </div>
    )
}
