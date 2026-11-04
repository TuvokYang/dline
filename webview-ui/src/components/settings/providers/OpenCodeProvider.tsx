import type { ModelInfo } from "@shared/proto/dline/models"
import { type ModelCapabilities } from "@shared/proto/dline/models/metadata"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { OpenCodeMode, OpenCodeProviderConfig } from "@shared/proto/dline/provider/opencode"
import { buildEffectiveModelInfo } from "@shared/providers/effective-model-info"
import { resolveOpenCodeReasoningConfig } from "@shared/providers/opencode-reasoning"
import { resolveProfileModelId } from "@shared/providers/profile-model-info"
import { OPENCODE_CONSOLE_CATALOG, OPENCODE_GO_CATALOG } from "@shared/providers/provider-catalog-key"
import { readProviderConfigField, withProviderConfigField } from "@shared/providers/provider-config"
import { useMemo } from "react"
import { ModelConfiguration } from "../common/ModelConfiguration"
import { ModelInfoView } from "../common/ModelInfoView"
import { type OpenCodePlan, OpenCodeProviderCard, resolveOpenCodeApiFormat } from "./OpenCodeProviderCard"
import type { ApiProfile } from "./ProviderProfile"
import { usePendingProviderConfig } from "./usePendingProviderConfig"
import { useProviderModelOptions } from "./useProviderModelOptions"
import { useProviderModels } from "./useProviderModels"

interface OpenCodeProviderProps {
    showModelOptions: boolean
    isPopup?: boolean
    profile: ApiProfile
    onUpdate: (updates: Partial<ApiProfile>) => void
}

/**
 * The proto mode each plan stores, and the reverse lookup the editor reads.
 *
 * The picker's own value type is the plan name while storage keeps the proto
 * enum, so one table owns the correspondence and a new plan cannot be added to
 * the card and forgotten here.
 */
const PLAN_MODES: Readonly<Record<OpenCodePlan, OpenCodeMode>> = {
    balance: OpenCodeMode.OPEN_CODE_MODE_CONSOLE,
    go: OpenCodeMode.OPEN_CODE_MODE_GO,
    "go-plus": OpenCodeMode.OPEN_CODE_MODE_GO_PLUS,
    "go-teams": OpenCodeMode.OPEN_CODE_MODE_GO_TEAMS,
}

const MODE_PLANS: Readonly<Record<number, OpenCodePlan>> = Object.fromEntries(
    Object.entries(PLAN_MODES).map(([plan, mode]) => [mode, plan as OpenCodePlan]),
)

/**
 * Every plan reads one of two catalogs.
 *
 * A subscription plan keeps the same model list as Go; only the monthly
 * allowance differs, which is a usage question rather than a catalog one.
 */
function catalogKeyForPlan(plan: OpenCodePlan): string {
    return plan === "balance" ? OPENCODE_CONSOLE_CATALOG : OPENCODE_GO_CATALOG
}

/** Read the stored plan, treating an unset or unknown mode as pay-as-you-go. */
function planOf(config: OpenCodeProviderConfig | undefined): OpenCodePlan {
    return MODE_PLANS[config?.mode ?? OpenCodeMode.OPEN_CODE_MODE_UNSPECIFIED] ?? "balance"
}

/**
 * The OpenCode provider editor.
 *
 * Two facts live here rather than on the shared profile: the plan, because it
 * decides which catalog and endpoint the Profile uses, and the protocol, because
 * the gateway serves three wire formats for the same model. Both are written into
 * the provider's nested config so the shipped `BaseProviderConfig` fields keep
 * their usual meaning.
 */
