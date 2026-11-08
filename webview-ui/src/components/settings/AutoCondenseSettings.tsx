import {
    MAX_AUTO_CONDENSE_CONTEXT_TOKENS,
    MAX_AUTO_CONDENSE_TRIGGER_PERCENT,
    MIN_AUTO_CONDENSE_TRIGGER_PERCENT,
    normalizeAutoCondenseMaxContextTokens,
    normalizeAutoCondenseReservePair,
    normalizeAutoCondenseTriggerPercent,
} from "@shared/auto-condense"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import SettingsSlider from "./SettingsSlider"
import { updateSetting, updateSettings } from "./utils/settingsHandlers"
import { useDebouncedInput } from "./utils/useDebouncedInput"

const MAX_CONTEXT_K = Math.floor(MAX_AUTO_CONDENSE_CONTEXT_TOKENS / 1_000)

function parseTokenK(value: string, emptyValue?: number): number | undefined {
    if (value.trim() === "") return emptyValue
    if (!/^\d+$/.test(value)) return undefined
    const tokenK = Number(value)
    if (!Number.isSafeInteger(tokenK) || tokenK > MAX_CONTEXT_K) return undefined
    return tokenK * 1_000
}

function splitReservePair(value: string): [string, string] {
    const separatorIndex = value.indexOf(":")
    return separatorIndex < 0 ? [value, ""] : [value.slice(0, separatorIndex), value.slice(separatorIndex + 1)]
}

