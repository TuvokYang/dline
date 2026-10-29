import {
    AGGRESSIVE_RENDERING_LABELS,
    AGGRESSIVE_RENDERING_LEVELS,
    isAggressiveRenderingLevel,
    normalizeAggressiveRenderingLevel,
} from "@shared/AggressiveRendering"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useExtensionState } from "@/context/ExtensionStateContext"
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

    if (!aggressiveRendering?.featureFlag) return null

    return (
        <div className="mb-4">
            <label className="block mb-1 text-base font-medium" htmlFor="aggressive-rendering">
                Chat folding
            </label>
            <VSCodeDropdown
                className="w-full"
                id="aggressive-rendering"
                onChange={(event) => {
                    const value = (event.target as HTMLSelectElement).value
                    if (isAggressiveRenderingLevel(value)) {
                        updateSetting("aggressiveRendering", value)
                    }
                }}
                value={normalizeAggressiveRenderingLevel(aggressiveRendering.user)}>
                {AGGRESSIVE_RENDERING_LEVELS.map((level) => (
                    <VSCodeOption key={level} value={level}>
                        {AGGRESSIVE_RENDERING_LABELS[level]}
                    </VSCodeOption>
                ))}
            </VSCodeDropdown>
            <p className="text-xs text-(--vscode-descriptionForeground) mt-1">
                Folded blocks show a summary and expand on click. Rows that are still running or that failed always stay visible.
            </p>
        </div>
    )
}

export default AggressiveRenderingSetting