export const OpenCodeProvider = ({ showModelOptions, isPopup, profile, onUpdate }: OpenCodeProviderProps) => {
    const propConfig = useMemo<OpenCodeProviderConfig>(
        () => profile.opencode ?? OpenCodeProviderConfig.create({ mode: OpenCodeMode.OPEN_CODE_MODE_UNSPECIFIED }),
        [profile.opencode],
    )
    const { config, latest, publish } = usePendingProviderConfig(profile.id, propConfig)
    const plan = planOf(config)

    const writeConfig = (next: OpenCodeProviderConfig) => {
        publish(next)
        onUpdate({ opencode: next })
    }

    /** Store shared fields at their canonical flat address; legacy fields are read-only. */
    const writeBaseField = (field: "apiFormat" | "reasoning" | "capabilities", value: unknown) => {
        writeConfig(withProviderConfigField(latest(), field, value) as OpenCodeProviderConfig)
    }

    /**
     * Apply a context/output limit edit, treating an empty field as "follow the
     * model again".
     *
     * The shared configuration control reports a cleared number input as `0`, and
     * the effective-model merge keeps any override it is given — a stored `0`
     * would therefore pin the window at zero instead of restoring the vendor
     * value. Removing the key is what actually falls back.
     */
    const handleCapabilitiesUpdate = (updates: Partial<ModelCapabilities>) => {
        // Read the override from `latest()`, not from the render-time prop: two
        // limit fields commit on their own debounce timers, so the second commit
        // would otherwise rebuild from a config that predates the first edit and
        // silently restore it.
        const current = readProviderConfigField(latest(), "capabilities")
        const next: ModelCapabilities = { ...(isObject(current) ? (current as ModelCapabilities) : {}) }
        for (const [key, value] of Object.entries(updates)) {
            if ((key === "contextWindow" || key === "maxTokens") && !value) {
                delete (next as Record<string, unknown>)[key]
                continue
            }
            ;(next as Record<string, unknown>)[key] = value
        }
        writeBaseField("capabilities", next)
    }

    const {
        models: catalogModels,
        defaultModelId: catalogDefaultModelId,
        options: modelOptions,
        refreshRemoteModels,
    } = useProviderModelOptions({
        providerId: catalogKeyForPlan(plan),
        profileId: profile.id,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        selectedModelId: resolveProfileModelId(profile),
    })

    // Both catalogs are read so switching the plan can tell whether the current
    // selection survives. The other catalog is already in the shared cache, so
    // this costs no extra request.
    const otherCatalog = useProviderModels(catalogKeyForPlan(plan === "balance" ? "go" : "balance"))

    const modelId = resolveProfileModelId(profile, { defaultModelId: catalogDefaultModelId })
    /**
     * The metadata the limit fields fall back to.
     *
     * `options` merges the registry catalog with what the vendor listing just
     * returned, while `catalogModels` is only the registry's copy. Reading the
     * registry alone left every limit "unknown" until a catalog had been
     * persisted, even though discovery had already parsed the real values out of
     * the listing.
     */
    const catalogModel: ModelInfo | undefined = modelOptions[modelId] ?? catalogModels[modelId]
    // The user-edited limits only. `defaults` below carries the catalog value, so
    // handing the whole effective capability set here would freeze the vendor's
    // numbers as an override the moment the panel opened.
    const storedCapabilities = readProviderConfigField(config, "capabilities")
    const capabilityOverride = isObject(storedCapabilities) ? (storedCapabilities as ModelCapabilities) : undefined
    // Profile overrides are read through the shared accessor so a nested config
    // contributes the same capabilities and protocol a flat one would.
    const modelInfo = useMemo<ModelInfo>(() => {
        const base = catalogModel ?? (profile.modelInfo?.id === modelId ? profile.modelInfo : { id: modelId })
        const capabilityOverride = readProviderConfigField(config, "capabilities")
        const pricingOverride = readProviderConfigField(config, "pricing")
        return buildEffectiveModelInfo(modelId || base.id, base, {
            ...(isObject(capabilityOverride) ? { capabilities: capabilityOverride as ModelCapabilities } : {}),
            ...(isObject(pricingOverride) ? { pricing: pricingOverride as ModelInfo["pricing"] } : {}),
        })
    }, [catalogModel, config, modelId, profile.modelInfo])

    // The derived protocol is the default, not a whitelist: the picker always
    // offers every protocol this handler carries, so a stored choice is shown
    // as chosen even when it differs from what the catalog derived for the
    // model. `resolveApiFormat` would drop it, because it treats the derivation
    // as the only legal set.
    const declaredFormats = modelInfo.apiFormats ?? []
    const storedFormat = readProviderConfigField(config, "apiFormat")
    const apiFormat = resolveOpenCodeApiFormat(storedFormat, declaredFormats)
    const storedReasoning = readProviderConfigField(config, "reasoning") as ReasoningConfig | undefined
    const reasoning = resolveOpenCodeReasoningConfig(modelInfo.capabilities, storedReasoning)

    const changePlan = (next: OpenCodePlan) => {
        const nextConfig: OpenCodeProviderConfig = { ...latest(), mode: PLAN_MODES[next] }
        if (next === plan) {
            publish(nextConfig)
            onUpdate({ opencode: nextConfig })
            return
        }
        // A Plan change may leave the selection outside the new catalog, which the
        // gateway answers with 404. The fallback is the catalog the new plan reads,
        // never the one being left, and never an empty id: a Profile without a
        // selection cannot start a request at all.
        const fallbackId = otherCatalog.models[modelId] ? modelId : otherCatalog.defaultModelId
        publish(nextConfig)
        onUpdate({
            opencode: nextConfig,
            modelId: fallbackId,
            modelInfo: otherCatalog.models[fallbackId],
        })
    }

    return (
        <div>
            <OpenCodeProviderCard
                apiFormat={apiFormat}
                apiKey={profile.apiKey}
                capabilities={modelInfo.capabilities}
                effort={reasoning?.effort}
                enableThinking={reasoning?.enableThinking}
                modelId={modelId}
                models={Object.keys(modelOptions)}
                // `declaredFormats` leads with the default this build prefers, not
                // with what the vendor publishes, so it cannot stand in for the
                // native protocol. Only a single-format model proves one.
                nativeApiFormat={declaredFormats.length === 1 ? declaredFormats[0] : undefined}
                onApiFormatChange={(next) => writeBaseField("apiFormat", next)}
                onApiKeyChange={(value) => onUpdate({ apiKey: value })}
                onEffortChange={(effort) => writeBaseField("reasoning", { ...reasoning, enableThinking: true, effort })}
                onEnableThinkingChange={(enabled) =>
                    writeBaseField("reasoning", {
                        ...reasoning,
                        enableThinking: enabled,
                        ...(enabled ? {} : { thinkingBudget: 0 }),
                    })
                }
                onModelChange={(nextModelId) =>
                    onUpdate({
                        modelId: nextModelId,
                        ...(catalogModels[nextModelId] ? { modelInfo: catalogModels[nextModelId] } : {}),
                    })
                }
                onPlanChange={changePlan}
                onRefreshModels={refreshRemoteModels}
                onThinkingBudgetChange={(budget) =>
                    writeBaseField("reasoning", { ...reasoning, enableThinking: budget > 0, thinkingBudget: budget })
                }
                plan={plan}
                profileId={profile.id}
                thinkingBudget={reasoning?.thinkingBudget}
            />

            {showModelOptions ? (
                <>
                    {/*
                        Context and output limits are editable so a Profile can lower
                        the window it is billed and compacted against. `defaults` carries
                        the catalog value and `capabilities` only the user's override, so
                        an untouched field keeps following the vendor listing.
                    */}
                    <ModelConfiguration
                        capabilities={capabilityOverride}
                        defaults={catalogModel}
                        fields={{ capabilities: ["contextWindow", "maxTokens"] }}
                        onCapabilitiesUpdate={handleCapabilitiesUpdate}
                        onPricingUpdate={handlePricingUpdate}
                    />
                    <ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
                </>
            ) : null}
        </div>
    )
}

/** Pricing is owned by the plan, so an edit here keeps the stored value as-is. */
function handlePricingUpdate() {}

/** Whether a stored value is a plain object, so an override can be handed to the model builder. */
function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}
