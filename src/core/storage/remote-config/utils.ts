import { synchronizeRemoteRuleToggles } from "@core/context/instructions/user-instructions/rule-helpers"
import { parseRemoteSkillEntries } from "@core/context/instructions/user-instructions/skills"
import type { RemoteConfig, S3AccessKeySettings } from "@shared/remote-config/schema"
import { ConfiguredAPIKeys, GlobalStateAndSettings, RemoteConfigFields } from "@shared/storage/state-keys"
import { AuthService } from "@/services/auth/AuthService"
import { getDistinctId } from "@/services/logging/distinctId"
import { type McpHub } from "@/services/mcp/McpHub"
import { ApiProvider } from "@/shared/api"
import { isOpenTelemetryConfigValid, remoteConfigToOtelConfig } from "@/shared/services/config/otel-config"
import { Logger } from "@/shared/services/Logger"
import { syncWorker } from "@/shared/services/worker/sync"
import { BlobStoreSettings } from "@/shared/storage"
import { ensureSettingsDirectoryExists } from "../disk"
import { StateManager } from "../StateManager"
import { remoteOtelProviderReconciler } from "./RemoteOtelProviderReconciler"
import { syncRemoteMcpServersToSettings } from "./syncRemoteMcpServers"

export { REMOTE_CONFIG_OTEL_PROVIDER_ID } from "./RemoteOtelProviderReconciler"

function accessSettingsToBlobStorage(type: BlobStoreSettings["adapterType"], settings: S3AccessKeySettings): BlobStoreSettings {
    return {
        adapterType: type,
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
        region: settings.region,
        bucket: settings.bucket,
        endpoint: settings.endpoint,
        accountId: settings.accountId,
        intervalMs: settings.intervalMs,
        maxRetries: settings.maxRetries,
        batchSize: settings.batchSize,
        maxQueueSize: settings.maxQueueSize,
        maxFailedAgeMs: settings.maxFailedAgeMs,
        backfillEnabled: settings.backfillEnabled,
    }
}

/**
 * Transforms RemoteConfig schema to RemoteConfigFields shape
 * @param remoteConfig The remote configuration object
 * @returns Partial<RemoteConfigFields> containing only the fields present in remote config
 */
