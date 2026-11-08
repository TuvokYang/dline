import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { StateServiceClient } from "@/services/grpc-client"
import Section from "../Section"

interface DebugSectionProps {
    onResetState: (resetGlobalState?: boolean) => Promise<void>
    renderSectionHeader: (tabId: string) => JSX.Element | null
}

const DebugSection = ({ onResetState, renderSectionHeader }: DebugSectionProps) => {
    const { t } = useUiTranslation()
    const { setShowWelcome } = useExtensionState()
    return (
        <div>
            {renderSectionHeader("debug")}
            <Section>
                <Button onClick={() => onResetState()} variant="error">
                    {t("settings.ui.debug.workspace")}
                </Button>
                <Button onClick={() => onResetState(true)} variant="error">
                    {t("settings.ui.debug.global")}
                </Button>
                <p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">{t("settings.ui.debug.resetHelp")}</p>
            </Section>
            <Section>
                <Button
                    onClick={async () =>
                        await StateServiceClient.setWelcomeViewCompleted({ value: false })
                            .catch(() => {})
                            .finally(() => setShowWelcome(true))
                    }
                    variant="secondary">
                    {t("settings.ui.debug.onboarding")}
                </Button>
            </Section>
        </div>
    )
}

export default DebugSection
