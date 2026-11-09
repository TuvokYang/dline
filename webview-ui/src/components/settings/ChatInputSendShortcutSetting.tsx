import {
    type ChatInputSendShortcut,
    DEFAULT_CHAT_INPUT_SEND_SHORTCUT,
    isChatInputSendShortcut,
} from "@shared/ChatInputSendShortcut"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ProfileField } from "./profile-ui"
import { updateSetting } from "./utils/settingsHandlers"

const OPTIONS = [
    { label: "settings.general.chatInputSendShortcut.enter", value: "enter" },
    { label: "settings.general.chatInputSendShortcut.ctrlEnter", value: "ctrlEnter" },
    { label: "settings.general.chatInputSendShortcut.shiftEnter", value: "shiftEnter" },
] as const satisfies readonly { label: string; value: ChatInputSendShortcut }[]

const ChatInputSendShortcutSetting = () => {
    const { chatInputSendShortcut } = useExtensionState()
    const { t } = useUiTranslation()
    const value = chatInputSendShortcut ?? DEFAULT_CHAT_INPUT_SEND_SHORTCUT
    const selectedLabel = OPTIONS.find((option) => option.value === value)!.label

    return (
        <ProfileField htmlFor="chat-input-send-shortcut" label={t("settings.general.chatInputSendShortcut.label")}>
            <VSCodeDropdown
                aria-label={t("settings.general.chatInputSendShortcut.label")}
                className="w-full"
                id="chat-input-send-shortcut"
                onChange={(event) => {
                    const value = (event.target as HTMLSelectElement).value
                    if (isChatInputSendShortcut(value)) {
                        updateSetting("chatInputSendShortcut", value)
                    }
                }}
                value={value}>
                <span slot="selected-value">{t(selectedLabel)}</span>
                {OPTIONS.map((option) => (
                    <VSCodeOption key={option.value} value={option.value}>
                        {t(option.label)}
                    </VSCodeOption>
                ))}
            </VSCodeDropdown>
        </ProfileField>
    )
}

export default ChatInputSendShortcutSetting
