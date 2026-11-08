import { ApiFormat, type ModelCapabilities } from "@shared/proto/dline/models/metadata"
import { openCodeThinkingBudgetOptions, resolveOpenCodeThinkingBudget } from "@shared/providers/opencode-reasoning"
import { VSCodeCheckbox, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useId, useState } from "react"
import { LocalizedDropdown, LocalizedOption } from "@/components/common/LocalizedDropdown"
import type { UiTranslator } from "@/i18n/messages"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ApiKeyField } from "../common/ApiKeyField"
import { DropdownContainer } from "../common/ModelSelector"
import { ProfileField } from "../profile-ui"
import ReasoningEffortSelector from "../ReasoningEffortSelector"
import { ProviderUsage } from "./ProviderUsage"

/**
 * Subscription a Profile is billed against.
 *
 * The gateway's responses report `opencode.billing_source`, but that value
 * cannot tell a Go Plus account from a Go Teams one: both are billed as a Go
 * plan, and only the per-model monthly limit differs. The plan is therefore a
 * declared fact rather than something derived from a response, because the
 * usage card needs the limit to turn a reported dollar amount into a
 * percentage.
 */
export type OpenCodePlan = "balance" | "go" | "go-plus" | "go-teams"

export interface OpenCodePlanOption {
    readonly value: OpenCodePlan
    readonly label: string
    /** What the plan changes for the user, shown under the picker. */
    readonly description: string
}

export const openCodePlanOptions = (t: UiTranslator): readonly OpenCodePlanOption[] => [
    {
        value: "balance",
        label: t("settings.ui.opencode.balance"),
        description: t("settings.ui.opencode.balanceHelp"),
    },
    {
        value: "go",
        label: "OpenCode Go",
        description: t("settings.ui.opencode.goHelp"),
    },
    {
        value: "go-plus",
        label: "OpenCode Go Plus",
        description: t("settings.ui.opencode.plusHelp"),
    },
    {
        value: "go-teams",
        label: "OpenCode Go Teams",
        description: t("settings.ui.opencode.teamsHelp"),
    },
]

/**
 * The three protocols the gateway serves.
 *
 * Gemini is served by the same gateway, but through a fourth wire protocol that
 * is a separate implementation rather than a value of this picker.
 */
export const OPEN_CODE_API_FORMATS: readonly ApiFormat[] = [
    ApiFormat.OPENAI_RESPONSES,
    ApiFormat.OPENAI_CHAT,
    ApiFormat.ANTHROPIC_CHAT,
]

/**
 * Resolve the protocol the picker shows.
 *
 * A stored choice wins: the derived list only supplies the default, because the
 * gateway translates a model between the protocols of its family. Passing the
 * derived list to `resolveApiFormat` instead would silently replace a deliberate
 * choice whenever it differs from the derivation.
 */
export function resolveOpenCodeApiFormat(stored: unknown, derived: readonly ApiFormat[] | undefined): ApiFormat {
    const selected = typeof stored === "number" ? (stored as ApiFormat) : undefined
    if (selected !== undefined && OPEN_CODE_API_FORMATS.includes(selected)) {
        return selected
    }
    // Responses is the gateway's native OpenAI protocol, so a Profile with no
    // stored choice starts there instead of on Chat Completions.
    return derived?.[0] ?? ApiFormat.OPENAI_RESPONSES
}

const OPEN_CODE_API_FORMAT_LABELS: Readonly<Record<number, string>> = {
    [ApiFormat.OPENAI_CHAT]: "OpenAI Chat Completions",
    [ApiFormat.OPENAI_RESPONSES]: "OpenAI Responses",
    [ApiFormat.ANTHROPIC_CHAT]: "Anthropic Messages",
}

export interface OpenCodeProviderCardProps {
    readonly apiFormat: ApiFormat | undefined
    readonly apiKey: string
    readonly modelId: string
    readonly plan: OpenCodePlan
    /** Native protocol the selected model publishes, when the catalog declares one. */
    readonly nativeApiFormat?: ApiFormat
    /**
     * Capabilities of the selected model, straight from the catalog.
     *
     * The gateway resells models with different reasoning shapes, so the
     * thinking control cannot be a fixed widget: some models take graded effort,
     * some take a token budget, and some take neither. This card only renders
     * what the selected model declares.
     */
    readonly capabilities?: ModelCapabilities
    /** Whether thinking is enabled for this Profile. */
    readonly enableThinking?: boolean
    /** Selected effort, when the model declares effort levels. */
    readonly effort?: string
    /** Selected thinking budget, when the model declares a budget. */
    readonly thinkingBudget?: number
    readonly profileId: string
    readonly models: readonly string[]
    readonly onApiFormatChange: (apiFormat: ApiFormat) => void
    readonly onApiKeyChange: (apiKey: string) => void
    readonly onEffortChange?: (effort: string) => void
    readonly onEnableThinkingChange?: (enabled: boolean) => void
    readonly onModelChange: (modelId: string) => void
    readonly onPlanChange: (plan: OpenCodePlan) => void
    readonly onThinkingBudgetChange?: (budget: number) => void
    /** Asks the provider listing for model ids the local catalog does not know yet. */
    readonly onRefreshModels?: () => void
}

