import { isFeatureSettingActive } from "@shared/DlineFeatureSettings"
import { HistoryIcon, PlusIcon, SettingsIcon, UserCircleIcon } from "lucide-react"
import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { UiMessageKey } from "@/i18n/messages"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { TaskServiceClient } from "@/services/grpc-client"
import { useExtensionState } from "../../context/ExtensionStateContext"

// Custom MCP Server Icon component using VSCode codicon
const McpServerIcon = ({ className, size }: { className?: string; size?: number }) => (
    <span
        className={`codicon codicon-server flex items-center ${className || ""}`}
        style={{ fontSize: size ? `${size}px` : "12.5px", marginBottom: "1px" }}
    />
)

/**
 * Navigation tabs keep a stable identity and their own navigate handlers; the
 * labels are message keys resolved during rendering, so switching language
 * re-renders the labels without rebuilding the tab list or remounting buttons.
 */
interface NavbarTab {
    id: string
    nameKey: Extract<UiMessageKey, `shell.navigation.${string}.name`>
    tooltipKey: Extract<UiMessageKey, `shell.navigation.${string}.tooltip`>
    icon: typeof PlusIcon | typeof McpServerIcon
    navigate: () => void
}

export const Navbar = () => {
    const { navigateToHistory, navigateToSettings, navigateToAccount, navigateToMcp, navigateToChat, accountEnabled } =
        useExtensionState()
    const { t } = useUiTranslation()
    const accountActive = isFeatureSettingActive(accountEnabled)

    const SETTINGS_TABS = useMemo<NavbarTab[]>(
        () => [
            {
                id: "chat",
                nameKey: "shell.navigation.chat.name",
                tooltipKey: "shell.navigation.chat.tooltip",
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
                nameKey: "shell.navigation.mcp.name",
                tooltipKey: "shell.navigation.mcp.tooltip",
                icon: McpServerIcon,
                navigate: navigateToMcp,
            },
            {
                id: "history",
                nameKey: "shell.navigation.history.name",
                tooltipKey: "shell.navigation.history.tooltip",
                icon: HistoryIcon,
                navigate: navigateToHistory,
            },
            ...(accountActive
                ? [
                      {
                          id: "account",
                          nameKey: "shell.navigation.account.name" as const,
                          tooltipKey: "shell.navigation.account.tooltip" as const,
                          icon: UserCircleIcon,
                          navigate: navigateToAccount,
                      },
                  ]
                : []),
            {
                id: "settings",
                nameKey: "shell.navigation.settings.name",
                tooltipKey: "shell.navigation.settings.tooltip",
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
            {SETTINGS_TABS.map((tab) => {
                const tooltip = t(tab.tooltipKey)
                return (
                    <Tooltip key={`navbar-tooltip-${tab.id}`}>
                        <TooltipContent side="bottom">{tooltip}</TooltipContent>
                        <TooltipTrigger asChild>
                            <Button
                                aria-label={tooltip}
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
                )
            })}
        </nav>
    )
}
