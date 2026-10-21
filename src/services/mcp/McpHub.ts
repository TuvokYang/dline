import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { sendMcpServersUpdate } from "@core/controller/mcp/subscribeToMcpServers"
import { getMcpSettingsFilePath as getMcpSettingsFilePathHelper } from "@core/storage/disk"
import { StateManager } from "@core/storage/StateManager"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
    CallToolResultSchema,
    GetPromptResultSchema,
    ListPromptsResultSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesResultSchema,
    ListToolsResultSchema,
    ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js"
import {
    DEFAULT_MCP_TIMEOUT_SECONDS,
    McpPrompt,
    McpPromptResponse,
    McpResource,
    McpResourceResponse,
    McpResourceTemplate,
    McpServer,
    McpTool,
    McpToolCallResponse,
    MIN_MCP_TIMEOUT_SECONDS,
} from "@shared/mcp"
import { deriveUniqueMcpServerKey, type McpToolAddress, nativeMcpToolName, resolveMcpToolSegment } from "@shared/mcp-native-name"
import { secondsToMs } from "@utils/time"
import chokidar, { FSWatcher } from "chokidar"
import deepEqual from "fast-deep-equal"
import * as fs from "fs/promises"
import ReconnectingEventSource from "reconnecting-eventsource"
import { z } from "zod"
import { getMcpVariableStore } from "@/core/storage/secrets/McpVariableStore"
import { dlineUiPresence } from "@/core/webview/DlineUiPresence"
import { HostProvider } from "@/hosts/host-provider"
import { withDiagnosticSite } from "@/shared/errors/diagnostic-site"
import { fetch } from "@/shared/net"
import { ShowMessageType } from "@/shared/proto/dline/host/window"
import { Logger } from "@/shared/services/Logger"
import { hashStableJson } from "@/shared/stable-json"
import { expandEnvironmentVariables } from "@/utils/envExpansion"
import { TelemetryService } from "../telemetry/TelemetryService"
import { describeMcpConnectionError } from "./connection-error"
import { DEFAULT_REQUEST_TIMEOUT_MS, MCP_CONNECT_TIMEOUT_MS } from "./constants"
import { McpAuthentication } from "./McpAuthentication"
import { type McpToolApprovalConfig, resolveMcpToolAutoApprove, updateMcpToolAutoApproveConfig } from "./mcp-auto-approval"
import { McpCallObservation } from "./mcp-call-observation"
import { mcpTransportObserver } from "./mcp-transport-observation"
import { StreamableHttpReconnectHandler } from "./StreamableHttpReconnectHandler"
import { BaseConfigSchema, McpSettingsSchema, ServerConfigSchema } from "./schemas"
import { McpConnection, McpServerConfig, Transport } from "./types"
import { safeParseWithEnvReferences } from "./variables/envReferenceValidation"
import { promptForMcpVariable } from "./variables/hostVariablePrompt"
import { McpVariableResolver } from "./variables/McpVariableResolver"
import { type WorkspaceMcpDescriptor, WorkspaceMcpRegistry } from "./WorkspaceMcpRegistry"
import { WorkspaceMcpToolApprovals, workspaceDescriptorFingerprint } from "./WorkspaceMcpToolApprovals"

type McpConnectionMetadata = {
    displayName?: string
    description?: string
    source: NonNullable<McpServer["source"]>
}

export class McpHub {
    getMcpServersPath: () => Promise<string>
    private getSettingsDirectoryPath: () => Promise<string>
    private clientVersion: string
    private telemetryService: TelemetryService
    private readonly authentication: McpAuthentication

    private settingsWatcher?: FSWatcher
    private fileWatchers: Map<string, FSWatcher> = new Map()
    private settingsServerConfigs: Record<string, McpServerConfig> = {}
    private readonly workspaceMcpRegistry: WorkspaceMcpRegistry
    private readonly workspaceToolApprovals = new WorkspaceMcpToolApprovals()
    private workspaceConnectionRefresh: Promise<void> = Promise.resolve()
    /**
     * Serializes reconcile runs so concurrent triggers (file watcher, workspace
     * registration, RPC) cannot race each other. Without this, a second reconcile
     * arriving while connectToServer is in flight deletes the in-progress
     * connection and spawns a new process, producing the reconnect loop seen in
     * logs ("transport onclose" -> "spawning" every few seconds).
     */
    private reconcileQueue: Promise<void> = Promise.resolve()
    /** Resolves `${env:...}` at connect time from saved values, the environment, or a masked prompt. */
    private readonly variableResolver = new McpVariableResolver({
        store: getMcpVariableStore(),
        prompt: promptForMcpVariable,
        // Starting VS Code connects servers before anyone opens Dline; asking then would
        // pop input boxes the user never invited. Such servers connect once Dline is shown.
        canPrompt: () => dlineUiPresence.isShown,
    })
    connections: McpConnection[] = []
    isConnecting = false
    /**
     * Flag to skip file watcher processing when we're updating Cline-specific settings
     * (autoApprove, timeout) that don't require an MCP server restart.
     *
     * The file watcher has a 100ms stabilityThreshold before firing "change" events.
     * When we update settings, we set this flag to true, write the file, then clear
     * the flag after 300ms. This ensures the flag is still true when the delayed
     * file watcher event fires, so we can skip redundant processing.
     *
     * Timeline:
     *   0ms:    flag = true, write file
     *   ~100ms: file watcher fires "change" → sees flag=true → skips
     *   300ms:  flag = false (ready for external file changes)
     */
    private isUpdatingClineSettings = false

    // Track when remote config is updating to prevent unnecessary watcher triggers
    private isUpdatingFromRemoteConfig = false

    /**
     * Map of unique keys to each connected server names
     */
    private static mcpServerKeys = new Map<string, string>()

    // Store notifications for display in chat
    private pendingNotifications: Array<{
        serverName: string
        level: string
        message: string
        timestamp: number
    }> = []

    // Callbacks for sending notifications to active tasks (multicast for shared instance)
    private notificationCallbacks: Set<(serverName: string, level: string, message: string) => void> = new Set()
    private promptCatalogChangeListeners: Set<() => void> = new Set()
    private promptCatalogSignature = "[]"

    // Shared singleton — multiple Controllers share one McpHub to avoid duplicate
    // docker gateway processes and reduce resource contention.
    private static _sharedInstance: McpHub | null = null
    private static _refCount = 0

    /**
     * Get or create the shared McpHub singleton.
     * Each Controller that calls this increments the reference count.
     * When all Controllers have disposed, the underlying MCP connections are torn down.
     */
    static getSharedInstance(
        getMcpServersPath: () => Promise<string>,
        getSettingsDirectoryPath: () => Promise<string>,
        clientVersion: string,
        telemetryService: TelemetryService,
    ): McpHub {
        // If previous singleton was fully released, create a fresh one
        if (McpHub._sharedInstance && McpHub._refCount <= 0) {
            McpHub._sharedInstance = null
        }
        if (!McpHub._sharedInstance) {
            McpHub._sharedInstance = new McpHub(getMcpServersPath, getSettingsDirectoryPath, clientVersion, telemetryService)
        }
        McpHub._refCount++
        return McpHub._sharedInstance
    }

    constructor(
        getMcpServersPath: () => Promise<string>,
        getSettingsDirectoryPath: () => Promise<string>,
        clientVersion: string,
        telemetryService: TelemetryService,
    ) {
        this.getMcpServersPath = getMcpServersPath
        this.getSettingsDirectoryPath = getSettingsDirectoryPath
        this.clientVersion = clientVersion
        this.telemetryService = telemetryService
        this.authentication = new McpAuthentication({
            connections: () => this.connections,
            restartConnection: (serverName) => this.restartConnection(serverName),
        })
        this.workspaceMcpRegistry = new WorkspaceMcpRegistry(() => this.refreshWorkspaceConnections())
        void this.watchMcpSettingsFile().catch((error) => Logger.error("[McpHub] Failed to watch MCP settings:", error))
        void this.initializeMcpServers().catch((error) => Logger.error("[McpHub] Failed to initialize MCP servers:", error))
    }

    getServers(): McpServer[] {
        // Only return enabled servers

        return this.connections.filter((conn) => !conn.server.disabled).map((conn) => conn.server)
    }

    /** Subscribe to committed prompt-visible MCP catalog changes. */
    subscribeToPromptCatalogChanges(listener: () => void): () => void {
        this.promptCatalogChangeListeners.add(listener)
        return () => this.promptCatalogChangeListeners.delete(listener)
    }

    getServersForOwner(ownerId: string): McpServer[] {
        const workspaceServerNames = new Set(
            this.workspaceMcpRegistry.getDescriptorsForOwner(ownerId).map((descriptor) => descriptor.internalName),
        )
        return this.connections
            .filter((connection) => !connection.server.disabled)
            .filter((connection) => connection.server.source !== "workspace" || workspaceServerNames.has(connection.server.name))
            .map((connection) => connection.server)
    }

