import { ApiFormat, type ModelPricing } from "@shared/proto/dline/models/metadata"
import { VSCodeCheckbox, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useId, useState } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ApiKeyField } from "../common/ApiKeyField"
import { DropdownContainer } from "../common/ModelSelector"
import { PricingEditor } from "../common/PricingEditor"
import { ProfileField } from "../profile-ui"
import ReasoningEffortSelector from "../ReasoningEffortSelector"
import { ProviderUsage } from "./ProviderUsage"

/**
 * Effort levels DeepSeek documents for its thinking models.
 *
 * The provider supports a non-thinking mode plus graded reasoning effort, which
 * is exactly the shape `ThinkingControl` exposes everywhere else: an
 * `Enable Thinking` checkbox and a `Thinking Level` selector. This card must
 * not replace that with a bespoke on/off dropdown, because the same Profile is
 * also edited through `DeepSeekProvider`, and two surfaces describing one
 * setting differently teach the user that they are two settings.
 */
export const DEEP_SEEK_EFFORT_LEVELS = ["low", "high", "max"] as const

export type DeepSeekEffort = (typeof DEEP_SEEK_EFFORT_LEVELS)[number]

/** Thinking is on by default, at the standard level. */
export const DEEP_SEEK_DEFAULT_EFFORT: DeepSeekEffort = "high"

/** The protocols DeepSeek publishes: OpenAI Chat, Responses, and Anthropic Messages. */
export const DEEP_SEEK_API_FORMATS: readonly ApiFormat[] = [
    ApiFormat.OPENAI_CHAT,
    ApiFormat.OPENAI_RESPONSES,
    ApiFormat.ANTHROPIC_CHAT,
]

const DEEP_SEEK_API_FORMAT_LABELS: Readonly<Record<number, string>> = {
    [ApiFormat.OPENAI_CHAT]: "OpenAI Chat Completions",
    [ApiFormat.OPENAI_RESPONSES]: "OpenAI Responses",
    [ApiFormat.ANTHROPIC_CHAT]: "Anthropic Messages",
}

export interface DeepSeekProviderCardProps {
    readonly apiFormat: ApiFormat | undefined
    readonly apiKey: string
    readonly modelId: string
    /** Effective model metadata, using the same declaration as the real Provider. */
    readonly pricing: ModelPricing | undefined
    readonly atMs?: number
    readonly profileId: string
    readonly models: readonly string[]
    /** Whether thinking is enabled for this Profile. Defaults to on. */
    readonly enableThinking?: boolean
    /** Selected thinking level. Defaults to the standard level, `high`. */
    readonly effort?: DeepSeekEffort
    readonly onApiFormatChange: (apiFormat: ApiFormat) => void
    readonly onApiKeyChange: (apiKey: string) => void
    readonly onEffortChange: (effort: DeepSeekEffort) => void
    readonly onEnableThinkingChange: (enabled: boolean) => void
    readonly onModelChange: (modelId: string) => void
}

/**
 * DeepSeek Profile card.
 *
 * Shows the actual peak/off-peak windows for the seller's current day.
 */
