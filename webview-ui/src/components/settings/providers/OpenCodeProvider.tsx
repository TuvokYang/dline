import type { ModelInfo } from "@shared/proto/dline/models"
import { type ModelCapabilities } from "@shared/proto/dline/models/metadata"
import { OpenCodeMode, type OpenCodeProviderConfig } from "@shared/proto/dline/provider/opencode"
import { buildEffectiveModelInfo } from "@shared/providers/effective-model-info"
import { resolveProfileModelId } from "@shared/providers/profile-model-info"
import { OPENCODE_CONSOLE_CATALOG, OPENCODE_GO_CATALOG } from "@shared/providers/provider-catalog-key"
import { readProviderConfigField, withProviderConfigField } from "@shared/providers/provider-config"
import { resolveTaskThinkingConfig } from "@shared/task-reasoning"
import { useMemo } from "react"
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
        () => profile.opencode ?? { mode: OpenCodeMode.OPEN_CODE_MODE_UNSPECIFIED, model: undefined },
        [profile.opencode],
    )
    const { config, latest, publish } = usePendingProviderConfig(profile.id, propConfig)
    const plan = planOf(config)

    const writeConfig = (next: OpenCodeProviderConfig) => {
        publish(next)
        onUpdate({ opencode: next })
    }

    /** Store a shared base field inside whichever shape this config already uses. */
    const writeBaseField = (field: "apiFormat" | "reasoning", value: unknown) => {
        writeConfig(withProviderConfigField(latest(), field, value) as OpenCodeProviderConfig)
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
    const catalogModel: ModelInfo | undefined = catalogModels[modelId]
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
    const thinking = resolveTaskThinkingConfig(modelInfo.capabilities)
    const reasoning = readProviderConfigField(config, "reasoning") as
        | { enableThinking?: boolean; effort?: string; thinkingBudget?: number }
        | undefined

    const changePlan = (next: OpenCodePlan) => {
        const nextConfig: OpenCodeProviderConfig = { ...latest(), mode: PLAN_MODES[next] }
        // A Plan change may leave the selection outside the new catalog, which the
        // gateway answers with 404. Whether the id survives is decided against the
        // catalog the new plan reads, never against the one being left.
        const survives = next === plan || modelId === "" || otherCatalog.models[modelId] !== undefined
        publish(nextConfig)
        onUpdate({
            opencode: nextConfig,
            ...(survives ? {} : { modelId: "", modelInfo: undefined }),
        })
    }

    return (
        <div>
            <OpenCodeProviderCard
                apiFormat={apiFormat}
                apiKey={profile.apiKey}
                capabilities={modelInfo.capabilities}
                effort={reasoning?.effort}
                enableThinking={reasoning?.enableThinking ?? thinking?.defaultEnabled === true}
                modelId={modelId}
                models={Object.keys(modelOptions)}
                nativeApiFormat={declaredFormats[0]}
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

            {showModelOptions ? <ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} /> : null}
        </div>
    )
}

/** Whether a stored value is a plain object, so an override can be handed to the model builder. */
function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}