/**
 * OpenCode Profile card.
 *
 * The base URL is deliberately absent: it is fully determined by the Plan
 * picker, and showing an editable URL next to a picker that also controls it
 * invites the two to disagree.
 */
export function OpenCodeProviderCard({
    apiFormat,
    apiKey,
    modelId,
    plan,
    nativeApiFormat,
    capabilities,
    enableThinking = false,
    effort,
    thinkingBudget,
    profileId,
    models,
    onApiFormatChange,
    onApiKeyChange,
    onEffortChange,
    onEnableThinkingChange,
    onModelChange,
    onPlanChange,
    onThinkingBudgetChange,
    onRefreshModels,
}: OpenCodeProviderCardProps) {
    const { t } = useUiTranslation()
    const planOptions = openCodePlanOptions(t)
    const planId = useId()
    const modelSelectId = useId()
    const formatId = useId()
    const budgetId = useId()
    const [thinkingChecked, setThinkingChecked] = useState(enableThinking)
    // The declaration a model carries can change while this card stays mounted:
    // opening the model list persists the vendor listing, and its published
    // capabilities replace the seed the card first rendered. The checkbox is
    // driven by that declaration, so it has to follow the prop instead of
    // freezing the value it saw at mount.
    useEffect(() => {
        setThinkingChecked(enableThinking)
    }, [enableThinking])
    const selectedPlan = planOptions.find((option) => option.value === plan) ?? planOptions[0]
    const selectedFormat = formatForSelection(apiFormat)
    const thinking = resolveThinking(capabilities)

    return (
        <div className="flex w-full min-w-0 flex-col gap-3">
            <ProfileField description={selectedPlan.description} htmlFor={planId} label={t("settings.ui.opencode.plan")}>
                <DropdownContainer className="dropdown-container min-w-0">
                    <LocalizedDropdown
                        aria-label={t("settings.ui.opencode.plan")}
                        className="min-h-7 w-full"
                        id={planId}
                        onChange={dropdownChangeHandler((value) => onPlanChange(value as OpenCodePlan))}
                        selectedLabel={planOptions.find((option) => option.value === plan)?.label}
                        value={plan}>
                        {planOptions.map((option) => (
                            <LocalizedOption key={option.value} label={option.label} value={option.value} />
                        ))}
                    </LocalizedDropdown>
                </DropdownContainer>
            </ProfileField>

            <ApiKeyField initialValue={apiKey} onChange={onApiKeyChange} providerName="OpenCode" />

            <ProfileField
                description={onRefreshModels ? t("settings.ui.opencode.modelsHelp") : undefined}
                htmlFor={modelSelectId}
                label={t("settings.ui.model")}>
                <DropdownContainer className="dropdown-container min-w-0">
                    <VSCodeDropdown
                        aria-label={t("settings.ui.model")}
                        className="min-h-7 w-full"
                        id={modelSelectId}
                        onChange={dropdownChangeHandler(onModelChange)}
                        // Focus is the trigger, matching the other listing providers:
                        // the user is about to pick a model, so this is the moment the
                        // list should reflect the gateway rather than the build.
                        onFocus={onRefreshModels}
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
                description={
                    nativeApiFormat !== undefined && nativeApiFormat !== apiFormat
                        ? t("settings.ui.opencode.protocolHelp", { model: modelId, format: formatLabel(nativeApiFormat, t) })
                        : undefined
                }
                htmlFor={formatId}
                label={t("settings.ui.apiFormat")}>
                {/* One step below the Model list so an open picker above it is
                    not painted over by this control. */}
                <DropdownContainer className="dropdown-container min-w-0" zIndex={999}>
                    <VSCodeDropdown
                        aria-label={t("settings.ui.apiFormat")}
                        className="min-h-7 w-full"
                        id={formatId}
                        onChange={dropdownChangeHandler((value) => onApiFormatChange(Number(value) as ApiFormat))}
                        value={String(selectedFormat)}>
                        {OPEN_CODE_API_FORMATS.map((candidate) => (
                            <VSCodeOption key={candidate} value={String(candidate)}>
                                {formatLabel(candidate, t)}
                            </VSCodeOption>
                        ))}
                    </VSCodeDropdown>
                </DropdownContainer>
            </ProfileField>

            {/*
                The thinking control is driven by the selected model's own
                declaration, not by a fixed widget: effort levels, a token
                budget, or nothing at all. A model that declares no reasoning
                renders no control, because offering one would let the Profile
                store a preference the gateway cannot honour.
            */}
            {thinking !== undefined && (
                <div className="flex flex-col gap-1">
                    <VSCodeCheckbox
                        checked={thinkingChecked}
                        disabled={thinking.canDisable === false}
                        onChange={(event) => {
                            const target = event.target as (EventTarget & { checked?: boolean }) | null
                            const checked = target?.checked === true
                            if (!checked && thinking.canDisable === false) return
                            setThinkingChecked(checked)
                            onEnableThinkingChange?.(checked)
                        }}>
                        {t("settings.ui.enableThinking")}
                    </VSCodeCheckbox>
                    {thinkingChecked && thinking.mode === "effort" && (
                        <ReasoningEffortSelector
                            allowedEfforts={thinking.effortLevels ?? []}
                            defaultEffort={thinking.defaultEffort}
                            description={t("settings.ui.opencode.effortHelp")}
                            label={t("settings.ui.thinkingLevel")}
                            onReasoningEffortChange={(value) => onEffortChange?.(value)}
                            reasoningEffort={effort}
                        />
                    )}
                    {thinkingChecked && thinking.mode === "budget" && (
                        <ProfileField
                            description={t("settings.ui.opencode.budgetHelp")}
                            htmlFor={budgetId}
                            label={t("settings.ui.thinkingBudget")}>
                            <LocalizedDropdown
                                aria-label={t("settings.ui.thinkingBudget")}
                                className="min-h-7 w-full"
                                id={budgetId}
                                onChange={dropdownChangeHandler((value) => onThinkingBudgetChange?.(Number(value)))}
                                selectedLabel={t("settings.ui.tokens", {
                                    count: resolveOpenCodeThinkingBudget(thinking, thinkingBudget).toLocaleString(),
                                })}
                                value={String(resolveOpenCodeThinkingBudget(thinking, thinkingBudget))}>
                                {openCodeThinkingBudgetOptions(thinking, thinkingBudget).map((option) => (
                                    <LocalizedOption
                                        key={option}
                                        label={t("settings.ui.tokens", { count: option.toLocaleString() })}
                                        value={String(option)}
                                    />
                                ))}
                            </LocalizedDropdown>
                        </ProfileField>
                    )}
                </div>
            )}

            {plan !== "balance" && <ProviderUsage enabled profileId={profileId} />}
        </div>
    )
}