    getAllServersForOwner(ownerId: string): McpServer[] {
        const workspaceServerNames = new Set(
            this.workspaceMcpRegistry.getDescriptorsForOwner(ownerId).map((descriptor) => descriptor.internalName),
        )
        return this.connections
            .filter((connection) => connection.server.source !== "workspace" || workspaceServerNames.has(connection.server.name))
            .map((connection) => connection.server)
    }

    async registerWorkspaceOwner(ownerId: string, workspaceRoots: readonly string[]): Promise<void> {
        await this.workspaceMcpRegistry.registerOwner(ownerId, workspaceRoots)
    }

    async refreshWorkspaceOwner(ownerId: string): Promise<void> {
        await this.workspaceMcpRegistry.refreshOwner(ownerId)
    }

    async unregisterWorkspaceOwner(ownerId: string): Promise<void> {
        await this.workspaceMcpRegistry.unregisterOwner(ownerId)
    }

    private getEffectiveServerConfigs(): Record<string, McpServerConfig> {
        const workspaceConfigs = Object.fromEntries(
            this.workspaceMcpRegistry
                .getAllDescriptors()
                .map((descriptor) => [descriptor.internalName, descriptor.config] as const),
        )
        // A settings entry wins the unlikely case where its name matches an internal workspace name.
        return { ...workspaceConfigs, ...this.settingsServerConfigs }
    }

    private getConnectionMetadata(serverName: string): McpConnectionMetadata | undefined {
        if (this.settingsServerConfigs[serverName]) return { source: "settings" }
        const descriptor = this.findWorkspaceDescriptor(serverName)
        return descriptor
            ? {
                  displayName: descriptor.displayName,
                  description: descriptor.description,
                  source: descriptor.source,
              }
            : undefined
    }

    /** The workspace descriptor behind a server, or undefined for a settings server. */
    private findWorkspaceDescriptor(serverName: string): WorkspaceMcpDescriptor | undefined {
        if (this.settingsServerConfigs[serverName]) return undefined
        return this.workspaceMcpRegistry.getAllDescriptors().find((candidate) => candidate.internalName === serverName)
    }

    /**
     * Resolves a server's per-tool auto-approve state from its one authority: the MCP settings entry
     * for a settings server, the user's own grant for a workspace server. A workspace descriptor's
     * content never grants approval.
     */
    private toolAutoApproval(
        serverName: string,
        settingsEntry: McpToolApprovalConfig | undefined,
    ): (toolName: string) => boolean {
        const descriptor = this.findWorkspaceDescriptor(serverName)
        if (!descriptor) return (toolName) => resolveMcpToolAutoApprove(settingsEntry ?? {}, toolName)
        const fingerprint = workspaceDescriptorFingerprint(descriptor.config)
        return (toolName) => this.workspaceToolApprovals.isApproved(serverName, fingerprint, toolName)
    }

    private refreshWorkspaceConnections(): Promise<void> {
        const refresh = this.workspaceConnectionRefresh.then(async () => {
            const settings = await this.readAndValidateMcpSettingsFile()
            if (settings) this.settingsServerConfigs = { ...settings.mcpServers }
            await this.reconcileServerConnections("internal")
        })
        this.workspaceConnectionRefresh = refresh.catch((error) => {
            Logger.error("[McpHub] Failed to refresh workspace MCP connections:", error)
        })
        return refresh
    }

    /**
     * Get the MCP server name from its unique key.
     * If the key is not found, return the key itself.
     */
    public static getMcpServerByKey(key: string): string {
        return McpHub.mcpServerKeys.get(key) || key
    }

    /**
     * Resolve the server and tool a native MCP function name addresses. The result
     * carries the configured server name and the real tool name, which is what
     * execution and per-tool auto-approval match against.
     */
    resolveNativeTool(serverKey: string, toolSegment: string): McpToolAddress {
        const connection =
            this.connections.find((candidate) => candidate.server.uid === serverKey) ??
            this.connections.find((candidate) => candidate.server.name === McpHub.getMcpServerByKey(serverKey))
        const serverName = connection?.server.name ?? McpHub.getMcpServerByKey(serverKey)
        const toolNames = (connection?.server.tools ?? []).map((tool) => tool.name)
        return { serverName, toolName: resolveMcpToolSegment(toolSegment, toolNames) }
    }

    /**
     * Return the key native MCP function names use for a server, registering it on first use.
     * The key is derived from the server name, so it is the same in every process.
     */
    private getMcpServerKey(server: string): string {
        for (const [existingKey, existingServer] of McpHub.mcpServerKeys.entries()) {
            if (existingServer === server) {
                return existingKey
            }
        }
        const key = deriveUniqueMcpServerKey(server, (candidate) => McpHub.mcpServerKeys.has(candidate))
        McpHub.mcpServerKeys.set(key, server)
        return key
    }

    /**
     * Gets the path to the MCP settings file
     * @returns Path to the MCP settings file
     */
    async getMcpSettingsFilePath(): Promise<string> {
        return getMcpSettingsFilePathHelper(await this.getSettingsDirectoryPath())
    }

    /**
     * Sets the flag to indicate remote config is updating
     * Used to prevent watcher from triggering on remote config writes
     */
    setIsUpdatingFromRemoteConfig(value: boolean): void {
        this.isUpdatingFromRemoteConfig = value
    }

    /**
     * Gets whether remote config is currently updating
     */
    getIsUpdatingFromRemoteConfig(): boolean {
        return this.isUpdatingFromRemoteConfig
    }

    private async readAndValidateMcpSettingsFile(): Promise<z.infer<typeof McpSettingsSchema> | undefined> {
        try {
            const settingsPath = await getMcpSettingsFilePathHelper(await this.getSettingsDirectoryPath())
            const content = await fs.readFile(settingsPath, "utf-8")

            let config: any

            // Handle empty or minimal files silently - this is a valid state meaning "no MCP servers"
            const trimmedContent = content.trim()
            if (!trimmedContent || trimmedContent === "{}" || trimmedContent === '{"mcpServers":{}}') {
                return { mcpServers: {} }
            }

            // Parse JSON file content
            try {
                config = JSON.parse(content)
            } catch (_error) {
                HostProvider.window.showMessage({
                    type: ShowMessageType.ERROR,
                    message: "Invalid MCP settings format. Please ensure your settings follow the correct JSON format.",
                })
                return undefined
            }

            // Validate with ${env:...} references masked: they are resolved at connect time and
            // never stored, compared, written back, or sent to the webview expanded.
            const result = safeParseWithEnvReferences(McpSettingsSchema, config)
            if (!result.success) {
                HostProvider.window.showMessage({
                    type: ShowMessageType.ERROR,
                    message: "Invalid MCP settings schema.",
                })
                return undefined
            }

            return result.data
        } catch (error) {
            Logger.error("Failed to read MCP settings:", error)
            return undefined
        }
    }

    private async watchMcpSettingsFile(): Promise<void> {
        const settingsPath = await getMcpSettingsFilePathHelper(await this.getSettingsDirectoryPath())

        this.settingsWatcher = chokidar.watch(settingsPath, {
            persistent: true, // Keep the process running as long as files are being watched
            ignoreInitial: true, // Don't fire 'add' events when discovering the file initially
            awaitWriteFinish: {
                // Wait for writes to finish before emitting events (handles chunked writes)
                stabilityThreshold: 100, // Wait 100ms for file size to remain constant
                pollInterval: 100, // Check file size every 100ms while waiting for stability
            },
            atomic: true, // Handle atomic writes where editors write to a temp file then rename (prevents duplicate events)
        })

        this.settingsWatcher.on("change", async () => {
            // Skip if remote config is currently updating to prevent unnecessary reconnections
            if (this.isUpdatingFromRemoteConfig) {
                return
            }
            // Skip processing if we're updating Cline-specific settings (autoApprove, timeout)
            if (this.isUpdatingClineSettings) {
                return
            }

            const settings = await this.readAndValidateMcpSettingsFile()
            if (settings) {
                try {
                    // Re-add any remotely configured servers that were manually removed from the file
                    const remoteServers = StateManager.get().getRemoteConfigSettings().remoteMCPServers
                    if (remoteServers?.length) {
                        let fileNeedsUpdate = false
                        for (const rs of remoteServers) {
                            if (!settings.mcpServers[rs.name]) {
                                ;(settings.mcpServers as Record<string, any>)[rs.name] = {
                                    url: rs.url,
                                    type: "streamableHttp",
                                    disabled: false,
                                    disabledAutoApprove: [],
                                    remoteConfigured: true,
                                }
                                fileNeedsUpdate = true
                            }
                        }
                        if (fileNeedsUpdate) {
                            this.isUpdatingFromRemoteConfig = true
                            const settingsPath = await getMcpSettingsFilePathHelper(await this.getSettingsDirectoryPath())
                            await fs.writeFile(settingsPath, JSON.stringify({ mcpServers: settings.mcpServers }, null, 2))
                            this.isUpdatingFromRemoteConfig = false
                        }
                    }
                    await this.updateServerConnections(settings.mcpServers)
                } catch (error) {
                    Logger.error("Failed to process MCP settings change:", error)
                }
            }
        })

        this.settingsWatcher.on("error", (error) => {
            Logger.error("Error watching MCP settings file:", error)
        })
    }