export function transformRemoteConfigToStateShape(remoteConfig: RemoteConfig): Partial<RemoteConfigFields> {
    const transformed: Partial<RemoteConfigFields> = {}

    // Map top-level settings
    // Organization policy may tighten consent but cannot grant or reset it.
    // Omitting both fields for `true` preserves the user's existing choice.
    if (remoteConfig.telemetryEnabled === false) {
        transformed.usageReportingSetting = "disabled"
        transformed.errorReportingSetting = "disabled"
    }
    if (remoteConfig.mcpMarketplaceEnabled !== undefined) {
        transformed.mcpMarketplaceEnabled = remoteConfig.mcpMarketplaceEnabled
    }
    if (remoteConfig.allowedMCPServers !== undefined) {
        transformed.allowedMCPServers = remoteConfig.allowedMCPServers
    }
    if (remoteConfig.blockPersonalRemoteMCPServers !== undefined) {
        transformed.blockPersonalRemoteMCPServers = remoteConfig.blockPersonalRemoteMCPServers
    }
    if (remoteConfig.remoteMCPServers !== undefined) {
        transformed.remoteMCPServers = remoteConfig.remoteMCPServers
    }
    if (remoteConfig.yoloModeAllowed !== undefined) {
        // only set the yoloModeToggled field if yolo mode is not allowed. Otherwise, we let the user toggle it.
        if (remoteConfig.yoloModeAllowed === false) {
            transformed.yoloModeToggled = false
        }
    }

    // Map OpenTelemetry settings
    if (remoteConfig.openTelemetryEnabled !== undefined) {
        transformed.openTelemetryEnabled = remoteConfig.openTelemetryEnabled
    }
    if (remoteConfig.openTelemetryMetricsExporter !== undefined) {
        transformed.openTelemetryMetricsExporter = remoteConfig.openTelemetryMetricsExporter
    }
    if (remoteConfig.openTelemetryLogsExporter !== undefined) {
        transformed.openTelemetryLogsExporter = remoteConfig.openTelemetryLogsExporter
    }
    if (remoteConfig.openTelemetryOtlpProtocol !== undefined) {
        transformed.openTelemetryOtlpProtocol = remoteConfig.openTelemetryOtlpProtocol
    }
    if (remoteConfig.openTelemetryOtlpEndpoint !== undefined) {
        transformed.openTelemetryOtlpEndpoint = remoteConfig.openTelemetryOtlpEndpoint
    }
    if (remoteConfig.openTelemetryOtlpMetricsProtocol !== undefined) {
        transformed.openTelemetryOtlpMetricsProtocol = remoteConfig.openTelemetryOtlpMetricsProtocol
    }
    if (remoteConfig.openTelemetryOtlpMetricsEndpoint !== undefined) {
        transformed.openTelemetryOtlpMetricsEndpoint = remoteConfig.openTelemetryOtlpMetricsEndpoint
    }
    if (remoteConfig.openTelemetryOtlpLogsProtocol !== undefined) {
        transformed.openTelemetryOtlpLogsProtocol = remoteConfig.openTelemetryOtlpLogsProtocol
    }
    if (remoteConfig.openTelemetryOtlpLogsEndpoint !== undefined) {
        transformed.openTelemetryOtlpLogsEndpoint = remoteConfig.openTelemetryOtlpLogsEndpoint
    }
    if (remoteConfig.openTelemetryMetricExportInterval !== undefined) {
        transformed.openTelemetryMetricExportInterval = remoteConfig.openTelemetryMetricExportInterval
    }
    if (remoteConfig.openTelemetryOtlpInsecure !== undefined) {
        transformed.openTelemetryOtlpInsecure = remoteConfig.openTelemetryOtlpInsecure
    }
    if (remoteConfig.openTelemetryLogBatchSize !== undefined) {
        transformed.openTelemetryLogBatchSize = remoteConfig.openTelemetryLogBatchSize
    }
    if (remoteConfig.openTelemetryLogBatchTimeout !== undefined) {
        transformed.openTelemetryLogBatchTimeout = remoteConfig.openTelemetryLogBatchTimeout
    }
    if (remoteConfig.openTelemetryLogMaxQueueSize !== undefined) {
        transformed.openTelemetryLogMaxQueueSize = remoteConfig.openTelemetryLogMaxQueueSize
    }
    if (remoteConfig.openTelemetryOtlpHeaders !== undefined) {
        transformed.openTelemetryOtlpHeaders = remoteConfig.openTelemetryOtlpHeaders
    }
    if (remoteConfig.openTelemetryOtlpMetricsHeaders !== undefined) {
        transformed.otlpMetricsHeaders = remoteConfig.openTelemetryOtlpMetricsHeaders
    }
    if (remoteConfig.openTelemetryOtlpLogsHeaders !== undefined) {
        transformed.otlpLogsHeaders = remoteConfig.openTelemetryOtlpLogsHeaders
    }

    // Map provider settings
    const providers: ApiProvider[] = []

    // Map OpenAiCompatible provider settings
    const openAiSettings = remoteConfig.providerSettings?.OpenAiCompatible
    if (openAiSettings) {
        providers.push("openai")
        // Provider-specific fields (baseUrl, headers, etc.) are now sourced from
        // ApiProfile + ModelRegistry at runtime. Remote config no longer overrides them.
    }

    // Map AwsBedrock provider settings
    const awsBedrockSettings = remoteConfig.providerSettings?.AwsBedrock
    if (awsBedrockSettings) {
        providers.push("bedrock")
        // Provider-specific fields are now sourced from ApiProfile + ModelRegistry at runtime.
    }

    const clineSettings = remoteConfig.providerSettings?.Cline
    if (clineSettings) {
        providers.push("cline")
    }

    // Map LiteLLM provider settings
    const liteLlmSettings = remoteConfig.providerSettings?.LiteLLM
    if (liteLlmSettings) {
        providers.push("litellm")
        // Provider-specific fields are now sourced from ApiProfile + ModelRegistry at runtime.
    }

    // Map Vertex provider settings
    const vertexSettings = remoteConfig.providerSettings?.Vertex
    if (vertexSettings) {
        providers.push("vertex")
        // Provider-specific fields are now sourced from ApiProfile + ModelRegistry at runtime.
    }

    const anthropicSettings = remoteConfig.providerSettings?.Anthropic
    if (anthropicSettings) {
        providers.push("anthropic")
        // Provider-specific fields are now sourced from ApiProfile + ModelRegistry at runtime.
    }

    // This line needs to stay here, it is order dependent on the above code checking the configured providers
    if (providers.length > 0) {
        transformed.remoteConfiguredProviders = providers
    }

    // Map global rules, workflows, and skills
    if (remoteConfig.globalRules !== undefined) {
        transformed.remoteGlobalRules = remoteConfig.globalRules
    }
    if (remoteConfig.globalWorkflows !== undefined) {
        transformed.remoteGlobalWorkflows = remoteConfig.globalWorkflows
    }
    if (remoteConfig.globalSkills !== undefined) {
        transformed.remoteGlobalSkills = remoteConfig.globalSkills
    }

    if (remoteConfig.enterpriseTelemetry?.promptUploading) {
        const promptUplaoding = remoteConfig.enterpriseTelemetry.promptUploading
        if (promptUplaoding.type === "s3_access_keys" && promptUplaoding.s3AccessSettings) {
            transformed.blobStoreConfig = accessSettingsToBlobStorage("s3", promptUplaoding.s3AccessSettings)
        } else if (promptUplaoding.type === "r2_access_keys" && promptUplaoding.r2AccessSettings) {
            transformed.blobStoreConfig = accessSettingsToBlobStorage("r2", promptUplaoding.r2AccessSettings)
        } else if (promptUplaoding.type === "azure_access_keys" && promptUplaoding.azureAccessSettings) {
            transformed.blobStoreConfig = accessSettingsToBlobStorage("azure", promptUplaoding.azureAccessSettings)
        }
    }

    return transformed
}