export function DeepSeekProviderCard({
    apiFormat,
    apiKey,
    modelId,
    pricing,
    atMs,
    profileId,
    models,
    enableThinking = true,
    effort = DEEP_SEEK_DEFAULT_EFFORT,
    onApiFormatChange,
    onApiKeyChange,
    onEffortChange,
    onEnableThinkingChange,
    onModelChange,
}: DeepSeekProviderCardProps) {
    const { t } = useUiTranslation()
    const modelSelectId = useId()
    const formatId = useId()
    // Mirrors the checkbox the way `DeepSeekProvider` does: the stored value is
    // the source of truth, and the local copy keeps the box responsive while the
    // Profile round-trips through the extension host.
    const [thinkingChecked, setThinkingChecked] = useState(enableThinking)

    return (
        <div className="flex w-full min-w-0 flex-col gap-3">
            <ApiKeyField
                initialValue={apiKey}
                onChange={onApiKeyChange}
                providerName="DeepSeek"
                signupUrl="https://platform.deepseek.com/api_keys"
            />

            <ProfileField htmlFor={modelSelectId} label={t("settings.ui.model")}>
                <DropdownContainer className="dropdown-container min-w-0">
                    <VSCodeDropdown
                        aria-label={t("settings.ui.model")}
                        className="min-h-7 w-full"
                        id={modelSelectId}
                        onChange={dropdownChangeHandler(onModelChange)}
                        value={modelId}>
                        {models.map((candidate) => (
                            <VSCodeOption key={candidate} value={candidate}>
                                {candidate}
                            </VSCodeOption>
                        ))}
                    </VSCodeDropdown>
                </DropdownContainer>
            </ProfileField>

            <ProfileField
                description={t("settings.ui.deepseek.protocolHelp")}
                htmlFor={formatId}
                label={t("settings.ui.apiFormat")}>
                <DropdownContainer className="dropdown-container min-w-0">
                    <VSCodeDropdown
                        aria-label={t("settings.ui.apiFormat")}
                        className="min-h-7 w-full"
                        id={formatId}
                        onChange={dropdownChangeHandler((value) => onApiFormatChange(Number(value) as ApiFormat))}
                        value={String(formatForSelection(apiFormat))}>
                        {DEEP_SEEK_API_FORMATS.map((candidate) => (
                            <VSCodeOption key={candidate} value={String(candidate)}>
                                {DEEP_SEEK_API_FORMAT_LABELS[candidate]}
                            </VSCodeOption>
                        ))}
                    </VSCodeDropdown>
                </DropdownContainer>
            </ProfileField>

            {/*
                Same shape as `DeepSeekProvider`: an `Enable Thinking` checkbox and,
                once checked, a `Thinking Level` selector. The Profile can be edited
                from either surface, so inventing a different control here would
                describe one stored setting two ways.
            */}
            <div className="flex flex-col gap-1">
                <VSCodeCheckbox
                    checked={thinkingChecked}
                    onChange={(event) => {
                        const target = event.target as (EventTarget & { checked?: boolean }) | null
                        const checked = target?.checked === true
                        setThinkingChecked(checked)
                        onEnableThinkingChange(checked)
                    }}>
                    {t("settings.ui.enableThinking")}
                </VSCodeCheckbox>
                {thinkingChecked && (
                    <ReasoningEffortSelector
                        allowedEfforts={DEEP_SEEK_EFFORT_LEVELS}
                        defaultEffort={DEEP_SEEK_DEFAULT_EFFORT}
                        description={t("settings.ui.deepseekThinkingHelp")}
                        label={t("settings.ui.thinkingLevel")}
                        onReasoningEffortChange={(value) => onEffortChange(value as DeepSeekEffort)}
                        reasoningEffort={effort}
                    />
                )}
            </div>

            <ProviderUsage enabled pollIntervalMs={null} profileId={profileId} />

            <PricingEditor atMs={atMs} peakOffPeakLabels={true} pricing={pricing} readOnly={true} showCachePrices />
        </div>
    )
}

function formatForSelection(apiFormat: ApiFormat | undefined): ApiFormat {
    return apiFormat !== undefined && DEEP_SEEK_API_FORMATS.includes(apiFormat) ? apiFormat : DEEP_SEEK_API_FORMATS[0]
}

/**
 * Adapt a selected-value handler to `VSCodeDropdown`.
 *
 * The toolkit types `onChange` as both a native `Event` handler and a React form
 * handler and renders a custom element whose value-bearing input is not part of
 * its public contract, so the value is read structurally from either shape.
 */
function dropdownChangeHandler(onValue: (value: string) => void): (event: Event | React.FormEvent<HTMLElement>) => void {
    return (event) => {
        const value = (event.target as { value?: unknown } | null)?.value
        if (typeof value === "string") onValue(value)
    }
}