    private async initializeMcpServers(): Promise<void> {
        const settings = await this.readAndValidateMcpSettingsFile()
        if (settings) {
            await this.updateServerConnections(settings.mcpServers)
        }
    }

    private findConnection(name: string, _source: "rpc" | "internal"): McpConnection | undefined {
        return this.connections.find((conn) => conn.server.name === name)
    }

    private async connectToServer(
        name: string,
        config: z.infer<typeof ServerConfigSchema>,
        source: "rpc" | "internal",
        metadata: McpConnectionMetadata | undefined = this.getConnectionMetadata(name),
    ): Promise<void> {
        // Remove existing connection if it exists (should never happen, the connection should be deleted beforehand)
        this.connections = this.connections.filter((conn) => conn.server.name !== name)

        // Validate remote MCP server URL against remote config if blockPersonalRemoteMCPServers is enabled
        if (config.type !== "stdio" && "url" in config && config.url) {
            const stateManager = StateManager.get()
            const remoteConfig = stateManager.getRemoteConfigSettings()

            if (remoteConfig.blockPersonalRemoteMCPServers === true) {
                const remoteMCPServers = remoteConfig.remoteMCPServers || []
                const allowedUrls = remoteMCPServers.map((server) => server.url)

                if (!allowedUrls.includes(config.url)) {
                    return
                }
            }
        }

        // Validate local MCP servers based on remote config (enterprise feature)
        if (config.type === "stdio") {
            const stateManager = StateManager.get()
            const remoteConfig = stateManager.getRemoteConfigSettings()

            // Early exit for non-enterprise users: if no remote config is set, allow all local servers
            if (Object.keys(remoteConfig).length === 0) {
                // No remote config restrictions - proceed with connection (default behavior for non-enterprise users)
                // This ensures backwards compatibility and that regular users are not affected
            } else {
                // Enterprise restrictions apply

                // If marketplace is explicitly disabled by enterprise config, block all local servers
                if (remoteConfig.mcpMarketplaceEnabled === false) {
                    return
                }

                // If allowlist exists, only servers on the allowlist are allowed
                const hasAllowlist = remoteConfig.allowedMCPServers && remoteConfig.allowedMCPServers.length > 0
                if (hasAllowlist) {
                    const allowedIds = remoteConfig.allowedMCPServers?.map((server: { id: string }) => server.id) ?? []
                    if (!allowedIds.includes(name)) {
                        return
                    }
                }

                // If marketplace is enabled with no allowlist, all local servers are allowed
            }
        }

        if (config.disabled) {
            //Logger.log(`[MCP Debug] Creating disabled connection object for server "${name}"`)
            // Create a connection object for disabled server so it appears in UI
            const disabledConnection: McpConnection = {
                server: {
                    name,
                    ...metadata,
                    config: JSON.stringify(config),
                    status: "disconnected",
                    disabled: true,
                },
                client: null as unknown as Client,
                transport: null as unknown as Transport,
            }
            this.connections.push(disabledConnection)
            return
        }

        // Resolve ${env:...} before the connect timeout starts: a missing value may wait for the user.
        const resolution = await this.variableResolver.resolve(
            { source: metadata?.source ?? "settings", serverName: name },
            metadata?.displayName ?? name,
            config,
        )
        if (resolution.kind === "missing") {
            this.connections.push({
                server: {
                    name,
                    ...metadata,
                    config: JSON.stringify(config),
                    status: "disconnected",
                    disabled: false,
                    error: `Not connected: no value was provided for \${env:${resolution.variable}}. Restart the server to enter it.`,
                    uid: this.getMcpServerKey(name),
                },
                client: null as unknown as Client,
                transport: null as unknown as Transport,
                missingVariable: resolution.variable,
            })
            await this.notifyWebviewOfServerChanges()
            return
        }
        if (resolution.kind === "deferred") {
            this.connections.push({
                server: {
                    name,
                    ...metadata,
                    config: JSON.stringify(config),
                    status: "disconnected",
                    disabled: false,
                    error: `Waiting for Dline to open: \${env:${resolution.variable}} has no saved value yet.`,
                    uid: this.getMcpServerKey(name),
                },
                client: null as unknown as Client,
                transport: null as unknown as Transport,
                waitingForDline: resolution.variable,
            })
            Logger.info(`[MCP ${name}] waiting for Dline to open before asking for \${env:${resolution.variable}}`)
            this.connectWaitingServersWhenDlineOpens()
            await this.notifyWebviewOfServerChanges()
            return
        }

        try {
            // Store unexpanded config for display/comparison (keeps credentials out of stored config)
            const configForStorage = JSON.stringify(config)
            const expandedConfig = resolution.config

            // Each MCP server requires its own transport connection and has unique capabilities, configurations, and error handling. Having separate clients also allows proper scoping of resources/tools and independent server management like reconnection.
            const client = new Client(
                {
                    name: "Dline",
                    version: this.clientVersion,
                },
                {
                    capabilities: {},
                },
            )

            let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

            // Create OAuth provider for remote transports (SSE and HTTP)
            const authProvider =
                expandedConfig.type === "sse" || expandedConfig.type === "streamableHttp"
                    ? await this.authentication.oauth.getOrCreateProvider(name, expandedConfig.url)
                    : undefined

            switch (expandedConfig.type) {
                case "stdio": {
                    transport = new StdioClientTransport({
                        command: expandedConfig.command,
                        args: expandedConfig.args,
                        cwd: expandedConfig.cwd,
                        env: {
                            ...getDefaultEnvironment(),
                            ...(expandedConfig.env || {}), // Now has expanded environment variables
                            // Inject PROGRAMDATA for Docker MCP gateway compatibility.
                            // getDefaultEnvironment() on Windows does not include PROGRAMDATA,
                            // but docker mcp gateway requires it to access Docker Desktop config.
                            ...(process.env.PROGRAMDATA ? { PROGRAMDATA: process.env.PROGRAMDATA } : {}),
                        },
                        stderr: "pipe",
                    })

                    transport.onerror = async (error) => {
                        Logger.debug(`[MCP ${name}] transport onerror:`, error)
                        mcpTransportObserver.record({
                            transport: "stdio",
                            classification: "exhausted",
                            outcome: "exhausted",
                            error,
                        })
                        Logger.error(`MCP stdio transport failed.`)
                        const connection = this.findConnection(name, source)
                        if (connection) {
                            connection.server.status = "disconnected"
                            McpHub.mcpServerKeys.delete(connection.server.uid || name)
                            this.appendErrorMessage(connection, describeMcpConnectionError(error))
                        }
                        await this.notifyWebviewOfServerChanges()
                        this.publishPromptCatalogIfChanged()
                    }

                    transport.onclose = async () => {
                        Logger.debug(`[MCP ${name}] transport onclose`)
                        const connection = this.findConnection(name, source)
                        if (connection) {
                            connection.server.status = "disconnected"
                            McpHub.mcpServerKeys.delete(connection.server.uid || name)
                        }
                        await this.notifyWebviewOfServerChanges()
                        this.publishPromptCatalogIfChanged()
                    }

                    // The command line and its arguments can carry tokens and local paths, so
                    // only their shape is logged. The full configuration stays in mcpSettings.
                    Logger.debug(`[MCP ${name}] spawning: argCount=${(expandedConfig.args || []).length}`)
                    await transport.start()
                    Logger.debug(`[MCP ${name}] process spawned, pid: ${transport.pid}`)
                    const stderrStream = transport.stderr
                    if (stderrStream) {
                        stderrStream.on("data", async (data: Buffer) => {
                            const output = data.toString()
                            const isInfoLog = !/\berror\b/i.test(output)
                            if (isInfoLog) {
                                // Server stderr is third-party output that may echo user content.
                                Logger.debug(`[McpHub] ${name}: stdout chars=${output.length}`)
                            } else {
                                Logger.debug(`[McpHub] ${name} stderr: chars=${output.length}`)
                                const connection = this.findConnection(name, source)
                                if (connection) {
                                    this.appendErrorMessage(connection, output)
                                    if (connection.server.status === "disconnected") {
                                        await this.notifyWebviewOfServerChanges()
                                    }
                                }
                            }
                        })
                    } else {
                        Logger.error(`No stderr stream for ${name}`)
                    }
                    transport.start = async () => {}
                    break
                }
                case "sse": {
                    const sseOptions = {
                        authProvider,
                        requestInit: {
                            headers: expandedConfig.headers,
                        },
                    }
                    const reconnectingEventSourceOptions = {
                        max_retry_time: 5000,
                        withCredentials: !!expandedConfig.headers?.Authorization,
                        // IMPORTANT: Custom fetch function is required for SSE with OAuth
                        // When we provide eventSourceInit, we override the SDK's default fetch
                        // The SDK's default would call _commonHeaders() for auth, but since we're
                        // overriding it, we must provide our own fetch that:
                        // 1. Calls authProvider.tokens() dynamically (not captured once)
                        // 2. Gets fresh tokens for each connection/reconnection
                        // 3. Allows the SDK to auto-refresh expired tokens
                        // Without this, tokens would be stale and fail after expiry
                        fetch: authProvider
                            ? async (url: string | URL, init?: RequestInit) => {
                                  const tokens = await authProvider.tokens() // Dynamic - gets fresh tokens
                                  const headers = new Headers(init?.headers)
                                  if (tokens?.access_token) {
                                      headers.set("Authorization", `Bearer ${tokens.access_token}`)
                                  }
                                  return fetch(url.toString(), { ...init, headers })
                              }
                            : undefined,
                    }
                    // Use ReconnectingEventSource for auto-reconnection on connection drops
                    global.EventSource = ReconnectingEventSource
                    transport = new SSEClientTransport(new URL(expandedConfig.url), {
                        ...sseOptions,
                        eventSourceInit: reconnectingEventSourceOptions,
                    })

                    transport.onerror = async (error) => {
                        mcpTransportObserver.record({
                            transport: "sse",
                            classification: "transient",
                            outcome: "scheduled",
                            error,
                        })
                        Logger.warn(`MCP SSE transport interrupted; the EventSource will attempt recovery.`)
                        const connection = this.findConnection(name, source)
                        if (connection) {
                            connection.server.status = "disconnected"
                            McpHub.mcpServerKeys.delete(connection.server.uid || name)
                            this.appendErrorMessage(connection, describeMcpConnectionError(error))
                        }
                        await this.notifyWebviewOfServerChanges()
                    }
                    break
                }
                case "streamableHttp": {
                    // Use ReconnectingEventSource for auto-reconnection on connection drops
                    global.EventSource = ReconnectingEventSource

                    // Custom fetch wrapper that treats 404 as 405 for GET requests.
                    // The MCP SDK sends a GET request to check for SSE stream support.
                    // Per MCP spec, servers should return 405 if they don't support SSE,
                    // but many servers (incorrectly) return 404. The SDK only handles 405
                    // gracefully, so we normalize 404 -> 405 to fix compatibility.
                    // See: https://github.com/modelcontextprotocol/typescript-sdk/issues/1150
                    const streamableHttpFetch: typeof fetch = async (url, init) => {
                        const response = await fetch(url, init)
                        if (init?.method === "GET" && response.status === 404) {
                            return new Response(response.body, {
                                status: 405,
                                statusText: "Method Not Allowed",
                                headers: response.headers,
                            })
                        }
                        return response
                    }

                    transport = new StreamableHTTPClientTransport(new URL(expandedConfig.url), {
                        authProvider,
                        requestInit: {
                            headers: expandedConfig.headers ?? undefined,
                        },
                        fetch: streamableHttpFetch,
                    })

                    const reconnectHandler = new StreamableHttpReconnectHandler(name, {
                        findConnection: () => this.findConnection(name, source),
                        deleteConnection: () => this.deleteConnection(name),
                        connectToServer: () => this.connectToServer(name, config, source, metadata),
                        notifyWebviewOfServerChanges: () => this.notifyWebviewOfServerChanges(),
                        appendErrorMessage: (conn, msg) => this.appendErrorMessage(conn as McpConnection, msg),
                        deleteServerKey: (uid) => McpHub.mcpServerKeys.delete(uid),
                        delay: (ms) => setTimeoutPromise(ms),
                    })

                    transport.onerror = (error) => reconnectHandler.handleError(error)
                    break
                }
                default:
                    throw new Error(`Unknown transport type: ${(config as any).type}`)
            }

            const connection: McpConnection = {
                server: {
                    name,
                    ...metadata,
                    config: configForStorage,
                    status: "connecting",
                    disabled: config.disabled,
                    uid: this.getMcpServerKey(name),
                    oauthRequired: false,
                    oauthAuthStatus: "authenticated",
                },
                client,
                transport,
                authProvider,
            }
            this.connections.push(connection)

            // Connect - wrap in try-catch to detect OAuth requirement
            try {
                let timeoutHandle: ReturnType<typeof setTimeout> | undefined
                try {
                    await Promise.race([
                        client.connect(transport),
                        new Promise<never>((_, reject) => {
                            timeoutHandle = setTimeout(
                                () => reject(new Error(`MCP connection timed out after ${MCP_CONNECT_TIMEOUT_MS}ms: ${name}`)),
                                MCP_CONNECT_TIMEOUT_MS,
                            )
                        }),
                    ])
                } finally {
                    if (timeoutHandle) clearTimeout(timeoutHandle)
                }
            } catch (error) {
                if (error instanceof UnauthorizedError) {
                    // Only an HTTP 401 from the server reaches here; a server that is down fails the fetch instead.
                    Logger.log(`Server "${name}" requires OAuth authentication`)
                    const unauthConnection: McpConnection = {
                        server: {
                            name,
                            ...metadata,
                            config: JSON.stringify(config),
                            status: "disconnected",
                            disabled: false,
                            oauthRequired: true,
                            oauthAuthStatus: "unauthenticated",
                            error: "The server answered 401 Unauthorized: authenticate to connect, or retry if it was restarted.",
                            uid: this.getMcpServerKey(name),
                        },
                        client,
                        transport,
                        authProvider, // CRITICAL: Keep authProvider so it's available when user authenticates!
                    }
                    // Replace the connection with unauthenticated version
                    this.connections = this.connections.filter((conn) => conn.server.name !== name)
                    this.connections.push(unauthConnection)
                    await this.notifyWebviewOfServerChanges()
                    return // Don't throw, just mark as needs auth
                }
                // Stop a transport whose handshake failed or exceeded the optional dependency budget.
                await transport.close().catch(() => undefined)
                await client.close().catch(() => undefined)
                // Re-throw other errors
                throw error
            }

            connection.server.status = "connected"
            connection.server.error = ""

            // Register notification handler for real-time messages
            //Logger.log(`[MCP Debug] Setting up notification handlers for server: ${name}`)
            //Logger.log(`[MCP Debug] Client instance:`, connection.client)
            //Logger.log(`[MCP Debug] Transport type:`, config.type)

            // Try to set notification handler using the client's method
            try {
                // Import the notification schema from MCP SDK
                const { z } = await import("zod")

                // Define the notification schema for notifications/message
                const NotificationMessageSchema = z.object({
                    method: z.literal("notifications/message"),
                    params: z
                        .object({
                            level: z.enum(["debug", "info", "warning", "error"]).optional(),
                            logger: z.string().optional(),
                            data: z.string().optional(),
                            message: z.string().optional(),
                        })
                        .optional(),
                })

                // Set the notification handler
                connection.client.setNotificationHandler(NotificationMessageSchema as any, async (notification: any) => {
                    //Logger.log(`[MCP Notification] ${name}:`, JSON.stringify(notification, null, 2))

                    const params = notification.params || {}
                    const level = params.level || "info"
                    const data = params.data || params.message || ""
                    const logger = params.logger || ""

                    //Logger.log(`[MCP Message Notification] ${name}: level=${level}, data=${data}, logger=${logger}`)

                    // Format the message
                    const message = logger ? `[${logger}] ${data}` : data

                    // Send notification directly to active task if callback is set
                    if (this.notificationCallbacks.size > 0) {
                        //Logger.log(`[MCP Debug] Sending notification to active task: ${message}`)
                        for (const cb of this.notificationCallbacks) {
                            try {
                                cb(name, level, message)
                            } catch {
                                // Best-effort; don't let one broken callback break others
                            }
                        }
                    } else {
                        // Fallback: store for later retrieval
                        //Logger.log(`[MCP Debug] No active task, storing notification: ${message}`)
                        this.pendingNotifications.push({
                            serverName: name,
                            level,
                            message,
                            timestamp: Date.now(),
                        })
                    }
                })
                //Logger.log(`[MCP Debug] Successfully set notifications/message handler for ${name}`)

                // Also set a fallback handler for any other notification types
                connection.client.fallbackNotificationHandler = async (notification: any) => {
                    //Logger.log(`[MCP Fallback Notification] ${name}:`, JSON.stringify(notification, null, 2))

                    // Show in VS Code for visibility
                    HostProvider.window.showMessage({
                        type: ShowMessageType.INFORMATION,
                        message: `MCP ${name}: ${notification.method || "unknown"} - ${JSON.stringify(notification.params || {})}`,
                    })
                }
                //Logger.log(`[MCP Debug] Successfully set fallback notification handler for ${name}`)
            } catch (error) {
                Logger.error(`[MCP Debug] Error setting notification handlers for ${name}:`, error)
            }

            // Initial fetch of tools, resources, and prompts
            connection.server.tools = await this.fetchToolsList(name)
            connection.server.resources = await this.fetchResourcesList(name)
            connection.server.resourceTemplates = await this.fetchResourceTemplatesList(name)
            connection.server.prompts = await this.fetchPromptsList(name)
        } catch (error) {
            // Update status with error
            const connection = this.findConnection(name, source)
            if (connection) {
                connection.server.status = "disconnected"
                this.appendErrorMessage(connection, describeMcpConnectionError(error))
            }
            throw error
        }
    }