async function applyRemoteSyncQueueConfig(transformed: Partial<RemoteConfigFields>) {
    try {
        const blobStoreConfig = transformed.blobStoreConfig
        if (!blobStoreConfig) {
            return
        }

        syncWorker().init({ ...blobStoreConfig, userDistinctId: getDistinctId() })
    } catch (err) {
        Logger.error("[REMOTE CONFIG DEBUG] Failed to apply remote sync queue config", err)
    }
}

export function clearRemoteConfig() {
    try {
        const stateManager = StateManager.get()

        stateManager.clearRemoteConfig()
        remoteOtelProviderReconciler.clear()
        // the remote config cline rules toggle state is stored in global state
        stateManager.setGlobalState("remoteRulesToggles", {})
        stateManager.setGlobalState("remoteWorkflowToggles", {})
        stateManager.setGlobalState("remoteSkillsToggles", {})

        // clear secrets
        stateManager.setSecret("remoteLiteLlmApiKey", undefined)
    } catch (err) {
        Logger.error("[REMOTE CONFIG] Failed to clear remote config", err)
    }
}

/**
 * Applies remote config to the StateManager's remote config cache
 * @param remoteConfig The remote configuration object to apply
 * @param mcpHub McpHub instance to prevent watcher triggers during sync
 */
