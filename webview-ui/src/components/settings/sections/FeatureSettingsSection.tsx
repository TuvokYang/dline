import {
    MAX_PARALLEL_SUBAGENTS,
    MAX_PARALLEL_TOOL_CALLS,
    MIN_PARALLEL_EXECUTIONS,
    resolveMaxParallelSubagents,
    resolveMaxParallelToolCalls,
} from "@shared/concurrency-limits"
import type { UpdateSettingsRequest } from "@shared/proto/dline/state"
import { memo, type ReactNode, useCallback } from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import type { UiTranslator } from "@/i18n/messages"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import AutoCondenseSettings from "../AutoCondenseSettings"
import AwayModeSettings from "../AwayModeSettings"
import Section from "../Section"
import SettingsSlider from "../SettingsSlider"
import { updateSetting } from "../utils/settingsHandlers"
import WebToolsSettings from "./WebToolsSettings"

// Reusable checkbox component for feature settings
interface FeatureCheckboxProps {
    checked: boolean | undefined
    onChange: (checked: boolean) => void
    label: string
    description: ReactNode
    disabled?: boolean
    isRemoteLocked?: boolean
    remoteTooltip?: string
    isVisible?: boolean
}

type FeatureSettingKey = Exclude<keyof UpdateSettingsRequest, "metadata">
type McpDisplayModeValue = "rich" | "plain" | "markdown"

function isMcpDisplayModeValue(value: string): value is McpDisplayModeValue {
    return value === "rich" || value === "plain" || value === "markdown"
}

// Interface for feature toggle configuration
interface FeatureToggle {
    id: string
    label: string
    description: ReactNode
    settingKey: FeatureSettingKey
    stateKey: string
    /** If set, the setting value is nested with this key (e.g., "enabled" -> { enabled: checked }) */
    nestedKey?: string
}

const agentFeatures = (t: UiTranslator): FeatureToggle[] => [
    {
        id: "subagents",
        label: t("settings.ui.features.subagents"),
        description: t("settings.ui.features.subagentsHelp"),
        stateKey: "subagentsEnabled",
        settingKey: "subagentsEnabled",
    },
    {
        id: "enable-mcp",
        label: t("settings.ui.features.mcp"),
        description: t("settings.ui.features.mcpHelp"),
        stateKey: "mcpEnabled",
        settingKey: "mcpEnabled",
    },
    {
        id: "mcp-tools-on-demand",
        label: t("settings.ui.features.mcpOnDemand"),
        description: t("settings.ui.features.mcpOnDemandHelp"),
        stateKey: "mcpToolsOnDemandEnabled",
        settingKey: "mcpToolsOnDemandEnabled",
    },
    {
        id: "native-tool-call",
        label: t("settings.ui.features.native"),
        description: t("settings.ui.features.nativeHelp"),
        stateKey: "nativeToolCallSetting",
        settingKey: "nativeToolCallEnabled",
    },
    {
        id: "parallel-tool-calling",
        label: t("settings.ui.features.parallel"),
        description: t("settings.ui.features.parallelHelp"),
        stateKey: "enableParallelToolCalling",
        settingKey: "enableParallelToolCalling",
    },
    {
        id: "active-tasks-env-details",
        label: t("settings.ui.features.active"),
        description: t("settings.ui.features.activeHelp"),
        stateKey: "showActiveTasksInEnvDetails",
        settingKey: "showActiveTasksInEnvDetails",
    },
    {
        id: "strict-plan-mode",
        label: t("settings.ui.features.strictPlan"),
        description: t("settings.ui.features.strictPlanHelp"),
        stateKey: "strictPlanModeEnabled",
        settingKey: "strictPlanModeEnabled",
    },
    {
        id: "auto-compact",
        label: t("settings.ui.features.compact"),
        description: t("settings.ui.features.compactHelp"),
        stateKey: "useAutoCondense",
        settingKey: "useAutoCondense",
    },
    {
        id: "focus-chain",
        label: t("settings.ui.features.focus"),
        description: t("settings.ui.features.focusHelp"),
        stateKey: "focusChainEnabled",
        settingKey: "focusChainSettings",
        nestedKey: "enabled",
    },
    {
        id: "image-generation",
        label: t("settings.ui.features.images"),
        description: t("settings.ui.features.imagesHelp"),
        stateKey: "imageGenerationEnabled",
        settingKey: "imageGenerationEnabled",
    },
    {
        id: "web-tools",
        label: t("settings.ui.features.web"),
        description: t("settings.ui.features.webHelp"),
        stateKey: "clineWebToolsEnabled",
        settingKey: "clineWebToolsEnabled",
    },
]

