import { EmptyRequest } from "@shared/proto/dline/common"
import { McpServers, ToggleMcpServerRequest } from "@shared/proto/dline/mcp"
import { convertProtoMcpServersToMcpServers } from "@shared/proto-conversions/mcp/mcp-server-conversion"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import React, { useEffect, useRef, useState } from "react"
import { useClickAway, useWindowSize } from "react-use"
import PopupModalContainer from "@/components/common/PopupModalContainer"
import ServersToggleList from "@/components/mcp/configuration/tabs/installed/ServersToggleList"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useTaskCapabilityToggles } from "@/hooks/useTaskCapabilityToggles"
import { McpServiceClient } from "@/services/grpc-client"

const ServersToggleModal: React.FC = () => {
    const { mcpEnabled, mcpServers, navigateToMcp, setMcpServers } = useExtensionState()
    const capabilityScope = useTaskCapabilityToggles()
    const [isVisible, setIsVisible] = useState(false)
    const buttonRef = useRef<HTMLDivElement>(null)
    const modalRef = useRef<HTMLDivElement>(null)
    const { width: viewportWidth, height: viewportHeight } = useWindowSize()
    const [arrowPosition, setArrowPosition] = useState(0)
    const [menuPosition, setMenuPosition] = useState(0)
    const toggleServer = (serverName: string, enabled: boolean) => {
        McpServiceClient.toggleMcpServer(
            ToggleMcpServerRequest.create({
                serverName,
                disabled: !enabled,
            }),
        )
            .then((response) => setMcpServers(convertProtoMcpServersToMcpServers(response.mcpServers)))
            .catch((error) => console.error("Failed to toggle MCP server:", error))
    }

    useEffect(() => {
        if (isVisible) {
            McpServiceClient.getLatestMcpServers(EmptyRequest.create({}))
                .then((response: McpServers) => {
                    if (response.mcpServers) {
                        const mcpServers = convertProtoMcpServersToMcpServers(response.mcpServers)
                        setMcpServers(mcpServers)
                        void capabilityScope.reconcile({
                            mcpServers: Object.fromEntries(mcpServers.map((server) => [server.name, server.disabled !== true])),
                        })
                    }
                })
                .catch((error) => {
                    console.error("Failed to fetch MCP servers:", error)
                })
        }
    }, [isVisible, setMcpServers, capabilityScope.reconcile])

    // Close modal when clicking outside
    useClickAway(modalRef, () => {
        setIsVisible(false)
    })

    // Calculate positions for modal and arrow
    useEffect(() => {
        if (isVisible && buttonRef.current) {
            const buttonRect = buttonRef.current.getBoundingClientRect()
            const buttonCenter = buttonRect.left + buttonRect.width / 2
            const rightPosition = document.documentElement.clientWidth - buttonCenter - 5

            setArrowPosition(rightPosition)
            setMenuPosition(buttonRect.top + 1)
        }
    }, [isVisible])

    if (mcpEnabled === false) {
        return null
    }

    return (
        <div className="inline-flex min-w-0 max-w-full shrink-0 items-center" ref={modalRef}>
            <div className="inline-flex w-full items-center" ref={buttonRef}>
                <Tooltip>
                    {!isVisible && <TooltipContent>Manage MCP Servers</TooltipContent>}
                    <TooltipTrigger asChild>
                        <button
                            aria-label={isVisible ? "Hide MCP Servers" : "Show MCP Servers"}
                            className="chat-input-control-outline inline-flex size-[18.5px] shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-foreground shadow-none transition-colors duration-150 hover:bg-toolbar-hover focus-visible:bg-toolbar-hover"
                            onClick={() => setIsVisible(!isVisible)}
                            type="button">
                            <i className="codicon codicon-server" style={{ fontSize: "12.5px" }} />
                        </button>
                    </TooltipTrigger>
                </Tooltip>
            </div>

            {isVisible && (
                <PopupModalContainer $arrowPosition={arrowPosition} $menuPosition={menuPosition}>
                    <div className="flex-shrink-0 px-3 pt-2">
                        <div className="flex justify-between items-center mb-2.5">
                            <div className="m-0 text-sm font-medium">MCP Servers</div>
                            <VSCodeButton
                                appearance="icon"
                                aria-label="Go to MCP server settings"
                                onClick={() => {
                                    setIsVisible(false)
                                    navigateToMcp("configure")
                                }}>
                                <span className="codicon codicon-gear text-[10px]" />
                            </VSCodeButton>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto px-3 pb-3" style={{ minHeight: 0 }}>
                        <ServersToggleList
                            getServerEnabled={
                                capabilityScope.isTaskScoped
                                    ? (server) => capabilityScope.snapshot?.mcpServers[server.name] === true
                                    : undefined
                            }
                            hasTrashIcon={false}
                            isExpandable={false}
                            listGap="small"
                            onToggleServer={
                                capabilityScope.isTaskScoped
                                    ? (server, enabled) => {
                                          void capabilityScope.updateToggle("mcpServers", server.name, enabled)
                                      }
                                    : (server, enabled) => toggleServer(server.name, enabled)
                            }
                            servers={mcpServers}
                        />
                    </div>
                </PopupModalContainer>
            )}
        </div>
    )
}

export default ServersToggleModal
