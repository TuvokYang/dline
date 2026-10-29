import AggressiveRenderingSetting from "../AggressiveRenderingSetting"
import ChatInputSendShortcutSetting from "../ChatInputSendShortcutSetting"
import PreferredLanguageSetting from "../PreferredLanguageSetting"
import Section from "../Section"

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
    return (
        <div>
            {renderSectionHeader("general")}
            <Section>
                <PreferredLanguageSetting />
                <ChatInputSendShortcutSetting />
                <AggressiveRenderingSetting />
            </Section>
        </div>
    )
}

export default GeneralSettingsSection