const editorFeatures = (t: UiTranslator): FeatureToggle[] => [
    {
        id: "show-feature-tips",
        label: t("settings.ui.features.tips"),
        description: t("settings.ui.features.tipsHelp"),
        stateKey: "showFeatureTips",
        settingKey: "showFeatureTips",
    },
    {
        id: "background-edit",
        label: t("settings.ui.features.background"),
        description: t("settings.ui.features.backgroundHelp"),
        stateKey: "backgroundEditEnabled",
        settingKey: "backgroundEditEnabled",
    },
    {
        id: "checkpoints",
        label: t("settings.ui.features.checkpoints"),
        description: t("settings.ui.features.checkpointsHelp"),
        stateKey: "enableCheckpointsSetting",
        settingKey: "enableCheckpointsSetting",
    },
    {
        id: "worktrees",
        label: t("settings.ui.features.worktrees"),
        description: t("settings.ui.features.worktreesHelp"),
        stateKey: "worktreesEnabled",
        settingKey: "worktreesEnabled",
    },
]

const experimentalFeatures = (t: UiTranslator): FeatureToggle[] => [
    {
        id: "yolo",
        label: t("settings.ui.features.yolo"),
        description: t("settings.ui.features.yoloHelp"),
        stateKey: "yoloModeToggled",
        settingKey: "yoloModeToggled",
    },
    {
        id: "double-check-completion",
        label: t("settings.ui.features.doubleCheck"),
        description: t("settings.ui.features.doubleCheckHelp"),
        stateKey: "doubleCheckCompletionEnabled",
        settingKey: "doubleCheckCompletionEnabled",
    },
    {
        id: "lazy-teammate",
        label: t("settings.ui.features.lazy"),
        description: t("settings.ui.features.lazyHelp"),
        stateKey: "lazyTeammateModeEnabled",
        settingKey: "lazyTeammateModeEnabled",
    },
    {
        id: "account",
        label: t("settings.ui.features.account"),
        description: t("settings.ui.features.accountHelp"),
        stateKey: "accountEnabled",
        settingKey: "accountEnabled",
    },
    {
        id: "external-file-checkpoints",
        label: t("settings.ui.features.external"),
        description: t("settings.ui.features.externalHelp"),
        stateKey: "externalFileCheckpoints",
        settingKey: "externalFileCheckpointsEnabled",
    },
]

const advancedFeatures = (t: UiTranslator): FeatureToggle[] => [
    {
        id: "hooks",
        label: t("settings.ui.features.hooks"),
        description: t("settings.ui.features.hooksHelp"),
        stateKey: "hooksEnabled",
        settingKey: "hooksEnabled",
    },
]

const FeatureRow = memo(
    ({
        checked = false,
        onChange,
        label,
        description,
        disabled,
        isRemoteLocked,
        isVisible = true,
        remoteTooltip,
    }: FeatureCheckboxProps) => {
        if (!isVisible) {
            return null
        }

        const checkbox = (
            <div className="flex items-center justify-between w-full">
                <div>{label}</div>
                <div>
                    <Switch
                        aria-label={label}
                        checked={checked}
                        className="shrink-0"
                        disabled={disabled || isRemoteLocked}
                        id={label}
                        onCheckedChange={onChange}
                        size="lg"
                    />
                    {isRemoteLocked && <i className="codicon codicon-lock text-description text-sm" />}
                </div>
            </div>
        )

        return (
            <div className="flex flex-col items-start justify-between gap-4 py-3 w-full">
                <div className="space-y-0.5 flex-1 w-full">
                    {isRemoteLocked ? (
                        <Tooltip>
                            <TooltipTrigger asChild>{checkbox}</TooltipTrigger>
                            <TooltipContent className="max-w-xs" side="top">
                                {remoteTooltip}
                            </TooltipContent>
                        </Tooltip>
                    ) : (
                        checkbox
                    )}
                </div>
                <div className="text-xs text-description">{description}</div>
            </div>
        )
    },
)

interface FeatureSettingsSectionProps {
    renderSectionHeader: (tabId: string) => JSX.Element | null
}