    private appendErrorMessage(connection: McpConnection, error: string) {
        const newError = connection.server.error ? `${connection.server.error}\n${error}` : error
        connection.server.error = newError //.slice(0, 800)
    }

    private async fetchToolsList(serverName: string): Promise<McpTool[]> {
        try {
            const connection = this.connections.find((conn) => conn.server.name === serverName)

            if (!connection) {
                throw new Error(`No connection found for server: ${serverName}`)
            }

            // Disabled servers don't have clients, so return empty tools list
            if (connection.server.disabled || !connection.client) {
                return []
            }

            const response = await connection.client.request({ method: "tools/list" }, ListToolsResultSchema, {
                timeout: DEFAULT_REQUEST_TIMEOUT_MS,
            })

            const settingsPath = await getMcpSettingsFilePathHelper(await this.getSettingsDirectoryPath())
            const content = await fs.readFile(settingsPath, "utf-8")
            const config = JSON.parse(content)
            const isAutoApproved = this.toolAutoApproval(serverName, config.mcpServers[serverName])

            const tools = (response?.tools || []).map((tool) => ({
                ...tool,
                autoApprove: isAutoApproved(tool.name),
            }))

            return tools
        } catch (error) {
            Logger.error(`Failed to fetch tools for ${serverName}:`, error)
            return []
        }
    }

