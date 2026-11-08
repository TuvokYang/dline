import { useExtensionState } from "@/context/ExtensionStateContext"
import AggressiveRenderingSetting from "../AggressiveRenderingSetting"
import ChatInputSendShortcutSetting from "../ChatInputSendShortcutSetting"
import PreferredLanguageSetting from "../PreferredLanguageSetting"
import { ProfileForm } from "../profile-ui"
import Section from "../Section"
import UiLanguageSetting from "../UiLanguageSetting"
import { updateSetting } from "../utils/settingsHandlers"

interface GeneralSettingsSectionProps {
    renderSectionHeader: (tabId: string) => JSX.Element | null
}

/**
 * Preferences that shape everyday chat behaviour.
 *
 * Reporting consent used to live here too, but it belongs with the diagnostic
 * bundle export in About: both describe what Dline may record, and keeping the
 * switch away from the export made the export's failure message confusing.
 */
const GeneralSettingsSection = ({ renderSectionHeader }: GeneralSettingsSectionProps) => {
    const { uiLanguage, hostDisplayLanguage } = useExtensionState()
    return (
        <div>
            {renderSectionHeader("general")}
            <Section>
                <ProfileForm>
                    <UiLanguageSetting
                        hostDisplayLanguage={hostDisplayLanguage}
                        onPreferenceChange={(value) => updateSetting("uiLanguage", value)}
                        preference={uiLanguage}
                    />
                    <PreferredLanguageSetting />
                    <ChatInputSendShortcutSetting />
                    <AggressiveRenderingSetting />
                </ProfileForm>
            </Section>
        </div>
    )
}

export default GeneralSettingsSection
