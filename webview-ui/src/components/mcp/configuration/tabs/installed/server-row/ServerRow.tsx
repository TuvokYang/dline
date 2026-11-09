import { DEFAULT_MCP_TIMEOUT_SECONDS, McpServer } from "@shared/mcp"
import { StringRequest } from "@shared/proto/dline/common"
import {
    McpServers,
    ToggleMcpServerRequest,
    ToggleToolAutoApproveRequest,
    UpdateMcpTimeoutRequest,
} from "@shared/proto/dline/mcp"
import { convertProtoMcpServersToMcpServers } from "@shared/proto-conversions/mcp/mcp-server-conversion"
import { VSCodeCheckbox, VSCodePanels, VSCodePanelTab, VSCodePanelView } from "@vscode/webview-ui-toolkit/react"
import { KeyRoundIcon, RefreshCcwIcon, Trash2Icon } from "lucide-react"
import { type FormEvent, useState } from "react"
import { LocalizedDropdown, LocalizedOption } from "@/components/common/LocalizedDropdown"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { cn } from "@/lib/utils"
import { McpServiceClient } from "@/services/grpc-client"
import { getMcpServerDisplayName } from "@/utils/mcp"
import McpPromptRow from "./McpPromptRow"
import McpResourceRow from "./McpResourceRow"
import McpToolRow from "./McpToolRow"

const TIMEOUT_OPTIONS = [
    { value: "30", labelKey: "capabilities.mcp.timeout.30" },
    { value: "60", labelKey: "capabilities.mcp.timeout.60" },
    { value: "300", labelKey: "capabilities.mcp.timeout.300" },
    { value: "600", labelKey: "capabilities.mcp.timeout.600" },
    { value: "1800", labelKey: "capabilities.mcp.timeout.1800" },
    { value: "3600", labelKey: "capabilities.mcp.timeout.3600" },
] as const

