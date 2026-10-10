import {
    type ChatInputSendShortcut,
    DEFAULT_CHAT_INPUT_SEND_SHORTCUT,
    isChatInputSendShortcut,
} from "@shared/ChatInputSendShortcut"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { updateSetting } from "./utils/settingsHandlers"

const OPTIONS: Array<{ label: string; value: ChatInputSendShortcut }> = [
    { label: "Enter", value: "enter" },
    { label: "Ctrl + Enter", value: "ctrlEnter" },
    { label: "Shift + Enter", value: "shiftEnter" },
]

const ChatInputSendShortcutSetting = () => {
    const { chatInputSendShortcut } = useExtensionState()

    return (
        <div className="mb-4">
            <label className="block mb-1 text-base font-medium" htmlFor="chat-input-send-shortcut">
                Send messages with
            </label>
            <VSCodeDropdown
                className="w-full"
                id="chat-input-send-shortcut"
                onChange={(event) => {
                    const value = (event.target as HTMLSelectElement).value
                    if (isChatInputSendShortcut(value)) {
                        updateSetting("chatInputSendShortcut", value)
                    }
                }}
                value={chatInputSendShortcut ?? DEFAULT_CHAT_INPUT_SEND_SHORTCUT}>
                {OPTIONS.map((option) => (
                    <VSCodeOption key={option.value} value={option.value}>
                        {option.label}
                    </VSCodeOption>
                ))}
            </VSCodeDropdown>
        </div>
    )
}

export default ChatInputSendShortcutSetting