const AutoCondenseSettings = () => {
    const { t } = useUiTranslation()
    const {
        autoCondenseMaxContextTokens,
        autoCondenseMaxReserveTokens,
        autoCondenseMinReserveTokens,
        autoCondenseTriggerPercent,
    } = useExtensionState()
    const persistedTriggerPercent = normalizeAutoCondenseTriggerPercent(autoCondenseTriggerPercent)
    const persistedReservePair = normalizeAutoCondenseReservePair(autoCondenseMinReserveTokens, autoCondenseMaxReserveTokens)
    const persistedMinReserveK = Math.floor(persistedReservePair.minReserveTokens / 1_000)
    const persistedMaxReserveK = Math.floor(persistedReservePair.maxReserveTokens / 1_000)
    const persistedReservePairValue = `${persistedMinReserveK}:${persistedMaxReserveK}`
    const persistedMaxContextTokens = normalizeAutoCondenseMaxContextTokens(autoCondenseMaxContextTokens)
    const [triggerPercent, setTriggerPercent] = useDebouncedInput(persistedTriggerPercent, (value) =>
        updateSetting("autoCondenseTriggerPercent", value),
    )
    const [reservePairValue, setReservePairValue] = useDebouncedInput(
        persistedReservePairValue,
        (value) => {
            const [minReserveK, maxReserveK] = splitReservePair(value)
            const minReserveTokens = parseTokenK(minReserveK)
            const maxReserveTokens = parseTokenK(maxReserveK)
            if (minReserveTokens === undefined || maxReserveTokens === undefined || minReserveTokens > maxReserveTokens) return
            return updateSettings({
                autoCondenseMinReserveTokens: minReserveTokens,
                autoCondenseMaxReserveTokens: maxReserveTokens,
            })
        },
        250,
    )
    const [minReserveK, maxReserveK] = splitReservePair(reservePairValue)
    const minReserveTokens = parseTokenK(minReserveK)
    const maxReserveTokens = parseTokenK(maxReserveK)
    const minReserveError = minReserveTokens === undefined
    const maxReserveError = maxReserveTokens === undefined
    const reserveOrderError =
        minReserveTokens !== undefined && maxReserveTokens !== undefined && minReserveTokens > maxReserveTokens
    const [maxContextK, setMaxContextK] = useDebouncedInput(
        String(Math.floor(persistedMaxContextTokens / 1_000)),
        (value) => {
            const contextTokens = parseTokenK(value, 0)
            if (contextTokens !== undefined) return updateSetting("autoCondenseMaxContextTokens", contextTokens)
        },
        250,
    )
    const maxContextError = parseTokenK(maxContextK, 0) === undefined

    return (
        <div className="ml-3 mb-3 pl-3 border-l border-editor-widget-border/60 space-y-4">
            <SettingsSlider
                description={t("settings.ui.compact.description")}
                label={t("settings.ui.compact.point")}
                max={MAX_AUTO_CONDENSE_TRIGGER_PERCENT}
                min={MIN_AUTO_CONDENSE_TRIGGER_PERCENT}
                onChange={setTriggerPercent}
                step={1}
                value={triggerPercent}
                valueWidth="w-8"
            />
            <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                    <Label className="text-xs text-description" htmlFor="auto-condense-min-reserve-k">
                        {t("settings.ui.compact.min")}
                    </Label>
                    <div className="flex items-center gap-2">
                        <Input
                            aria-invalid={minReserveError || reserveOrderError}
                            aria-label={t("settings.ui.compact.minAccessible")}
                            className="h-8"
                            id="auto-condense-min-reserve-k"
                            max={MAX_CONTEXT_K}
                            min={0}
                            onBlur={() => {
                                if (minReserveError || reserveOrderError) setReservePairValue(persistedReservePairValue)
                            }}
                            onChange={(event) => setReservePairValue(`${event.target.value}:${maxReserveK}`)}
                            step={1}
                            type="number"
                            value={minReserveK}
                        />
                        <span className="shrink-0 text-xs text-description">K</span>
                    </div>
                </div>
                <div className="space-y-1.5">
                    <Label className="text-xs text-description" htmlFor="auto-condense-max-reserve-k">
                        {t("settings.ui.compact.max")}
                    </Label>
                    <div className="flex items-center gap-2">
                        <Input
                            aria-invalid={maxReserveError || reserveOrderError}
                            aria-label={t("settings.ui.compact.maxAccessible")}
                            className="h-8"
                            id="auto-condense-max-reserve-k"
                            max={MAX_CONTEXT_K}
                            min={0}
                            onBlur={() => {
                                if (maxReserveError || reserveOrderError) setReservePairValue(persistedReservePairValue)
                            }}
                            onChange={(event) => setReservePairValue(`${minReserveK}:${event.target.value}`)}
                            step={1}
                            type="number"
                            value={maxReserveK}
                        />
                        <span className="shrink-0 text-xs text-description">K</span>
                    </div>
                </div>
            </div>
            {minReserveError || maxReserveError ? (
                <p className="text-xs text-(--vscode-errorForeground)">
                    {t("settings.ui.compact.reserveInvalid", { max: MAX_CONTEXT_K })}
                </p>
            ) : reserveOrderError ? (
                <p className="text-xs text-(--vscode-errorForeground)">{t("settings.ui.compact.orderInvalid")}</p>
            ) : (
                <p className="text-xs text-description">{t("settings.ui.compact.rangeHelp")}</p>
            )}
            <div className="space-y-1.5">
                <Label className="text-xs text-description" htmlFor="auto-condense-max-context-k">
                    {t("settings.ui.compact.context")}
                </Label>
                <div className="flex items-center gap-2">
                    <Input
                        aria-invalid={maxContextError}
                        aria-label={t("settings.ui.compact.contextAccessible")}
                        className="h-8"
                        id="auto-condense-max-context-k"
                        max={MAX_CONTEXT_K}
                        min={0}
                        onBlur={() => {
                            if (maxContextK.trim() === "") setMaxContextK("0")
                            else if (maxContextError) setMaxContextK(String(Math.floor(persistedMaxContextTokens / 1_000)))
                        }}
                        onChange={(event) => setMaxContextK(event.target.value)}
                        step={1}
                        type="number"
                        value={maxContextK}
                    />
                    <span className="shrink-0 text-xs text-description">{t("settings.ui.compact.kTokens")}</span>
                </div>
                {maxContextError ? (
                    <p className="text-xs text-(--vscode-errorForeground)">
                        {t("settings.ui.compact.contextInvalid", { max: MAX_CONTEXT_K })}
                    </p>
                ) : (
                    <p className="text-xs text-description">{t("settings.ui.compact.unlimited")}</p>
                )}
            </div>
        </div>
    )
}

export default AutoCondenseSettings