    private async fetchResourcesList(serverName: string): Promise<McpResource[]> {
        try {
            const connection = this.connections.find((conn) => conn.server.name === serverName)

            // Disabled servers don't have clients, so return empty resources list
            if (!connection || connection.server.disabled || !connection.client) {
                return []
            }

            const response = await connection.client.request({ method: "resources/list" }, ListResourcesResultSchema, {
                timeout: DEFAULT_REQUEST_TIMEOUT_MS,
            })
            return response?.resources || []
        } catch (_error) {
            // Logger.error(`Failed to fetch resources for ${serverName}:`, error)
            return []
        }
    }

    private async fetchResourceTemplatesList(serverName: string): Promise<McpResourceTemplate[]> {
        try {
            const connection = this.connections.find((conn) => conn.server.name === serverName)

            // Disabled servers don't have clients, so return empty resource templates list
            if (!connection || connection.server.disabled || !connection.client) {
                return []
            }

            const response = await connection.client.request(
                { method: "resources/templates/list" },
                ListResourceTemplatesResultSchema,
                {
                    timeout: DEFAULT_REQUEST_TIMEOUT_MS,
                },
            )

            return response?.resourceTemplates || []
        } catch (_error) {
            // Logger.error(`Failed to fetch resource templates for ${serverName}:`, error)
            return []
        }
    }

    private async fetchPromptsList(serverName: string): Promise<McpPrompt[]> {
        try {
            const connection = this.connections.find((conn) => conn.server.name === serverName)

            // Disabled servers don't have clients, so return empty prompts list
            if (!connection || connection.server.disabled || !connection.client) {
                return []
            }

            const response = await connection.client.request({ method: "prompts/list" }, ListPromptsResultSchema, {
                timeout: DEFAULT_REQUEST_TIMEOUT_MS,
            })

            return (response?.prompts || []).map((prompt) => ({
                name: prompt.name,
                title: prompt.title,
                description: prompt.description,
                arguments: prompt.arguments?.map((arg) => ({
                    name: arg.name,
                    description: arg.description,
                    required: arg.required,
                })),
            }))
        } catch (_error) {
            return []
        }
    }

    async deleteConnection(name: string): Promise<void> {
        const connection = this.connections.find((conn) => conn.server.name === name)
        if (connection) {
            try {
                // Only close transport and client if they exist (disabled servers don't have them)
                if (connection.transport) {
                    await connection.transport.close()
                }
                if (connection.client) {
                    await connection.client.close()
                }
            } catch (error) {
                Logger.error(`Failed to close transport for ${name}:`, error)
            }
            this.connections = this.connections.filter((conn) => conn.server.name !== name)
        }
    }

    async clearOAuthForConnection(name: string): Promise<void> {
        const connection = this.connections.find((conn) => conn.server.name === name)
        if (connection) {
            try {
                const config = JSON.parse(connection.server.config)
                if (config.url) {
                    await this.authentication.oauth.clearServerAuth(name, config.url)
                }
            } catch (error) {
                Logger.error(`Failed to clear OAuth data for ${name}:`, error)
            }
        }
    }

    async updateServerConnectionsRPC(newServers: Record<string, McpServerConfig>): Promise<void> {
        this.settingsServerConfigs = { ...newServers }
        await this.reconcileServerConnections("rpc")
    }

    async updateServerConnections(newServers: Record<string, McpServerConfig>): Promise<void> {
        this.settingsServerConfigs = { ...newServers }
        await this.reconcileServerConnections("internal")
    }

    private async reconcileServerConnections(source: "rpc" | "internal"): Promise<void> {
        const run = this.reconcileQueue.then(() => this.doReconcileServerConnections(source))
        // Keep the chain alive even if one run fails.
        this.reconcileQueue = run.catch((error) => {
            Logger.error("[McpHub] reconcileServerConnections failed:", error)
        })
        await run
    }

    private async doReconcileServerConnections(source: "rpc" | "internal"): Promise<void> {
        this.isConnecting = true
        this.removeAllFileWatchers()
        const newServers = this.getEffectiveServerConfigs()
        const currentNames = new Set(this.connections.map((conn) => conn.server.name))
        const newNames = new Set(Object.keys(newServers))

        // Track if any connection-level changes occurred (excludes Cline-specific settings)
        let connectionChangesOccurred = false

        try {
            // Delete removed servers. Workspace descriptor removal must not erase local OAuth state.
            for (const name of currentNames) {
                if (!newNames.has(name)) {
                    const connection = this.connections.find((candidate) => candidate.server.name === name)
                    if (connection?.server.source !== "workspace") await this.clearOAuthForConnection(name)
                    await this.deleteConnection(name)
                    Logger.log(`Deleted MCP server: ${name}`)
                    connectionChangesOccurred = true
                }
            }

            // Update or add the effective settings + workspace server set.
            for (const [name, config] of Object.entries(newServers)) {
                if (config.type === "stdio") this.setupFileWatcher(name, config)
                const metadata = this.getConnectionMetadata(name)
                const currentConnection = this.connections.find((conn) => conn.server.name === name)

                if (!currentConnection) {
                    try {
                        await this.connectToServer(name, config, source, metadata)
                        connectionChangesOccurred = true
                    } catch (error) {
                        Logger.error(`Failed to connect to new MCP server ${name}:`, withDiagnosticSite(error, "mcp.connect"))
                    }
                } else if (this.configsRequireRestart(JSON.parse(currentConnection.server.config), config)) {
                    try {
                        currentConnection.server.status = "connecting"
                        currentConnection.server.error = ""
                        if (source === "internal") await this.notifyWebviewOfServerChanges()
                        await this.deleteConnection(name)
                        await this.connectToServer(name, config, source, metadata)
                        Logger.log(`Reconnected MCP server with updated config: ${name}`)
                        connectionChangesOccurred = true
                    } catch (error) {
                        Logger.error(`Failed to reconnect MCP server ${name}:`, withDiagnosticSite(error, "mcp.connect"))
                    }
                } else if (currentConnection.missingVariable !== undefined) {
                    // The user declined a variable for this unchanged config: stay closed instead of
                    // prompting again on every reconcile. Restart or clearing saved values reconnects.
                } else if (currentConnection.server.status === "disconnected") {
                    // Config is unchanged but the connection is down (e.g. the
                    // first connect attempt failed while the server was still
                    // starting). Retry automatically so a transient failure does
                    // not leave the server dead until a manual restart.
                    try {
                        currentConnection.server.status = "connecting"
                        currentConnection.server.error = ""
                        if (source === "internal") await this.notifyWebviewOfServerChanges()
                        await this.deleteConnection(name)
                        await this.connectToServer(name, config, source, metadata)
                        Logger.log(`Reconnected MCP server after disconnect: ${name}`)
                        connectionChangesOccurred = true
                    } catch (error) {
                        Logger.error(`Failed to reconnect MCP server ${name}:`, withDiagnosticSite(error, "mcp.connect"))
                    }
                } else {
                    if (currentConnection.server.tools) {
                        const isAutoApproved = this.toolAutoApproval(name, config)
                        currentConnection.server.tools = currentConnection.server.tools.map((tool) => ({
                            ...tool,
                            autoApprove: isAutoApproved(tool.name),
                        }))
                    }
                    const currentConfig = JSON.parse(currentConnection.server.config)
                    currentConfig.autoApprove = config.autoApprove
                    currentConfig.disabledAutoApprove = config.disabledAutoApprove
                    currentConfig.timeout = config.timeout
                    currentConnection.server.config = JSON.stringify(currentConfig)
                    currentConnection.server.source = metadata?.source
                    currentConnection.server.displayName = metadata?.displayName
                    currentConnection.server.description = metadata?.description
                }
            }

            if (connectionChangesOccurred && source === "internal") {
                await this.notifyWebviewOfServerChanges()
            }
            this.publishPromptCatalogIfChanged()
        } finally {
            this.isConnecting = false
        }
    }