export async function applyRemoteConfig(
    remoteConfig: RemoteConfig,
    configuredKeys: ConfiguredAPIKeys,
    mcpHub: McpHub,
): Promise<void> {
    const stateManager = StateManager.get()
    // If no remote config provided, clear the cache and relevant state
    if (!remoteConfig) {
        clearRemoteConfig()
        return
    }

    // Save previousRemoteMCPServers before clearing cache, this is needed for next sync to detect removals)
    const previousRemoteMCPServers = stateManager.getRemoteConfigSettings().previousRemoteMCPServers

    // Transform remote config to state shape
    // These are then set to the remote config cache in the StateManager
    // We need to ensure the cache is checked for new fields
    const transformed = transformRemoteConfigToStateShape(remoteConfig)

    // Synchronize toggle state
    const currentRuleToggles = stateManager.getGlobalStateKey("remoteRulesToggles") || {}
    const currentWorkflowToggles = stateManager.getGlobalStateKey("remoteWorkflowToggles") || {}

    const syncedRuleToggles = synchronizeRemoteRuleToggles(remoteConfig.globalRules || [], currentRuleToggles)
    const syncedWorkflowToggles = synchronizeRemoteRuleToggles(remoteConfig.globalWorkflows || [], currentWorkflowToggles)

    // Remote skills use shared validation (entry.name must match frontmatter.name)
    const currentSkillToggles = stateManager.getGlobalStateKey("remoteSkillsToggles") || {}
    const validatedSkillEntries = parseRemoteSkillEntries(remoteConfig.globalSkills || [])
    const syncedSkillToggles = synchronizeRemoteRuleToggles(validatedSkillEntries, currentSkillToggles)

    // Enforce alwaysEnabled: override any stale false toggles for skills the admin has locked on.
    // This ensures the toggle store is the single source of truth — both the UI and handler agree.
    for (const entry of validatedSkillEntries) {
        if (entry.alwaysEnabled && syncedSkillToggles[entry.name] === false) {
            syncedSkillToggles[entry.name] = true
        }
    }

    stateManager.setGlobalState("remoteRulesToggles", syncedRuleToggles)
    stateManager.setGlobalState("remoteWorkflowToggles", syncedWorkflowToggles)
    stateManager.setGlobalState("remoteSkillsToggles", syncedSkillToggles)

    // Profile-driven: provider selection is determined by profile names,
    // not by flat provider fields. Remote config no longer overrides providers.

    // Build the full new cache and swap atomically to avoid a window where
    // concurrent capability readers see an empty cache.
    const newCache: Partial<RemoteConfigFields> = { ...transformed, configuredApiKeys: configuredKeys }
    if (previousRemoteMCPServers !== undefined) {
        newCache.previousRemoteMCPServers = previousRemoteMCPServers
    }
    stateManager.replaceRemoteConfig(newCache)

    applyRemoteSyncQueueConfig(transformed)

    // Always sync remote MCP servers when remote config is active.
    // The sync function uses the persistent `remoteConfigured` marker in the settings file
    // to identify which servers were added by remote config. This means:
    // - Servers no longer in remoteMCPServers but marked `remoteConfigured: true` get removed
    // - New servers get added with the `remoteConfigured: true` marker
    // - No dependency on in-memory state that would be lost across restarts
    try {
        const serversToSync = remoteConfig.remoteMCPServers ?? []
        const settingsPath = await ensureSettingsDirectoryExists()
        await syncRemoteMcpServersToSettings(serversToSync, settingsPath, mcpHub)
        stateManager.setRemoteConfigField("previousRemoteMCPServers", serversToSync)
    } catch (error) {
        Logger.error("[RemoteConfig] Failed to sync remote MCP servers to settings:", error)
        // Continue with other config application even if MCP sync fails
    }
    const otelConfig = remoteConfigToOtelConfig(transformed)
    remoteOtelProviderReconciler.reconcile(isOpenTelemetryConfigValid(otelConfig) ? otelConfig : undefined)
}

/**
 * Receives a config and returns the subset of fields that can be overriden in the cache
 */
/**
 * Filter allowed remote config fields.
 * Profile-driven: provider selection is determined by profile names,
 * not by flat provider fields. Returns an empty object — provider
 * filtering through remote config is no longer applicable.
 */
export function filterAllowedRemoteConfigFields(_config: Partial<GlobalStateAndSettings>): Partial<GlobalStateAndSettings> {
    return {}
}

const canDisableRemoteConfig = (orgId: string) => {
    // Check if they're an admin/owner
    const authService = AuthService.getInstance()
    const userOrgs = authService.getUserOrganizations()

    if (!userOrgs) {
        return false
    }

    const org = userOrgs.find((org) => org.organizationId === orgId)
    const isAdminOrOwner = org?.roles?.some((role) => role === "admin" || role === "owner")

    return isAdminOrOwner
}

export const isRemoteConfigEnabled = (orgId: string) => {
    const stateManager = StateManager.get()
    const hasOptedOut = stateManager.getGlobalSettingsKey("optOutOfRemoteConfig")

    const isDisabled = hasOptedOut && canDisableRemoteConfig(orgId)

    return !isDisabled
}
