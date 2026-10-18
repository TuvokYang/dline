import { isFeatureSettingActive } from "@shared/ClineFeatureSetting"
import { HistoryIcon, PlusIcon, SettingsIcon, UserCircleIcon } from "lucide-react"
import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TaskServiceClient } from "@/services/grpc-client"
import { useExtensionState } from "../../context/ExtensionStateContext"

// Custom MCP Server Icon component using VSCode codicon
const McpServerIcon = ({ className, size }: { className?: string; size?: number }) => (
    <span
        className={`codicon codicon-server flex items-center ${className || ""}`}
        style={{ fontSize: size ? `${size}px` : "12.5px", marginBottom: "1px" }}
    />
)

export const Navbar = () => {
    const { navigateToHistory, navigateToSettings, navigateToAccount, navigateToMcp, navigateToChat, accountEnabled } =
        useExtensionState()
    const accountActive = isFeatureSettingActive(accountEnabled)

    const SETTINGS_TABS = useMemo(
        () => [
            {
                id: "chat",
                name: "Chat",
                tooltip: "New Task",
                icon: PlusIcon,
                navigate: () => {
                    // Navigate first: the backend detaches the task and pushes the new
                    // state on its own, so waiting for the RPC only delays the view.
                    navigateToChat()
                    TaskServiceClient.clearTask({}).catch((error) => {
                        console.error("Failed to clear task:", error)
                    })
                },
            },
            {
                id: "mcp",
                name: "MCP",
                tooltip: "MCP Servers",
                icon: McpServerIcon,
                navigate: navigateToMcp,
            },
            {
                id: "history",
                name: "History",
                tooltip: "History",
                icon: HistoryIcon,
                navigate: navigateToHistory,
            },
            ...(accountActive
                ? [
                      {
                          id: "account",
                          name: "Account",
                          tooltip: "Account",
                          icon: UserCircleIcon,
                          navigate: navigateToAccount,
                      },
                  ]
                : []),
            {
                id: "settings",
                name: "Settings",
                tooltip: "Settings",
                icon: SettingsIcon,
                navigate: navigateToSettings,
            },
        ],
        [accountActive, navigateToAccount, navigateToChat, navigateToHistory, navigateToMcp, navigateToSettings],
    )

    return (
        <nav
            className="flex-none inline-flex justify-end bg-transparent gap-2 mb-1 z-10 border-none items-center mr-4!"
            id="cline-navbar-container">
            {SETTINGS_TABS.map((tab) => (
                <Tooltip key={`navbar-tooltip-${tab.id}`}>
                    <TooltipContent side="bottom">{tab.tooltip}</TooltipContent>
                    <TooltipTrigger asChild>
                        <Button
                            aria-label={tab.tooltip}
                            className="p-0 h-7"
                            data-testid={`tab-${tab.id}`}
                            key={`navbar-button-${tab.id}`}
                            onClick={() => tab.navigate()}
                            size="icon"
                            variant="icon">
                            <tab.icon className="stroke-1 [svg]:size-4" size={18} />
                        </Button>
                    </TooltipTrigger>
                </Tooltip>
            ))}
        </nav>
    )
}
