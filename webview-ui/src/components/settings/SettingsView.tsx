import type { ExtensionMessage } from "@shared/ExtensionMessage"
import type { KeyValuePair } from "@shared/proto/dline/common"
import { ResetStateRequest } from "@shared/proto/dline/state"
import { UserOrganization } from "@shared/proto/index.dline"
import {
    CheckCheck,
    FlaskConical,
    HardDriveDownload,
    Info,
    type LucideIcon,
    SlidersHorizontal,
    SquareMousePointer,
    SquareTerminal,
    Wrench,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useEvent } from "react-use"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useClineAuth } from "@/context/ClineAuthContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import type { UiMessageKey, UiTranslator } from "@/i18n/messages"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { cn } from "@/lib/utils"
import { StateServiceClient } from "@/services/grpc-client"
import { isAdminOrOwner } from "../account/helpers"
import { Tab, TabContent, TabList, TabTrigger } from "../common/Tab"
import ViewHeader from "../common/ViewHeader"
import SectionHeader from "./SectionHeader"
import AboutSection from "./sections/AboutSection"
import ApiConfigurationSection from "./sections/ApiConfigurationSection"
import BrowserSettingsSection from "./sections/BrowserSettingsSection"
import DebugSection from "./sections/DebugSection"
import FeatureSettingsSection from "./sections/FeatureSettingsSection"
import GeneralSettingsSection from "./sections/GeneralSettingsSection"
import { RemoteConfigSection } from "./sections/RemoteConfigSection"
import TerminalSettingsSection from "./sections/TerminalSettingsSection"

const IS_DEV = process.env.IS_DEV

// Tab definitions
type SettingsTabID = "api-config" | "features" | "browser" | "terminal" | "general" | "about" | "debug" | "remote-config"
interface SettingsTab {
    id: SettingsTabID
    nameKey: Extract<UiMessageKey, `settings.${string}.name`>
    tooltipKey: Extract<UiMessageKey, `settings.${string}.tooltip`>
    headingKey: Extract<UiMessageKey, `settings.${string}.heading`>
    icon: LucideIcon
    hidden?: (params?: { activeOrganization: UserOrganization | null }) => boolean
}

export const SETTINGS_TABS: SettingsTab[] = [
    {
        id: "api-config",
        nameKey: "settings.apiConfiguration.name",
        tooltipKey: "settings.apiConfiguration.tooltip",
        headingKey: "settings.apiConfiguration.heading",
        icon: SlidersHorizontal,
    },
    {
        id: "features",
        nameKey: "settings.features.name",
        tooltipKey: "settings.features.tooltip",
        headingKey: "settings.features.heading",
        icon: CheckCheck,
    },
    {
        id: "browser",
        nameKey: "settings.browser.name",
        tooltipKey: "settings.browser.tooltip",
        headingKey: "settings.browser.heading",
        icon: SquareMousePointer,
    },
    {
        id: "terminal",
        nameKey: "settings.terminal.name",
        tooltipKey: "settings.terminal.tooltip",
        headingKey: "settings.terminal.heading",
        icon: SquareTerminal,
    },
    {
        id: "general",
        nameKey: "settings.general.name",
        tooltipKey: "settings.general.tooltip",
        headingKey: "settings.general.heading",
        icon: Wrench,
    },
    {
        id: "remote-config",
        nameKey: "settings.remoteConfig.name",
        tooltipKey: "settings.remoteConfig.tooltip",
        headingKey: "settings.remoteConfig.heading",
        icon: HardDriveDownload,
        hidden: ({ activeOrganization } = { activeOrganization: null }) =>
            !activeOrganization || !isAdminOrOwner(activeOrganization),
    },
    {
        id: "about",
        nameKey: "settings.about.name",
        tooltipKey: "settings.about.tooltip",
        headingKey: "settings.about.heading",
        icon: Info,
    },
    // Only show in dev mode
    {
        id: "debug",
        nameKey: "settings.debug.name",
        tooltipKey: "settings.debug.tooltip",
        headingKey: "settings.debug.heading",
        icon: FlaskConical,
        hidden: () => !IS_DEV,
    },
]

type SettingsViewProps = {
    onDone: () => void | Promise<void>
    targetSection?: string
}

const renderSectionHeaderWithTranslation = (tabId: string, t: UiTranslator) => {
    const tab = SETTINGS_TABS.find((t) => t.id === tabId)
    if (!tab) {
        return null
    }

    return (
        <SectionHeader>
            <div className="flex items-center gap-2">
                <tab.icon className="w-4" />
                <div>{t(tab.headingKey)}</div>
            </div>
        </SectionHeader>
    )
}

