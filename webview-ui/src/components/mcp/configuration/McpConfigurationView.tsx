import { McpViewTab } from "@shared/mcp"
import { EmptyRequest } from "@shared/proto/dline/common"
import { McpServers } from "@shared/proto/dline/mcp"
import { convertProtoMcpServersToMcpServers } from "@shared/proto-conversions/mcp/mcp-server-conversion"
import { useEffect, useState } from "react"
import styled from "styled-components"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { McpServiceClient } from "@/services/grpc-client"
import { Tab, TabContent } from "../../common/Tab"
import ViewHeader from "../../common/ViewHeader"
import AddRemoteServerForm from "./tabs/add-server/AddRemoteServerForm"
import ConfigureServersView from "./tabs/installed/ConfigureServersView"
import McpMarketplaceView from "./tabs/marketplace/McpMarketplaceView"

type McpViewProps = {
    onDone: () => void
    initialTab?: McpViewTab
}

const McpConfigurationView = ({ onDone, initialTab }: McpViewProps) => {
    const { remoteConfigSettings, setMcpServers, environment } = useExtensionState()
    // Show marketplace by default unless remote config explicitly disables it
    const showMarketplace = remoteConfigSettings?.mcpMarketplaceEnabled !== false
    const showRemoteServers = remoteConfigSettings?.blockPersonalRemoteMCPServers !== true
    const [activeTab, setActiveTab] = useState<McpViewTab>(initialTab || (showMarketplace ? "marketplace" : "configure"))

    const handleTabChange = (tab: McpViewTab) => {
        setActiveTab(tab)
    }

    useEffect(() => {
        if (!showMarketplace && activeTab === "marketplace") {
            // If marketplace is disabled by remote config and we're on marketplace tab, switch to configure
            setActiveTab("configure")
        }
        if (!showRemoteServers && activeTab === "addRemote") {
            setActiveTab("configure")
        }
    }, [showMarketplace, showRemoteServers, activeTab])

    useEffect(() => {
        // The marketplace catalog is owned by McpMarketplaceView; this view only loads the
        // installed servers that every tab depends on.
        McpServiceClient.getLatestMcpServers(EmptyRequest.create({}))
            .then((response: McpServers) => {
                if (response.mcpServers) {
                    setMcpServers(convertProtoMcpServersToMcpServers(response.mcpServers))
                }
            })
            .catch((error) => {
                console.error("Failed to fetch MCP servers:", error)
            })
    }, [setMcpServers])

    return (
        <Tab>
            <ViewHeader environment={environment} onDone={onDone} title="MCP Servers" />

            {/* Tabs container stays outside the scroll area so it does not scroll away */}
            <div
                className="shrink-0"
                style={{
                    display: "flex",
                    gap: "1px",
                    padding: "0 20px 0 20px",
                    borderBottom: "1px solid var(--vscode-panel-border)",
                }}>
                {showMarketplace && (
                    <TabButton isActive={activeTab === "marketplace"} onClick={() => handleTabChange("marketplace")}>
                        Marketplace
                    </TabButton>
                )}
                {showRemoteServers && (
                    <TabButton isActive={activeTab === "addRemote"} onClick={() => handleTabChange("addRemote")}>
                        Remote Servers
                    </TabButton>
                )}
                <TabButton isActive={activeTab === "configure"} onClick={() => handleTabChange("configure")}>
                    Configure
                </TabButton>
            </div>

            {/* Single scroll container for the active tab content */}
            <TabContent className="w-full">
                {showMarketplace && activeTab === "marketplace" && <McpMarketplaceView />}
                {showRemoteServers && activeTab === "addRemote" && (
                    <AddRemoteServerForm onServerAdded={() => handleTabChange("configure")} />
                )}
                {activeTab === "configure" && <ConfigureServersView />}
            </TabContent>
        </Tab>
    )
}

const StyledTabButton = styled.button.withConfig({
    shouldForwardProp: (prop) => !["isActive"].includes(prop),
})<{ isActive: boolean; disabled?: boolean }>`
	background: none;
	border: none;
	border-bottom: 2px solid ${(props) => (props.isActive ? "var(--vscode-foreground)" : "transparent")};
	color: ${(props) => (props.isActive ? "var(--vscode-foreground)" : "var(--vscode-descriptionForeground)")};
	padding: 8px 16px;
	cursor: ${(props) => (props.disabled ? "not-allowed" : "pointer")};
	font-size: 13px;
	margin-bottom: -1px;
	font-family: inherit;
	opacity: ${(props) => (props.disabled ? 0.6 : 1)};
	pointer-events: ${(props) => (props.disabled ? "none" : "auto")};

	&:hover {
		color: ${(props) => (props.disabled ? "var(--vscode-descriptionForeground)" : "var(--vscode-foreground)")};
	}
`

export const TabButton = ({
    children,
    isActive,
    onClick,
    disabled,
    style,
}: {
    children: React.ReactNode
    isActive: boolean
    onClick: () => void
    disabled?: boolean
    style?: React.CSSProperties
}) => (
    <StyledTabButton disabled={disabled} isActive={isActive} onClick={onClick} style={style}>
        {children}
    </StyledTabButton>
)

export default McpConfigurationView