    /**
     * Compares two MCP server configs to determine if a restart is required.
     * Excludes Cline-specific settings since they don't affect the MCP server transport connection.
     *
     * ## Cline-specific settings (don't require restart):
     * - `autoApprove`: legacy tool approval allowlist
     * - `disabledAutoApprove`: tool approval deny-list
     * - `timeout`: request timeout (read at request time, not connection time)
     *
     * ## MCP SDK connection settings (require restart):
     * - `type`, `command`, `args`, `cwd`, `env`, `url`, `headers`, `disabled`
     *
     * ## Adding new Cline-specific settings:
     * When adding a new setting that doesn't require server restart:
     * 1. Add it to the destructuring below to exclude from comparison
     * 2. Add it to `isUpdatingClineSettings` flag usage in the update function
     * 3. Update in-memory state (e.g., `connection.server.config`) in the update function
     * 4. Update the schema in `src/services/mcp/schemas.ts` if needed
     */
    private configsRequireRestart(oldConfig: McpServerConfig, newConfig: McpServerConfig): boolean {
        // Exclude Cline-specific settings from comparison (add new ones here)
        const {
            autoApprove: _oldAutoApprove,
            disabledAutoApprove: _oldDisabledAutoApprove,
            timeout: _oldTimeout,
            remoteConfigured: _oldRemoteConfigured,
            ...oldConnectionConfig
        } = oldConfig
        const {
            autoApprove: _newAutoApprove,
            disabledAutoApprove: _newDisabledAutoApprove,
            timeout: _newTimeout,
            remoteConfigured: _newRemoteConfigured,
            ...newConnectionConfig
        } = newConfig
        return !deepEqual(oldConnectionConfig, newConnectionConfig)
    }

    private setupFileWatcher(name: string, config: Extract<McpServerConfig, { type: "stdio" }>) {
        const filePath = config.args?.find((arg: string) => arg.includes("build/index.js"))
        if (filePath) {
            // we use chokidar instead of onDidSaveTextDocument because it doesn't require the file to be open in the editor. The settings config is better suited for onDidSave since that will be manually updated by the user or Cline (and we want to detect save events, not every file change)
            const watcher = chokidar.watch(filePath, {
                // persistent: true,
                // ignoreInitial: true,
                // awaitWriteFinish: true, // This helps with atomic writes
            })

            watcher.on("change", () => {
                Logger.log(`Detected change in ${filePath}. Restarting server ${name}...`)
                this.restartConnection(name)
            })

            this.fileWatchers.set(name, watcher)
        }
    }

    private removeAllFileWatchers() {
        this.fileWatchers.forEach((watcher) => watcher.close())
        this.fileWatchers.clear()
    }

    private waitingForDlineSubscribed = false

    /** Connect the servers whose variables could not be asked for yet, once a Dline view is first shown. */
    private connectWaitingServersWhenDlineOpens(): void {
        if (this.waitingForDlineSubscribed) return
        this.waitingForDlineSubscribed = true
        dlineUiPresence.onFirstShown(() => {
            void this.connectServersWaitingForDline()
        })
    }

    private async connectServersWaitingForDline(): Promise<void> {
        const waiting = this.connections.filter((connection) => connection.waitingForDline !== undefined)
        for (const connection of waiting) {
            const name = connection.server.name
            try {
                await this.deleteConnection(name)
                await this.connectToServer(
                    name,
                    JSON.parse(connection.server.config),
                    "internal",
                    this.getConnectionMetadata(name),
                )
            } catch (error) {
                Logger.error(`Failed to connect MCP server ${name} after Dline opened:`, withDiagnosticSite(error, "mcp.connect"))
            }
        }
        await this.notifyWebviewOfServerChanges()
        this.publishPromptCatalogIfChanged()
    }

    /** Forget the values saved for this server's `${env:...}` references in its own scope, then reconnect. */
    async clearSavedVariablesRPC(serverName: string): Promise<McpServer[]> {
        const connection = this.connections.find((conn) => conn.server.name === serverName)
        if (!connection) {
            throw new Error(`MCP server ${serverName} not found`)
        }
        // Same owner resolution as connectToServer, so the cleared scope is the one the next connect reads.
        const source = this.getConnectionMetadata(serverName)?.source ?? "settings"
        await getMcpVariableStore().clear({ source, serverName })
        return this.restartConnectionRPC(serverName)
    }

    async restartConnectionRPC(serverName: string): Promise<McpServer[]> {
        this.isConnecting = true

        // Get existing connection and update its status
        const connection = this.connections.find((conn) => conn.server.name === serverName)
        const inMemoryConfig = connection?.server.config
        if (inMemoryConfig) {
            connection.server.status = "connecting"
            connection.server.error = ""
            await setTimeoutPromise(500) // artificial delay to show user that server is restarting
            try {
                await this.deleteConnection(serverName)
                // Try to connect again using existing config
                await this.connectToServer(serverName, JSON.parse(inMemoryConfig), "rpc")
            } catch (error) {
                Logger.error(`Failed to restart connection for ${serverName}:`, error)
            }
        }

        this.isConnecting = false
        this.publishPromptCatalogIfChanged()

        return this.getLatestMcpServersRPC()
    }

    async restartConnection(serverName: string): Promise<void> {
        this.isConnecting = true

        // Get existing connection and update its status
        const connection = this.connections.find((conn) => conn.server.name === serverName)
        const config = connection?.server.config
        if (config) {
            HostProvider.window.showMessage({
                type: ShowMessageType.INFORMATION,
                message: `Restarting ${serverName} MCP server...`,
            })
            connection.server.status = "connecting"
            connection.server.error = ""
            await this.notifyWebviewOfServerChanges()
            await setTimeoutPromise(500) // artificial delay to show user that server is restarting
            try {
                await this.deleteConnection(serverName)
                // Try to connect again using existing config
                await this.connectToServer(serverName, JSON.parse(config), "internal")
                HostProvider.window.showMessage({
                    type: ShowMessageType.INFORMATION,
                    message: `${serverName} MCP server connected`,
                })
            } catch (error) {
                Logger.error(`Failed to restart connection for ${serverName}:`, error)
                HostProvider.window.showMessage({
                    type: ShowMessageType.ERROR,
                    message: `Failed to connect to ${serverName} MCP server`,
                })
            }
        }

        await this.notifyWebviewOfServerChanges()
        this.isConnecting = false
        this.publishPromptCatalogIfChanged()
    }

    /**
     * Gets sorted MCP servers based on the order defined in settings
     * @param serverOrder Array of server names in the order they appear in settings
     * @returns Array of McpServer objects sorted according to settings order
     */
    private getSortedMcpServers(serverOrder: string[]): McpServer[] {
        return [...this.connections]
            .sort((a, b) => {
                const indexA = serverOrder.indexOf(a.server.name)
                const indexB = serverOrder.indexOf(b.server.name)
                if (indexA === indexB) return a.server.name.localeCompare(b.server.name)
                if (indexA < 0) return 1
                if (indexB < 0) return -1
                return indexA - indexB
            })
            .map((connection) => connection.server)
    }

    private getEffectiveServerOrder(): string[] {
        return [
            ...Object.keys(this.settingsServerConfigs),
            ...this.workspaceMcpRegistry.getAllDescriptors().map((descriptor) => descriptor.internalName),
        ]
    }

