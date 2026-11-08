import { EmptyRequest } from "@shared/proto/dline/common"
import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { CapabilityRichText } from "@/components/agent-capabilities/CapabilityRichText"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { McpServiceClient } from "@/services/grpc-client"
import ServersToggleList from "./ServersToggleList"

const ConfigureServersView = () => {
    const { t } = useUiTranslation()
    const { mcpServers: servers, navigateToSettings, remoteConfigSettings } = useExtensionState()

    // Check if there are remote MCP servers configured
    const hasRemoteMCPServers = remoteConfigSettings?.remoteMCPServers && remoteConfigSettings.remoteMCPServers.length > 0

    return (
        <div style={{ padding: "16px 20px" }}>
            <div
                style={{
                    color: "var(--vscode-foreground)",
                    fontSize: "13px",
                    marginBottom: "16px",
                    marginTop: "5px",
                }}>
                <CapabilityRichText
                    parts={[
                        {
                            name: "protocol",
                            node: (
                                <VSCodeLink href="https://github.com/modelcontextprotocol" style={{ display: "inline" }}>
                                    Model Context Protocol
                                </VSCodeLink>
                            ),
                        },
                        {
                            name: "community",
                            node: (
                                <VSCodeLink href="https://github.com/modelcontextprotocol/servers" style={{ display: "inline" }}>
                                    {t("capabilities.mcp.communityServers")}
                                </VSCodeLink>
                            ),
                        },
                        { name: "example", node: <span>{t("capabilities.mcp.exampleTool")}</span> },
                    ]}
                    render={(slot) =>
                        t("capabilities.mcp.configureHelp", {
                            protocol: slot("protocol"),
                            community: slot("community"),
                            example: slot("example"),
                        })
                    }
                />{" "}
                <VSCodeLink href="https://x.com/sdrzn/status/1867271665086074969" style={{ display: "inline" }}>
                    {t("capabilities.mcp.demo")}
                </VSCodeLink>
            </div>

            {/* Remote config banner */}
            {hasRemoteMCPServers && (
                <div className="flex items-center gap-2 px-5 py-3 mb-4 bg-vscode-textBlockQuote-background border-l-[3px] border-vscode-textLink-foreground">
                    <i className="codicon codicon-lock text-sm" />
                    <span className="text-base">{t("capabilities.mcp.managed")}</span>
                </div>
            )}

            <ServersToggleList hasTrashIcon={false} isExpandable={true} servers={servers} />

            {/* Settings Section */}
            <div style={{ marginBottom: "20px", marginTop: 10 }}>
                <VSCodeButton
                    appearance="secondary"
                    aria-label={t("capabilities.mcp.configureServers")}
                    onClick={() => {
                        McpServiceClient.openMcpSettings(EmptyRequest.create({})).catch((error) => {
                            console.error("Error opening MCP settings:", error)
                        })
                    }}
                    style={{ width: "100%", marginBottom: "5px" }}>
                    <span aria-hidden="true" className="codicon codicon-server" style={{ marginRight: "6px" }} />
                    {t("capabilities.mcp.configureServers")}
                </VSCodeButton>

                <div style={{ textAlign: "center" }}>
                    <VSCodeLink onClick={() => navigateToSettings("features")} style={{ fontSize: "12px" }}>
                        {t("capabilities.mcp.advanced")}
                    </VSCodeLink>
                </div>
            </div>
        </div>
    )
}

export default ConfigureServersView