/**
 * The reasoning shape this model declares, or `undefined` when it declares none.
 *
 * `supportsReasoning === false` vetoes a stale nested declaration, the same rule
 * `ModelInfoView` applies, so a catalog entry that once had thinking enabled and
 * later disabled it does not keep offering the control.
 */
function resolveThinking(capabilities: ModelCapabilities | undefined): ModelCapabilities["thinking"] | undefined {
    const thinking = capabilities?.thinking
    if (thinking?.supported !== true) return undefined
    if (capabilities?.supportsReasoning === false) return undefined
    if (thinking.mode !== "effort" && thinking.mode !== "budget") return undefined
    return thinking
}

/**
 * Resolve the protocol this card should show as selected.
 *
 * A Profile that has never chosen a format, or that carries one of the values
 * this gateway does not serve, still has to render a valid selection rather
 * than an empty dropdown.
 */
function formatForSelection(apiFormat: ApiFormat | undefined): ApiFormat {
    return apiFormat !== undefined && OPEN_CODE_API_FORMATS.includes(apiFormat) ? apiFormat : OPEN_CODE_API_FORMATS[0]
}

/**
 * Adapt a selected-value handler to `VSCodeDropdown`.
 *
 * The toolkit component types `onChange` as both a native `Event` handler and a
 * React form handler, and it renders a custom element whose value-bearing input
 * is not part of its public contract. The event is therefore accepted as either
 * shape and its value read structurally, so this adapter never asserts one
 * concrete element class.
 */
function dropdownChangeHandler(onValue: (value: string) => void): (event: Event | React.FormEvent<HTMLElement>) => void {
    return (event) => {
        const value = (event.target as { value?: unknown } | null)?.value
        if (typeof value === "string") onValue(value)
    }
}

function formatLabel(apiFormat: ApiFormat, t: UiTranslator): string {
    return OPEN_CODE_API_FORMAT_LABELS[apiFormat] ?? t("settings.ui.unknownFormat")
}