const SettingsView = ({ onDone, targetSection }: SettingsViewProps) => {
    const { version, environment } = useExtensionState()
    const { activeOrganization } = useClineAuth()
    const { t } = useUiTranslation()
    const renderSectionHeader = useCallback((tabId: string) => renderSectionHeaderWithTranslation(tabId, t), [t])

    const [activeTab, setActiveTab] = useState<string>(targetSection || SETTINGS_TABS[0].id)

    // Optimized message handler with early returns
    const handleMessage = useCallback((event: MessageEvent) => {
        const message: ExtensionMessage = event.data
        if (message.type !== "grpc_response") {
            return
        }

        // This listener sees every RPC response, so the response is read as the
        // KeyValuePair that scrollToSettings returns and the key selects the one
        // this handler owns.
        const grpcMessage = message.grpc_response?.message as Partial<KeyValuePair> | undefined
        if (grpcMessage?.key !== "scrollToSettings") {
            return
        }

        const tabId = grpcMessage.value
        if (!tabId) {
            return
        }

        // Check if valid tab ID
        if (SETTINGS_TABS.some((tab) => tab.id === tabId)) {
            setActiveTab(tabId)
            return
        }

        // Fallback to element scrolling
        requestAnimationFrame(() => {
            const element = document.getElementById(tabId)
            if (!element) {
                return
            }

            element.scrollIntoView({ behavior: "smooth" })
            element.style.transition = "background-color 0.5s ease"
            element.style.backgroundColor = "var(--vscode-textPreformat-background)"

            setTimeout(() => {
                element.style.backgroundColor = "transparent"
            }, 1200)
        })
    }, [])

    useEvent("message", handleMessage)

    // Memoized reset state handler
    const handleResetState = useCallback(async (resetGlobalState?: boolean) => {
        try {
            await StateServiceClient.resetState(ResetStateRequest.create({ global: resetGlobalState }))
        } catch (error) {
            console.error("Failed to reset state:", error)
        }
    }, [])

    // Update active tab when targetSection changes
    useEffect(() => {
        if (targetSection) {
            setActiveTab(targetSection)
        }
    }, [targetSection])

    // Memoized tab item renderer
    const renderTabItem = useCallback(
        (tab: (typeof SETTINGS_TABS)[0]) => {
            return (
                <TabTrigger
                    aria-label={t(tab.nameKey)}
                    className="flex justify-baseline"
                    data-testid={`tab-${tab.id}`}
                    key={tab.id}
                    value={tab.id}>
                    <Tooltip key={tab.id}>
                        <TooltipTrigger asChild>
                            <div
                                className={cn(
                                    "whitespace-nowrap overflow-hidden h-12 sm:py-3 box-border flex items-center border-l-2 border-transparent text-foreground opacity-70 bg-transparent hover:bg-list-hover p-4 cursor-pointer gap-2",
                                    {
                                        "opacity-100 border-l-2 border-l-foreground border-t-0 border-r-0 border-b-0 bg-selection":
                                            activeTab === tab.id,
                                    },
                                )}>
                                <tab.icon className="w-4 h-4" />
                                <span className="hidden sm:block">{t(tab.nameKey)}</span>
                            </div>
                        </TooltipTrigger>
                        <TooltipContent side="right">{t(tab.tooltipKey)}</TooltipContent>
                    </Tooltip>
                </TabTrigger>
            )
        },
        [activeTab, t],
    )

    // Memoized active content component.
    //
    // Each section is rendered against its own props contract rather than through
    // a shared props bag, so a section that gains or renames a required prop fails
    // to compile here instead of receiving an undefined value at runtime.
    const ActiveContent = useMemo(() => {
        switch (activeTab) {
            case "api-config":
                return <ApiConfigurationSection renderSectionHeader={renderSectionHeader} />
            case "general":
                return <GeneralSettingsSection renderSectionHeader={renderSectionHeader} />
            case "features":
                return <FeatureSettingsSection renderSectionHeader={renderSectionHeader} />
            case "browser":
                return <BrowserSettingsSection renderSectionHeader={renderSectionHeader} />
            case "terminal":
                return <TerminalSettingsSection renderSectionHeader={renderSectionHeader} />
            case "remote-config":
                return <RemoteConfigSection renderSectionHeader={renderSectionHeader} />
            case "about":
                return <AboutSection renderSectionHeader={renderSectionHeader} version={version} />
            case "debug":
                return <DebugSection onResetState={handleResetState} renderSectionHeader={renderSectionHeader} />
            default:
                return null
        }
    }, [activeTab, handleResetState, renderSectionHeader, version])

    return (
        <Tab>
            <ViewHeader doneLabel={t("settings.done")} environment={environment} onDone={onDone} title={t("settings.title")} />

            <div className="flex flex-1 overflow-hidden">
                <TabList
                    className="shrink-0 flex flex-col overflow-y-auto border-r border-sidebar-background"
                    onValueChange={setActiveTab}
                    value={activeTab}>
                    {SETTINGS_TABS.filter((tab) => !tab.hidden?.({ activeOrganization })).map(renderTabItem)}
                </TabList>

                <TabContent className="flex-1 overflow-auto">{ActiveContent}</TabContent>
            </div>
        </Tab>
    )
}

export default SettingsView
