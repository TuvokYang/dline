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
                description="When the model window exceeds Maximum context, that absolute cap is the trigger center. Otherwise, the percentage-derived reserve is clamped between the minimum and maximum reserve. A 2K estimation tolerance is applied automatically."
                label="Compression point (%)"
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
                        Minimum reserve
                    </Label>
                    <div className="flex items-center gap-2">
                        <Input
                            aria-invalid={minReserveError || reserveOrderError}
                            aria-label="Minimum reserve (K tokens)"
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
                        Maximum reserve
                    </Label>
                    <div className="flex items-center gap-2">
                        <Input
                            aria-invalid={maxReserveError || reserveOrderError}
                            aria-label="Maximum reserve (K tokens)"
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
                    Reserve values must be whole numbers from 0 to {MAX_CONTEXT_K}.
                </p>
            ) : reserveOrderError ? (
                <p className="text-xs text-(--vscode-errorForeground)">Minimum reserve cannot exceed maximum reserve.</p>
            ) : (
                <p className="text-xs text-description">The percentage-derived reserve is clamped to this range.</p>
            )}
            <div className="space-y-1.5">
                <Label className="text-xs text-description" htmlFor="auto-condense-max-context-k">
                    Maximum context
                </Label>
                <div className="flex items-center gap-2">
                    <Input
                        aria-invalid={maxContextError}
                        aria-label="Maximum context (K tokens)"
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
                    <span className="shrink-0 text-xs text-description">K tokens</span>
                </div>
                {maxContextError ? (
                    <p className="text-xs text-(--vscode-errorForeground)">Enter a whole number from 0 to {MAX_CONTEXT_K}.</p>
                ) : (
                    <p className="text-xs text-description">0 means no absolute limit.</p>
                )}
            </div>
        </div>
    )
}

export default AutoCondenseSettings