const FeatureSettingsSection = ({ renderSectionHeader }: FeatureSettingsSectionProps) => {
    const { t } = useUiTranslation()
    const {
        enableCheckpointsSetting,
        hooksEnabled,
        mcpDisplayMode,
        strictPlanModeEnabled,
        yoloModeToggled,
        awayModeGateEnabled,
        awayModeEnabled,
        autoAwayModeEnabled,
        useAutoCondense,
        subagentsEnabled,
        mcpEnabled,
        mcpToolsOnDemandEnabled,
        imageGenerationEnabled,
        clineWebToolsEnabled,
        localWebSearchEngine,
        searxngSearchUrl,
        worktreesEnabled,
        accountEnabled,
        externalFileCheckpoints,
        focusChainSettings,
        remoteConfigSettings,
        nativeToolCallSetting,
        enableParallelToolCalling,
        maxParallelToolCalls,
        maxParallelSubagents,
        backgroundEditEnabled,
        doubleCheckCompletionEnabled,
        lazyTeammateModeEnabled,
        showFeatureTips,
        showActiveTasksInEnvDetails,
    } = useExtensionState()

    const handleFocusChainIntervalChange = useCallback(
        (value: number) => {
            updateSetting("focusChainSettings", { ...focusChainSettings, remindClineInterval: value })
        },
        [focusChainSettings],
    )

    const handleMaxParallelToolCallsChange = useCallback((value: number) => {
        updateSetting("maxParallelToolCalls", value)
    }, [])

    const handleMaxParallelSubagentsChange = useCallback((value: number) => {
        updateSetting("maxParallelSubagents", value)
    }, [])

    const handleMcpDisplayModeChange = useCallback((value: string) => {
        if (isMcpDisplayModeValue(value)) {
            updateSetting("mcpDisplayMode", value)
        }
    }, [])

    const isYoloRemoteLocked = remoteConfigSettings?.yoloModeToggled !== undefined

    // State lookup for mapped features
    const featureState: Record<string, boolean | undefined> = {
        showFeatureTips,
        showActiveTasksInEnvDetails,
        enableCheckpointsSetting,
        strictPlanModeEnabled,
        hooksEnabled,
        nativeToolCallSetting,
        focusChainEnabled: focusChainSettings?.enabled,
        useAutoCondense,
        subagentsEnabled,
        mcpEnabled,
        mcpToolsOnDemandEnabled,
        imageGenerationEnabled,
        clineWebToolsEnabled,
        worktreesEnabled: worktreesEnabled?.user,
        accountEnabled: accountEnabled?.user,
        externalFileCheckpoints: externalFileCheckpoints?.user,
        enableParallelToolCalling,
        backgroundEditEnabled,
        doubleCheckCompletionEnabled,
        lazyTeammateModeEnabled,
        yoloModeToggled: isYoloRemoteLocked ? remoteConfigSettings?.yoloModeToggled : yoloModeToggled,
    }

    // Visibility lookup for features with feature flags
    const featureVisibility: Record<string, boolean | undefined> = {
        worktreesEnabled: worktreesEnabled?.featureFlag,
        // Offered only while the rollout or a development build turns the feature on.
        accountEnabled: accountEnabled?.featureFlag === true,
        externalFileCheckpoints: externalFileCheckpoints?.featureFlag === true,
        // How MCP tools reach the model only matters while MCP itself is on.
        mcpToolsOnDemandEnabled: mcpEnabled !== false,
    }

    // Handler for feature toggle changes, supports nested settings like focusChainSettings
    const handleFeatureChange = useCallback(
        (feature: FeatureToggle, checked: boolean) => {
            if (feature.nestedKey) {
                // For nested settings, spread the existing value and set the nested key
                let currentValue = {}
                if (feature.settingKey === "focusChainSettings") {
                    currentValue = focusChainSettings ?? {}
                }
                updateSetting(feature.settingKey, { ...currentValue, [feature.nestedKey]: checked })
            } else {
                updateSetting(feature.settingKey, checked)
            }
        },
        [focusChainSettings],
    )

    return (
        <div className="mb-2">
            {renderSectionHeader("features")}
            <Section>
                <div className="mb-5 flex flex-col gap-3">
                    {/* Core features */}
                    <div>
                        <div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">
                            {t("settings.ui.features.agent")}
                        </div>
                        <div
                            className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
                            id="agent-features">
                            {agentFeatures(t).map((feature) => (
                                <div key={feature.id}>
                                    <FeatureRow
                                        checked={featureState[feature.stateKey]}
                                        description={feature.description}
                                        isVisible={featureVisibility[feature.stateKey] ?? true}
                                        key={feature.id}
                                        label={feature.label}
                                        onChange={(checked) =>
                                            feature.nestedKey === "enabled"
                                                ? handleFeatureChange(feature, checked)
                                                : updateSetting(feature.settingKey, checked)
                                        }
                                    />
                                    {feature.id === "subagents" && featureState[feature.stateKey] && (
                                        <SettingsSlider
                                            label={t("settings.ui.features.parallelSubagents", { max: MAX_PARALLEL_SUBAGENTS })}
                                            max={MAX_PARALLEL_SUBAGENTS}
                                            min={MIN_PARALLEL_EXECUTIONS}
                                            onChange={handleMaxParallelSubagentsChange}
                                            step={1}
                                            value={resolveMaxParallelSubagents(maxParallelSubagents)}
                                            valueWidth="w-6"
                                        />
                                    )}
                                    {feature.id === "parallel-tool-calling" && featureState[feature.stateKey] && (
                                        <SettingsSlider
                                            label={t("settings.ui.features.parallelTools", { max: MAX_PARALLEL_TOOL_CALLS })}
                                            max={MAX_PARALLEL_TOOL_CALLS}
                                            min={MIN_PARALLEL_EXECUTIONS}
                                            onChange={handleMaxParallelToolCallsChange}
                                            step={1}
                                            value={resolveMaxParallelToolCalls(maxParallelToolCalls, true)}
                                            valueWidth="w-6"
                                        />
                                    )}
                                    {feature.id === "focus-chain" && featureState[feature.stateKey] && (
                                        <SettingsSlider
                                            label={t("settings.ui.features.reminder")}
                                            max={10}
                                            min={1}
                                            onChange={handleFocusChainIntervalChange}
                                            step={1}
                                            value={focusChainSettings?.remindClineInterval || 6}
                                            valueWidth="w-6"
                                        />
                                    )}
                                    {feature.id === "auto-compact" && featureState[feature.stateKey] && <AutoCondenseSettings />}
                                    {feature.id === "web-tools" && (
                                        <WebToolsSettings
                                            localWebSearchEngine={localWebSearchEngine}
                                            searxngSearchUrl={searxngSearchUrl}
                                        />
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Editor features */}
                    <div>
                        <div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">
                            {t("settings.ui.features.editor")}
                        </div>
                        <div
                            className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
                            id="optional-features">
                            {editorFeatures(t).map((feature) => (
                                <FeatureRow
                                    checked={featureState[feature.stateKey]}
                                    description={feature.description}
                                    isVisible={featureVisibility[feature.stateKey] ?? true}
                                    key={feature.id}
                                    label={feature.label}
                                    onChange={(checked) => handleFeatureChange(feature, checked)}
                                />
                            ))}
                        </div>
                    </div>

                    {/* Experimental features */}
                    <div>
                        <div className="text-xs font-medium uppercase tracking-wider mb-3 text-warning/80">
                            {t("settings.ui.features.experimental")}
                        </div>
                        <div
                            className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50 w-full"
                            id="experimental-features">
                            <AwayModeSettings
                                automatic={autoAwayModeEnabled ?? false}
                                enabled={awayModeEnabled ?? false}
                                gateEnabled={awayModeGateEnabled ?? false}
                                onChange={updateSetting}
                            />
                            {experimentalFeatures(t).map((feature) => (
                                <FeatureRow
                                    checked={featureState[feature.stateKey]}
                                    description={feature.description}
                                    disabled={feature.id === "yolo" && isYoloRemoteLocked}
                                    isRemoteLocked={feature.id === "yolo" && isYoloRemoteLocked}
                                    isVisible={featureVisibility[feature.stateKey] ?? true}
                                    key={feature.id}
                                    label={feature.label}
                                    onChange={(checked) => handleFeatureChange(feature, checked)}
                                    remoteTooltip={t("settings.ui.managed")}
                                />
                            ))}
                        </div>
                    </div>
                </div>

                {/* Advanced */}
                <div>
                    <div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">
                        {t("settings.ui.features.advanced")}
                    </div>
                    <div className="relative p-3 my-3 rounded-md border border-editor-widget-border/50" id="advanced-features">
                        <div className="space-y-3">
                            {advancedFeatures(t).map((feature) => (
                                <FeatureRow
                                    checked={featureState[feature.stateKey]}
                                    description={feature.description}
                                    isVisible={featureVisibility[feature.stateKey] ?? true}
                                    key={feature.id}
                                    label={feature.label}
                                    onChange={(checked) => handleFeatureChange(feature, checked)}
                                />
                            ))}

                            {/* MCP Display Mode */}
                            <div className="space-y-2">
                                <Label className="text-sm font-medium text-foreground">
                                    {t("settings.ui.features.mcpDisplay")}
                                </Label>
                                <p className="text-xs text-muted-foreground">{t("settings.ui.features.mcpDisplayHelp")}</p>
                                <Select onValueChange={handleMcpDisplayModeChange} value={mcpDisplayMode}>
                                    <SelectTrigger className="w-full">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="plain">{t("settings.ui.features.plain")}</SelectItem>
                                        <SelectItem value="rich">{t("settings.ui.features.rich")}</SelectItem>
                                        <SelectItem value="markdown">Markdown</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                    </div>
                </div>
            </Section>
        </div>
    )
}
export default memo(FeatureSettingsSection)
