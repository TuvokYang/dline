import type { ExtensionMessage } from "@shared/ExtensionMessage"
import { EmptyRequest, type KeyValuePair } from "@shared/proto/dline/common"
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
import { cn } from "@/lib/utils"
import { StateServiceClient } from "@/services/grpc-client"
import { isAdminOrOwner } from "../account/helpers"
import { Tab, TabContent, TabList, TabTrigger } from "../common/Tab"
import ViewHeader from "../common/ViewHeader"
import { flushPendingApiProfileWrites } from "./providers/useApiProfiles"
import SectionHeader from "./SectionHeader"
import AboutSection from "./sections/AboutSection"
import ApiConfigurationSection from "./sections/ApiConfigurationSection"
import BrowserSettingsSection from "./sections/BrowserSettingsSection"
import DebugSection from "./sections/DebugSection"
import FeatureSettingsSection from "./sections/FeatureSettingsSection"
import GeneralSettingsSection from "./sections/GeneralSettingsSection"
import { RemoteConfigSection } from "./sections/RemoteConfigSection"
import TerminalSettingsSection from "./sections/TerminalSettingsSection"
import { flushPendingSettingsRequests } from "./utils/settingsHandlers"
import { saveSettingsAndClose } from "./utils/settingsSaveCoordinator"
import { flushPendingDebouncedInputs } from "./utils/useDebouncedInput"

const IS_DEV = process.env.IS_DEV

// Tab definitions
type SettingsTabID = "api-config" | "features" | "browser" | "terminal" | "general" | "about" | "debug" | "remote-config"
interface SettingsTab {
    id: SettingsTabID
    name: string
    tooltipText: string
    headerText: string
    icon: LucideIcon
    hidden?: (params?: { activeOrganization: UserOrganization | null }) => boolean
}

export const SETTINGS_TABS: SettingsTab[] = [
    {
        id: "api-config",
        name: "API Configuration",
        tooltipText: "API Configuration",
        headerText: "API Configuration",
        icon: SlidersHorizontal,
    },
    {
        id: "features",
        name: "Features",
        tooltipText: "Feature Settings",
        headerText: "Feature Settings",
        icon: CheckCheck,
    },
    {
        id: "browser",
        name: "Browser",
        tooltipText: "Browser Settings",
        headerText: "Browser Settings",
        icon: SquareMousePointer,
    },
    {
        id: "terminal",
        name: "Terminal",
        tooltipText: "Terminal Settings",
        headerText: "Terminal Settings",
        icon: SquareTerminal,
    },
    {
        id: "general",
        name: "General",
        tooltipText: "General Settings",
        headerText: "General Settings",
        icon: Wrench,
    },
    {
        id: "remote-config",
        name: "Remote Config",
        tooltipText: "Remotely configured fields",
        headerText: "Remote Config",
        icon: HardDriveDownload,
        hidden: ({ activeOrganization } = { activeOrganization: null }) =>
            !activeOrganization || !isAdminOrOwner(activeOrganization),
    },
    {
        id: "about",
        name: "About",
        tooltipText: "About Dline",
        headerText: "About",
        icon: Info,
    },
    // Only show in dev mode
    {
        id: "debug",
        name: "Debug",
        tooltipText: "Debug Tools",
        headerText: "Debug",
        icon: FlaskConical,
        hidden: () => !IS_DEV,
    },
]

type SettingsViewProps = {
    onDone: () => void | Promise<void>
    targetSection?: string
}

// Helper to render section header - moved outside component for better performance
const renderSectionHeader = (tabId: string) => {
    const tab = SETTINGS_TABS.find((t) => t.id === tabId)
    if (!tab) {
        return null
    }

    return (
        <SectionHeader>
            <div className="flex items-center gap-2">
                <tab.icon className="w-4" />
                <div>{tab.headerText}</div>
            </div>
        </SectionHeader>
    )
}

const SettingsView = ({ onDone, targetSection }: SettingsViewProps) => {
    const { version, environment } = useExtensionState()
    const { activeOrganization } = useClineAuth()

    const [activeTab, setActiveTab] = useState<string>(targetSection || SETTINGS_TABS[0].id)
    const [isSaving, setIsSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)

    const handleDone = useCallback(async () => {
        if (isSaving) return
        setIsSaving(true)
        setSaveError(null)
        try {
            await saveSettingsAndClose({
                flushInputs: flushPendingDebouncedInputs,
                flushRequests: flushPendingSettingsRequests,
                flushProfileCatalog: flushPendingApiProfileWrites,
                flushBackend: () => StateServiceClient.flushPendingState(EmptyRequest.create({})),
                close: onDone,
            })
        } catch (error) {
            setSaveError(error instanceof Error ? error.message : "Unable to persist Settings")
        } finally {
            setIsSaving(false)
        }
    }, [isSaving, onDone])

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
                <TabTrigger className="flex justify-baseline" data-testid={`tab-${tab.id}`} key={tab.id} value={tab.id}>
                    <Tooltip key={tab.id}>
                        <TooltipTrigger>
                            <div
                                className={cn(
                                    "whitespace-nowrap overflow-hidden h-12 sm:py-3 box-border flex items-center border-l-2 border-transparent text-foreground opacity-70 bg-transparent hover:bg-list-hover p-4 cursor-pointer gap-2",
                                    {
                                        "opacity-100 border-l-2 border-l-foreground border-t-0 border-r-0 border-b-0 bg-selection":
                                            activeTab === tab.id,
                                    },
                                )}>
                                <tab.icon className="w-4 h-4" />
                                <span className="hidden sm:block">{tab.name}</span>
                            </div>
                        </TooltipTrigger>
                        <TooltipContent side="right">{tab.tooltipText}</TooltipContent>
                    </Tooltip>
                </TabTrigger>
            )
        },
        [activeTab],
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
    }, [activeTab, handleResetState, version])

    return (
        <Tab>
            <ViewHeader
                doneDisabled={isSaving}
                doneLabel={isSaving ? "Saving..." : "Done"}
                environment={environment}
                onDone={handleDone}
                title="Settings"
            />
            {saveError && (
                <div className="mx-5 mb-3 rounded border border-(--vscode-errorForeground) p-2 text-sm" role="alert">
                    Failed to save settings: {saveError}
                </div>
            )}

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