    private isServerVisibleToOwner(server: McpServer, ownerId: string): boolean {
        if (server.source !== "workspace") return true
        return this.workspaceMcpRegistry
            .getDescriptorsForOwner(ownerId)
            .some((descriptor) => descriptor.internalName === server.name)
    }

    private buildPromptCatalogSignature(): string {
        const entries = this.connections
            .filter((connection) => connection.server.status === "connected" && connection.server.disabled !== true)
            .flatMap((connection) =>
                (connection.server.tools ?? []).map((tool) => ({
                    name: `${connection.server.name}.${tool.name.trim()}`,
                    description: (tool.description ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
                    contractHash: hashStableJson({
                        nativeToolName: nativeMcpToolName(connection.server.uid ?? connection.server.name, tool.name),
                        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
                    }),
                })),
            )
            .filter((entry) => entry.name.length > 0)
            .sort(
                (left, right) =>
                    left.name.localeCompare(right.name) ||
                    left.description.localeCompare(right.description) ||
                    left.contractHash.localeCompare(right.contractHash),
            )
        return JSON.stringify(entries)
    }

    private notifyPromptCatalogChanged(): void {
        for (const listener of this.promptCatalogChangeListeners) {
            try {
                listener()
            } catch (error) {
                Logger.error("[McpHub] Prompt catalog listener failed:", error)
            }
        }
    }

    private publishPromptCatalogIfChanged(): void {
        const signature = this.buildPromptCatalogSignature()
        if (signature === this.promptCatalogSignature) return
        this.promptCatalogSignature = signature
        this.notifyPromptCatalogChanged()
    }

    private async notifyWebviewOfServerChanges(): Promise<void> {
        await sendMcpServersUpdate()
    }

    async sendLatestMcpServers() {
        await this.notifyWebviewOfServerChanges()
    }

    async getLatestMcpServersRPC(ownerId?: string): Promise<McpServer[]> {
        const sortedServers = this.getSortedMcpServers(this.getEffectiveServerOrder())
        return ownerId ? sortedServers.filter((server) => this.isServerVisibleToOwner(server, ownerId)) : sortedServers
    }

    // Using server

    // Public methods for server management

    public async toggleServerDisabledRPC(serverName: string, disabled: boolean): Promise<McpServer[]> {
        try {
            const config = await this.readAndValidateMcpSettingsFile()
            if (!config) {
                throw new Error("Failed to read or validate MCP settings")
            }

            if (config.mcpServers[serverName]) {
                config.mcpServers[serverName].disabled = disabled

                const settingsPath = await getMcpSettingsFilePathHelper(await this.getSettingsDirectoryPath())
                await fs.writeFile(settingsPath, JSON.stringify(config, null, 2))

                const connection = this.connections.find((conn) => conn.server.name === serverName)
                if (connection) {
                    connection.server.disabled = disabled
                    // When enabling a server, set status to "connecting" so UI shows yellow indicator
                    if (!disabled) {
                        connection.server.status = "connecting"
                        connection.server.error = ""
                    }
                }

                this.publishPromptCatalogIfChanged()
                const serverOrder = Object.keys(config.mcpServers || {})
                return this.getSortedMcpServers(serverOrder)
            }
            Logger.error(`Server "${serverName}" not found in MCP configuration`)
            throw new Error(`Server "${serverName}" not found in MCP configuration`)
        } catch (error) {
            Logger.error("Failed to update server disabled state:", error)
            if (error instanceof Error) {
                Logger.error("Error details:", error.message, error.stack)
            }
            HostProvider.window.showMessage({
                type: ShowMessageType.ERROR,
                message: `Failed to update server state: ${error instanceof Error ? error.message : String(error)}`,
            })
            throw error
        }
    }

    async readResource(serverName: string, uri: string): Promise<McpResourceResponse> {
        const connection = this.connections.find((conn) => conn.server.name === serverName)
        if (!connection) {
            throw new Error(`No connection found for server: ${serverName}`)
        }
        if (connection.server.disabled) {
            throw new Error(`Server "${serverName}" is disabled`)
        }

        return await connection.client.request(
            {
                method: "resources/read",
                params: {
                    uri,
                },
            },
            ReadResourceResultSchema,
        )
    }

    async getPrompt(
        serverName: string,
        promptName: string,
        promptArguments?: Record<string, string>,
    ): Promise<McpPromptResponse> {
        const connection = this.connections.find((conn) => conn.server.name === serverName)
        if (!connection) {
            throw new Error(`No connection found for server: ${serverName}`)
        }
        if (connection.server.disabled) {
            throw new Error(`Server "${serverName}" is disabled`)
        }
        if (!connection.client) {
            throw new Error(`No client available for server: ${serverName}`)
        }

        const response = await connection.client.request(
            {
                method: "prompts/get",
                params: {
                    name: promptName,
                    arguments: promptArguments,
                },
            },
            GetPromptResultSchema,
            {
                timeout: DEFAULT_REQUEST_TIMEOUT_MS,
            },
        )

        return {
            description: response.description,
            messages: response.messages.map((msg) => ({
                role: msg.role,
                content: msg.content as McpPromptResponse["messages"][0]["content"],
            })),
        }
    }

    async callTool(
        serverName: string,
        toolName: string,
        toolArguments: Record<string, unknown> | undefined,
        ulid: string,
    ): Promise<McpToolCallResponse> {
        const observation = new McpCallObservation({ taskId: ulid, argumentCount: Object.keys(toolArguments ?? {}).length })
        return observation.run(async () => {
            const connection = this.connections.find((conn) => conn.server.name === serverName)
            if (!connection) {
                throw new Error(
                    `No connection found for server: ${serverName}. Please make sure to use MCP servers available under 'Connected MCP Servers'.`,
                )
            }

            if (connection.server.disabled) {
                throw new Error(`Server "${serverName}" is disabled and cannot be used`)
            }

            let timeout = secondsToMs(DEFAULT_MCP_TIMEOUT_SECONDS)
            observation.setStage("configuration")
            try {
                const config = JSON.parse(connection.server.config)
                const parsedConfig = ServerConfigSchema.parse(config)
                timeout = secondsToMs(parsedConfig.timeout)
            } catch (error) {
                Logger.error(`Failed to parse timeout configuration for server ${serverName}: ${error}`)
            }

            this.telemetryService.captureMcpToolCall(
                ulid,
                serverName,
                toolName,
                "started",
                undefined,
                toolArguments ? Object.keys(toolArguments) : undefined,
            )

            observation.setStage("transport")
            try {
                const result = await connection.client.request(
                    {
                        method: "tools/call",
                        params: {
                            name: toolName,
                            arguments: toolArguments ?? {},
                        },
                    },
                    CallToolResultSchema,
                    { timeout },
                )

                if (result.isError) observation.setStage("remote")
                this.telemetryService.captureMcpToolCall(
                    ulid,
                    serverName,
                    toolName,
                    result.isError ? "error" : "success",
                    result.isError ? "remote_tool_error" : undefined,
                    toolArguments ? Object.keys(toolArguments) : undefined,
                )

                return {
                    ...result,
                    content: result.content ?? [],
                }
            } catch (error) {
                this.telemetryService.captureMcpToolCall(
                    ulid,
                    serverName,
                    toolName,
                    "error",
                    "mcp_transport_error",
                    toolArguments ? Object.keys(toolArguments) : undefined,
                )
                throw error
            }
        })
    }

    /**
     * Turns auto-approve on or off for the given tools of one server.
     * @param serverName The name of the MCP server
     * @param toolNames Array of tool names to toggle auto-approve for
     * @param shouldAllow Whether to enable or disable auto-approve
     * @returns Array of updated MCP servers
     */
    async toggleToolAutoApproveRPC(serverName: string, toolNames: string[], shouldAllow: boolean): Promise<McpServer[]> {
        const descriptor = this.findWorkspaceDescriptor(serverName)
        if (descriptor) {
            await this.toggleWorkspaceToolAutoApprove(descriptor, toolNames, shouldAllow)
            return this.getSortedMcpServers(Object.keys(this.settingsServerConfigs))
        }

        // Set flag to prevent file watcher from triggering during our update
        this.isUpdatingClineSettings = true
        try {
            const settingsPath = await getMcpSettingsFilePathHelper(await this.getSettingsDirectoryPath())
            const content = await fs.readFile(settingsPath, "utf-8")
            const config = JSON.parse(content)

            const connection = this.connections.find((conn) => conn.server.name === serverName)
            const serverConfig = config.mcpServers[serverName]
            const availableToolNames = connection?.server.tools?.map((tool) => tool.name) || toolNames
            const approvalConfig = updateMcpToolAutoApproveConfig(serverConfig, toolNames, shouldAllow, availableToolNames)
            delete serverConfig.autoApprove
            serverConfig.disabledAutoApprove = approvalConfig.disabledAutoApprove

            await fs.writeFile(settingsPath, JSON.stringify(config, null, 2))

            if (connection?.server.tools) {
                connection.server.tools = connection.server.tools.map((tool) => ({
                    ...tool,
                    autoApprove: resolveMcpToolAutoApprove(serverConfig, tool.name),
                }))
            }

            // Return sorted servers without notifying webview
            const serverOrder = Object.keys(config.mcpServers || {})
            return this.getSortedMcpServers(serverOrder)
        } catch (error) {
            Logger.error("Failed to update autoApprove settings:", error)
            throw error // Re-throw to ensure the error is properly handled
        } finally {
            // Clear flag after a delay to ensure file watcher event has been processed
            // The file watcher has a 100ms stabilityThreshold, so we wait a bit longer
            setTimeout(() => {
                this.isUpdatingClineSettings = false
            }, 300)
        }
    }

    /** Records the user's own grant for a workspace server's tools; the descriptor file is never written. */
    private async toggleWorkspaceToolAutoApprove(
        descriptor: WorkspaceMcpDescriptor,
        toolNames: readonly string[],
        shouldAllow: boolean,
    ): Promise<void> {
        const serverName = descriptor.internalName
        await this.workspaceToolApprovals.update(
            serverName,
            workspaceDescriptorFingerprint(descriptor.config),
            toolNames,
            shouldAllow,
        )
        const connection = this.connections.find((conn) => conn.server.name === serverName)
        if (connection?.server.tools) {
            const isAutoApproved = this.toolAutoApproval(serverName, undefined)
            connection.server.tools = connection.server.tools.map((tool) => ({ ...tool, autoApprove: isAutoApproved(tool.name) }))
        }
    }

    public async addRemoteServer(serverName: string, serverUrl: string, transportType = "streamableHttp"): Promise<McpServer[]> {
        try {
            const settings = await this.readAndValidateMcpSettingsFile()
            if (!settings) {
                throw new Error("Failed to read MCP settings")
            }

            if (settings.mcpServers[serverName]) {
                throw new Error(`An MCP server with the name "${serverName}" already exists`)
            }

            const serverConfig = {
                url: serverUrl,
                type: transportType,
                disabled: false,
                disabledAutoApprove: [],
            }

            // Expand environment variables for validation
            const expandedConfig = expandEnvironmentVariables(serverConfig)

            const urlValidation = z.string().url().safeParse(expandedConfig.url)
            if (!urlValidation.success) {
                throw new Error(`Invalid server URL: ${expandedConfig.url}. Please provide a valid URL.`)
            }

            const parsedConfig = ServerConfigSchema.parse(expandedConfig)

            settings.mcpServers[serverName] = parsedConfig
            const settingsPath = await getMcpSettingsFilePathHelper(await this.getSettingsDirectoryPath())

            // We don't write the zod-transformed version to the file.
            // The above parse() call adds the transportType field to the server config
            // It would be fine if this was written, but we don't want to clutter up the file with internal details

            // ToDo: We could benefit from input / output types reflecting the non-transformed / transformed versions
            await fs.writeFile(
                settingsPath,
                JSON.stringify({ mcpServers: { ...settings.mcpServers, [serverName]: serverConfig } }, null, 2),
            )

            await this.updateServerConnectionsRPC(settings.mcpServers)

            const serverOrder = Object.keys(settings.mcpServers || {})
            return this.getSortedMcpServers(serverOrder)
        } catch (error) {
            Logger.error("Failed to add remote MCP server:", error)
            throw error
        }
    }

    /**
     * RPC variant of deleteServer that returns the updated server list directly
     * @param serverName The name of the server to delete
     * @returns Array of remaining MCP servers
     */
    public async deleteServerRPC(serverName: string): Promise<McpServer[]> {
        try {
            // Clear OAuth data BEFORE removing from config (while we still have the connection/URL)
            await this.clearOAuthForConnection(serverName)

            const settingsPath = await getMcpSettingsFilePathHelper(await this.getSettingsDirectoryPath())
            const content = await fs.readFile(settingsPath, "utf-8")
            const config = JSON.parse(content)
            if (!config.mcpServers || typeof config.mcpServers !== "object") {
                config.mcpServers = {}
            }

            if (config.mcpServers[serverName]) {
                delete config.mcpServers[serverName]
                const updatedConfig = {
                    mcpServers: config.mcpServers,
                }
                await fs.writeFile(settingsPath, JSON.stringify(updatedConfig, null, 2))
                await this.updateServerConnectionsRPC(config.mcpServers)

                // Get the servers in their correct order from settings
                const serverOrder = Object.keys(config.mcpServers || {})
                return this.getSortedMcpServers(serverOrder)
            }
            throw new Error(`${serverName} not found in MCP configuration`)
        } catch (error) {
            Logger.error(`Failed to delete MCP server: ${error instanceof Error ? error.message : String(error)}`)
            throw error
        }
    }

    public async updateServerTimeoutRPC(serverName: string, timeout: number): Promise<McpServer[]> {
        // Set flag to prevent file watcher from triggering during our update
        this.isUpdatingClineSettings = true
        try {
            // Validate timeout against schema
            const setConfigResult = BaseConfigSchema.shape.timeout.safeParse(timeout)
            if (!setConfigResult.success) {
                throw new Error(`Invalid timeout value: ${timeout}. Must be at minimum ${MIN_MCP_TIMEOUT_SECONDS} seconds.`)
            }

            const settingsPath = await getMcpSettingsFilePathHelper(await this.getSettingsDirectoryPath())
            const content = await fs.readFile(settingsPath, "utf-8")
            const config = JSON.parse(content)

            if (!config.mcpServers?.[serverName]) {
                throw new Error(`Server "${serverName}" not found in settings`)
            }

            config.mcpServers[serverName] = {
                ...config.mcpServers[serverName],
                timeout,
            }

            await fs.writeFile(settingsPath, JSON.stringify(config, null, 2))

            // Update in-memory config to reflect the new timeout
            const connection = this.connections.find((conn) => conn.server.name === serverName)
            if (connection) {
                const currentConfig = JSON.parse(connection.server.config)
                currentConfig.timeout = timeout
                connection.server.config = JSON.stringify(currentConfig)
            }

            const serverOrder = Object.keys(config.mcpServers || {})
            return this.getSortedMcpServers(serverOrder)
        } catch (error) {
            Logger.error("Failed to update server timeout:", error)
            if (error instanceof Error) {
                Logger.error("Error details:", error.message, error.stack)
            }
            HostProvider.window.showMessage({
                type: ShowMessageType.ERROR,
                message: `Failed to update server timeout: ${error instanceof Error ? error.message : String(error)}`,
            })
            throw error
        } finally {
            // Clear flag after a delay to ensure file watcher event has been processed
            setTimeout(() => {
                this.isUpdatingClineSettings = false
            }, 300)
        }
    }

    /**
     * Get and clear pending notifications
     * @returns Array of pending notifications
     */
    getPendingNotifications(): Array<{
        serverName: string
        level: string
        message: string
        timestamp: number
    }> {
        const notifications = [...this.pendingNotifications]
        this.pendingNotifications = []
        return notifications
    }

    /**
     * Set the notification callback for real-time notifications
     * @param callback Function to call when notifications arrive
     */
    addNotificationCallback(callback: (serverName: string, level: string, message: string) => void): void {
        this.notificationCallbacks.add(callback)
        //Logger.log("[MCP Debug] Notification callback added")
    }

    /**
     * Remove a notification callback (multicast-safe).
     */
    removeNotificationCallback(callback: (serverName: string, level: string, message: string) => void): void {
        this.notificationCallbacks.delete(callback)
        //Logger.log("[MCP Debug] Notification callback removed")
    }

    /** Starts the server's OAuth authorization in the browser; the outcome is reported to the user. */
    initiateOAuth(serverName: string): Promise<void> {
        return this.authentication.initiate(serverName)
    }

    /** Completes an authorization that came back through the URI handler and tells the user the outcome. */
    completeOAuthFromCallback(serverHash: string, code: string, state: string | null): Promise<void> {
        return this.authentication.completeFromCallback(serverHash, code, state)
    }

    async dispose(): Promise<void> {
        McpHub._refCount = Math.max(0, McpHub._refCount - 1)
        // Only tear down MCP connections when all Controllers have released
        if (McpHub._refCount > 0) {
            return
        }
        McpHub._sharedInstance = null
        this.notificationCallbacks.clear()
        this.promptCatalogChangeListeners.clear()
        this.removeAllFileWatchers()
        for (const connection of this.connections) {
            try {
                await this.deleteConnection(connection.server.name)
            } catch (error) {
                Logger.error(`Failed to close connection for ${connection.server.name}:`, error)
            }
        }
        this.connections = []
        if (this.settingsWatcher) {
            await this.settingsWatcher.close()
        }
        await this.workspaceMcpRegistry.dispose()
        await this.authentication.dispose()
    }
}
