import type { UiLanguagePreference } from "@shared/UiLanguage"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { ExtensionStateContext, useExtensionState } from "@/context/ExtensionStateContext"
import { UiLanguageBridge } from "@/i18n/UiLanguageBridge"
import UiLanguageSetting from "./UiLanguageSetting"

function LanguagePreview({
    initialPreference,
    hostDisplayLanguage,
}: {
    initialPreference: UiLanguagePreference
    hostDisplayLanguage: string
}) {
    const extensionState = useExtensionState()
    const [preference, setPreference] = useState(initialPreference)
    return (
        <ExtensionStateContext.Provider value={{ ...extensionState, uiLanguage: preference, hostDisplayLanguage }}>
            <UiLanguageBridge>
                <UiLanguageSetting
                    hostDisplayLanguage={hostDisplayLanguage}
                    onPreferenceChange={async (value) => setPreference(value)}
                    preference={preference}
                />
            </UiLanguageBridge>
        </ExtensionStateContext.Provider>
    )
}

const meta = {
    title: "Settings/Interface Language",
    component: LanguagePreview,
    args: { initialPreference: "auto", hostDisplayLanguage: "zh-CN" },
    argTypes: { initialPreference: { control: false }, hostDisplayLanguage: { control: false } },
} satisfies Meta<typeof LanguagePreview>
export default meta
type Story = StoryObj<typeof meta>

export const FollowHost: Story = {}
export const EnglishOverride: Story = { args: { initialPreference: "en" } }
export const ChineseOverride: Story = { args: { initialPreference: "zh-CN", hostDisplayLanguage: "en" } }