const ServerRow = ({
    server,
    isExpandable = true,
    hasTrashIcon = true,
    enabled,
    onToggleEnabled,
}: {
    server: McpServer
    isExpandable?: boolean
    hasTrashIcon?: boolean
    enabled?: boolean
    onToggleEnabled?: (enabled: boolean) => void
}) => {
    const { t } = useUiTranslation()
    const { mcpMarketplaceCatalog, setMcpServers, remoteConfigSettings } = useExtensionState()

    const [isExpanded, setIsExpanded] = useState(false)
    const [isDeleting, setIsDeleting] = useState(false)
    const [isRestarting, setIsRestarting] = useState(false)
    const [isClearingVariables, setIsClearingVariables] = useState(false)
    const isServerEnabled = enabled ?? !server.disabled
    const isWorkspaceServer = server.source === "workspace"
    const serverDisplayName = server.displayName ?? getMcpServerDisplayName(server.name, mcpMarketplaceCatalog)
    // Only servers that reference ${env:...} can have saved variable values to clear.
    const hasEnvironmentReferences = server.config.includes("${env:")

    // Check if user is managed by remote config and if this server is remote-managed.
    // Remote MCP servers from enterprise config are always URL-based (SSE/HTTP).
    // stdio-based local servers are never in remoteMCPServers, so URL matching is sufficient.
    const isRemoteManagedServer = (() => {
        const remoteMCPServers = remoteConfigSettings?.remoteMCPServers
        if (!remoteMCPServers || remoteMCPServers.length === 0) {
            return false
        }
        try {
            const serverConfig = JSON.parse(server.config)
            return remoteMCPServers.some(
                (remoteServer: { url: string }) => serverConfig.url && serverConfig.url === remoteServer.url,
            )
        } catch {
            return false
        }
    })()

    const handleRowClick = () => {
        if (!server.error && isExpandable) {
            setIsExpanded(!isExpanded)
        }
    }

    const [timeoutValue, setTimeoutValue] = useState<string>(() => {
        try {
            const config = JSON.parse(server.config)
            return config.timeout?.toString() || DEFAULT_MCP_TIMEOUT_SECONDS.toString()
        } catch {
            return DEFAULT_MCP_TIMEOUT_SECONDS.toString()
        }
    })

    const selectedTimeout = TIMEOUT_OPTIONS.find((option) => option.value === timeoutValue)

    const handleTimeoutChange = (event: Event | FormEvent<HTMLElement>) => {
        const select = event.target as HTMLSelectElement
        const value = select.value
        const num = Number.parseInt(value, 10)
        setTimeoutValue(value)

        McpServiceClient.updateMcpTimeout({
            serverName: server.name,
            timeout: num,
        } as UpdateMcpTimeoutRequest)
            .then((response: McpServers) => {
                const mcpServers = convertProtoMcpServersToMcpServers(response.mcpServers)
                setMcpServers(mcpServers)
            })
            .catch((error) => {
                console.error("Error updating MCP server timeout", error)
            })
    }

    const handleRestart = () => {
        // Set local state to show "connecting" status
        setIsRestarting(true)

        // Make the gRPC call
        McpServiceClient.restartMcpServer({
            value: server.name,
        } as StringRequest)
            .then((response: McpServers) => {
                // Update with the final state from the server
                const mcpServers = convertProtoMcpServersToMcpServers(response.mcpServers)
                setMcpServers(mcpServers)
                setIsRestarting(false)
            })
            .catch((error) => {
                // Reset the restarting state
                setIsRestarting(false)
                console.error("Error restarting MCP server", error)
            })
    }

    const handleClearVariables = () => {
        setIsClearingVariables(true)
        McpServiceClient.clearMcpServerVariables({
            value: server.name,
        } as StringRequest)
            .then((response: McpServers) => {
                setMcpServers(convertProtoMcpServersToMcpServers(response.mcpServers))
                setIsClearingVariables(false)
            })
            .catch((error) => {
                setIsClearingVariables(false)
                console.error("Error clearing MCP server variables", error)
            })
    }

    const clearVariablesButton = (className: string) => (
        <Button
            className={className}
            disabled={server.status === "connecting" || isRestarting || isClearingVariables}
            onClick={(e) => {
                e.stopPropagation()
                handleClearVariables()
            }}
            title={t("capabilities.mcp.forgetVariables")}
            variant="secondary">
            {t(isClearingVariables ? "capabilities.mcp.clearing" : "capabilities.mcp.clearVariables")}
        </Button>
    )

    const handleDelete = () => {
        setIsDeleting(true)
        McpServiceClient.deleteMcpServer({
            value: server.name,
        } as StringRequest)
            .then((response: McpServers) => {
                const mcpServers = convertProtoMcpServersToMcpServers(response.mcpServers)
                setMcpServers(mcpServers)
                setIsDeleting(false)
            })
            .catch((error) => {
                console.error("Error deleting MCP server", error)
                setIsDeleting(false)
            })
    }

    const handleAutoApproveChange = () => {
        if (!server.name) {
            return
        }

        McpServiceClient.toggleToolAutoApprove(
            ToggleToolAutoApproveRequest.create({
                serverName: server.name,
                toolNames: server.tools?.map((tool) => tool.name) || [],
                autoApprove: !server.tools?.every((tool) => tool.autoApprove ?? true),
            }),
        )
            .then((response) => {
                const mcpServers = convertProtoMcpServersToMcpServers(response.mcpServers)
                setMcpServers(mcpServers)
            })
            .catch((error) => {
                console.error("Error toggling all tools auto-approve", error)
            })
    }

    const handleToggleMcpServer = () => {
        if (onToggleEnabled) {
            onToggleEnabled(!isServerEnabled)
            return
        }
        McpServiceClient.toggleMcpServer(
            ToggleMcpServerRequest.create({
                serverName: server.name,
                disabled: !server.disabled,
            }),
        )
            .then((response) => {
                const mcpServers = convertProtoMcpServersToMcpServers(response.mcpServers)
                setMcpServers(mcpServers)
            })
            .catch((error) => {
                console.error("Error toggling MCP server", error)
            })
    }

    // Helper to extract server URL from config
    const getServerUrl = (server: McpServer): string | null => {
        try {
            const config = JSON.parse(server.config)
            return config.url || null
        } catch {
            return null
        }
    }

    // Check if this server is always-enabled via remote config
    const isAlwaysEnabled = (() => {
        const remoteMCPServers = remoteConfigSettings?.remoteMCPServers || []
        const serverUrl = getServerUrl(server)
        if (!serverUrl) return false

        const remoteServer = remoteMCPServers.find((remote) => remote.url === serverUrl)
        return remoteServer?.alwaysEnabled === true
    })()

    return (
        <div className="mb-2.5">
            <div
                className={cn("flex bg-code-block-background p-2 gap-4 items-center", {
                    "cursor-pointer": !server.error && isExpandable,
                })}
                onClick={handleRowClick}>
                {!server.error && isExpandable && (
                    <span
                        className={cn("mr-2 codicon", {
                            "codicon-chevron-right": !isExpanded,
                            "codicon-chevron-down": isExpanded,
                        })}
                    />
                )}
                <span className="flex-1 overflow-hidden break-all whitespace-normal flex items-center">{serverDisplayName}</span>
                {/* Collapsed view controls */}
                {/* On the row itself, so clearing a wrong saved value does not depend on expanding the server first. */}
                {hasEnvironmentReferences && (
                    <Button
                        aria-label={t("capabilities.mcp.clearVariables")}
                        disabled={server.status === "connecting" || isRestarting || isClearingVariables}
                        onClick={(e) => {
                            e.stopPropagation()
                            handleClearVariables()
                        }}
                        size="icon"
                        title={t("capabilities.mcp.clearVariables")}
                        variant="icon">
                        <KeyRoundIcon />
                    </Button>
                )}
                {!server.error && (
                    <Button
                        aria-label={t("capabilities.mcp.restart")}
                        disabled={server.status === "connecting" || isRestarting || !isServerEnabled}
                        onClick={(e) => {
                            e.stopPropagation()
                            handleRestart()
                        }}
                        size="icon"
                        title={t("capabilities.mcp.restart")}
                        variant="icon">
                        <RefreshCcwIcon />
                    </Button>
                )}
                {!server.error && hasTrashIcon && !isWorkspaceServer && (
                    <Button
                        aria-label={t("capabilities.mcp.delete")}
                        disabled={isDeleting}
                        onClick={(e) => {
                            e.stopPropagation()
                            handleDelete()
                        }}
                        size="icon"
                        title={t("capabilities.mcp.delete")}
                        variant="icon">
                        <Trash2Icon />
                    </Button>
                )}
                {/* Toggle Switch: every server, including workspace descriptor servers, is switched for
                    the current workspace; a task can still switch a server off for itself. */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <div className="flex items-center gap-2">
                            <Switch
                                aria-label={t("capabilities.mcp.enable", { name: serverDisplayName })}
                                checked={isServerEnabled}
                                disabled={isAlwaysEnabled}
                                key={server.name}
                                onClick={(e) => {
                                    e.stopPropagation()
                                    handleToggleMcpServer()
                                }}
                            />
                            {isAlwaysEnabled && <i className="codicon codicon-lock text-description text-sm" />}
                        </div>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs" hidden={!isAlwaysEnabled} side="top">
                        {t("capabilities.mcp.required")}
                    </TooltipContent>
                </Tooltip>
                <div
                    className={cn("h-2 w-2 ml-0.5 rounded-full", {
                        "bg-success": server.status === "connected",
                        "bg-warning": server.status === "connecting",
                        "bg-error": server.status === "disconnected",
                    })}
                />
            </div>

            {server.error ? (
                <div className="text-sm bg-text-block-background rounded-b-sm">
                    <div className="text-failed-icon mb-2 px-2.5 break-words" role="alert">
                        {t("capabilities.mcp.connectionError")}
                        <details>
                            <summary>{t("capabilities.diagnostics")}</summary>
                            {server.error}
                        </details>
                    </div>
                    {server.oauthRequired &&
                        (server.oauthAuthStatus === "unauthenticated" ||
                            server.oauthAuthStatus === "reauthentication-required") && (
                            <Button
                                className="m-2.5 mt-0 max-w-[calc(100%-20px)]"
                                onClick={(e) => {
                                    e.stopPropagation()
                                    void McpServiceClient.authenticateMcpServer(
                                        StringRequest.create({ value: server.name }),
                                    ).catch((error) => console.error("Error authorizing MCP server", error))
                                }}
                                variant="default">
                                {t(
                                    server.oauthAuthStatus === "reauthentication-required"
                                        ? "capabilities.mcp.reauthorize"
                                        : "capabilities.mcp.authenticate",
                                )}
                            </Button>
                        )}
                    {/* Authentication state can outlive the server that asked for it, so retrying stays available. */}
                    <Button
                        className="m-2.5 mt-0 max-w-[calc(100%-20px)]"
                        disabled={server.status === "connecting" || isRestarting}
                        onClick={handleRestart}
                        variant="secondary">
                        {t(
                            server.status === "connecting" || isRestarting
                                ? "capabilities.mcp.retrying"
                                : "capabilities.mcp.retryConnection",
                        )}
                    </Button>

                    {hasEnvironmentReferences && clearVariablesButton("m-2.5 mt-0 max-w-[calc(100%-20px)]")}

                    {!isRemoteManagedServer && !isWorkspaceServer && (
                        <Button
                            className="m-2.5 mt-0 max-w-[calc(100%-20px)]"
                            disabled={isDeleting}
                            onClick={handleDelete}
                            variant="danger">
                            {t(isDeleting ? "capabilities.mcp.deleting" : "capabilities.mcp.delete")}
                        </Button>
                    )}
                </div>
            ) : (
                isExpanded && (
                    <div className="bg-text-block-background p-2.5 pt-0 text-sm rounded-b-sm">
                        <VSCodePanels>
                            <VSCodePanelTab id="tools">
                                {t("capabilities.mcp.toolsCount", { count: server.tools?.length || 0 })}
                            </VSCodePanelTab>
                            <VSCodePanelTab id="resources">
                                {t("capabilities.mcp.resourcesCount", {
                                    count: [...(server.resourceTemplates || []), ...(server.resources || [])].length,
                                })}
                            </VSCodePanelTab>
                            <VSCodePanelTab id="prompts">
                                {t("capabilities.mcp.promptsCount", { count: server.prompts?.length || 0 })}
                            </VSCodePanelTab>

                            <VSCodePanelView id="tools-view">
                                {server.tools && server.tools.length > 0 ? (
                                    <div className="flex flex-col gap-2 w-full pt-2">
                                        {/* Workspace servers get the same checkboxes; their grants are the user's own and stay in this workspace's settings. */}
                                        {server.name && (
                                            <VSCodeCheckbox
                                                checked={server.tools.every((tool) => tool.autoApprove ?? true)}
                                                className="mb-1 text-xs"
                                                data-tool="all-tools"
                                                onChange={handleAutoApproveChange}>
                                                {t("capabilities.mcp.autoApproveAll")}
                                            </VSCodeCheckbox>
                                        )}
                                        {server.tools.map((tool) => (
                                            <McpToolRow key={tool.name} serverName={server.name} tool={tool} />
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-description py-2.5">{t("capabilities.mcp.noTools")}</div>
                                )}
                            </VSCodePanelView>

                            <VSCodePanelView id="resources-view">
                                {(server.resources && server.resources.length > 0) ||
                                (server.resourceTemplates && server.resourceTemplates.length > 0) ? (
                                    <div className="flex flex-col gap-2 w-full pt-2">
                                        {[...(server.resourceTemplates || []), ...(server.resources || [])].map((item) => (
                                            <McpResourceRow
                                                item={item}
                                                key={"uriTemplate" in item ? item.uriTemplate : item.uri}
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <div className="py-2.5 text-description">{t("capabilities.mcp.noResources")}</div>
                                )}
                            </VSCodePanelView>

                            <VSCodePanelView id="prompts-view">
                                {server.prompts && server.prompts.length > 0 ? (
                                    <div
                                        style={{
                                            display: "flex",
                                            flexDirection: "column",
                                            gap: "8px",
                                            width: "100%",
                                            paddingTop: "8px",
                                        }}>
                                        {server.prompts.map((prompt) => (
                                            <McpPromptRow key={prompt.name} prompt={prompt} serverName={server.name} />
                                        ))}
                                    </div>
                                ) : (
                                    <div
                                        style={{
                                            padding: "10px 0",
                                            color: "var(--vscode-descriptionForeground)",
                                        }}>
                                        {t("capabilities.mcp.noPrompts")}
                                    </div>
                                )}
                            </VSCodePanelView>
                        </VSCodePanels>

                        {!isWorkspaceServer && (
                            <div className="my-2.5 mx-1.5">
                                <label className="block mb-1 text-[13px]">{t("capabilities.mcp.requestTimeout")}</label>
                                <LocalizedDropdown
                                    aria-label={t("capabilities.mcp.requestTimeout")}
                                    className="w-full"
                                    onChange={handleTimeoutChange}
                                    selectedLabel={selectedTimeout === undefined ? undefined : t(selectedTimeout.labelKey)}
                                    value={timeoutValue}>
                                    {TIMEOUT_OPTIONS.map((option) => (
                                        <LocalizedOption key={option.value} label={t(option.labelKey)} value={option.value} />
                                    ))}
                                </LocalizedDropdown>
                            </div>
                        )}
                        <Button
                            className="w-[calc(100%-14px)] mt-1 mx-1.5 mb-3"
                            disabled={server.status === "connecting" || isRestarting}
                            onClick={handleRestart}
                            variant="secondary">
                            {t(
                                server.status === "connecting" || isRestarting
                                    ? "capabilities.mcp.restarting"
                                    : "capabilities.mcp.restart",
                            )}
                        </Button>

                        {hasEnvironmentReferences && clearVariablesButton("w-[calc(100%-14px)] mt-1 mx-1.5 mb-3")}

                        {!isRemoteManagedServer && !isWorkspaceServer && (
                            <Button
                                className="w-[calc(100%-14px)] mt-1 mx-1.5 mb-3"
                                disabled={isDeleting}
                                onClick={handleDelete}
                                variant="danger">
                                {t(isDeleting ? "capabilities.mcp.deleting" : "capabilities.mcp.delete")}
                            </Button>
                        )}
                    </div>
                )
            )}
        </div>
    )
}

export default ServerRow
