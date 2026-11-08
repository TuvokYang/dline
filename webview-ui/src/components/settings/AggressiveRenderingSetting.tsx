import {
    AGGRESSIVE_RENDERING_LEVELS,
    isAggressiveRenderingLevel,
    normalizeAggressiveRenderingLevel,
} from "@shared/AggressiveRendering"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ProfileField } from "./profile-ui"
import { updateSetting } from "./utils/settingsHandlers"

/**
 * Chooses how far the chat folds a turn's activity rows.
 *
 * The control exists only while the remote rollout offers it. Hiding it does not
 * reset the stored choice: the chat simply renders at `standard` until the flag
 * turns on again (see `effectiveAggressiveRendering`).
 */
const AggressiveRenderingSetting = () => {
    const { aggressiveRendering } = useExtensionState()
    const { t } = useUiTranslation()

    if (!aggressiveRendering?.featureFlag) return null

    return (
        <ProfileField
            description={
                <span id="aggressive-rendering-description">{t("settings.general.aggressiveRendering.description")}</span>
            }
            htmlFor="aggressive-rendering"
            label={t("settings.general.aggressiveRendering.label")}>
            <VSCodeDropdown
                aria-describedby="aggressive-rendering-description"
                aria-label={t("settings.general.aggressiveRendering.label")}
                className="w-full"
                id="aggressive-rendering"
                onChange={(event) => {
                    const value = (event.target as HTMLSelectElement).value
                    if (isAggressiveRenderingLevel(value)) {
                        updateSetting("aggressiveRendering", value)
                    }
                }}
                value={normalizeAggressiveRenderingLevel(aggressiveRendering.user)}>
                <span slot="selected-value">
                    {t(`settings.general.aggressiveRendering.${normalizeAggressiveRenderingLevel(aggressiveRendering.user)}`)}
                </span>
                {AGGRESSIVE_RENDERING_LEVELS.map((level) => (
                    <VSCodeOption aria-label={t(`settings.general.aggressiveRendering.${level}`)} key={level} value={level}>
                        {t(`settings.general.aggressiveRendering.${level}`)}
                    </VSCodeOption>
                ))}
            </VSCodeDropdown>
        </ProfileField>
    )
}

export default AggressiveRenderingSetting
