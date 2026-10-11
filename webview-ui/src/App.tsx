import type { Boolean, EmptyRequest } from "@shared/proto/dline/common"
import { useCallback, useEffect } from "react"
import AccountView from "./components/account/AccountView"
import ChatView from "./components/chat/ChatView"
import { HydrationFailed, HydrationPending } from "./components/common/HydrationGate"
import HistoryView from "./components/history/HistoryView"
import McpView from "./components/mcp/configuration/McpConfigurationView"
import OnboardingView from "./components/onboarding/OnboardingView"
import SettingsView from "./components/settings/SettingsView"
import WorktreesView from "./components/worktrees/WorktreesView"
import { announceWebviewMounted } from "./config/platform.config"
import { useClineAuth } from "./context/ClineAuthContext"
import { useExtensionState } from "./context/ExtensionStateContext"
import { Providers } from "./Providers"
import { UiServiceClient } from "./services/grpc-client"

export const AppContent = () => {
    const {
        didHydrateState,
        hydration,
        retryHydration,
        showWelcome,
        shouldShowAnnouncement,
        showMcp,
        mcpTab,
        showSettings,
        settingsTargetSection,
        showHistory,
        showAccount,
        showWorktrees,
        showAnnouncement,
        setShowAnnouncement,
        setShouldShowAnnouncement,
        closeMcpView,
        navigateToHistory,
        hideSettings,
        hideHistory,
        hideAccount,
        hideWorktrees,
        hideAnnouncement,
    } = useExtensionState()

    const { clineUser, organizations, activeOrganization } = useClineAuth()

    const showUpdateAnnouncementModal = useCallback(() => {
        setShouldShowAnnouncement(false)
        setShowAnnouncement(true)
        UiServiceClient.onDidShowAnnouncement({} as EmptyRequest)
            .then((response: Boolean) => {
                setShouldShowAnnouncement(response.value)
            })
            .catch((error) => {
                console.error("Failed to acknowledge announcement:", error)
            })
    }, [setShouldShowAnnouncement, setShowAnnouncement])

    useEffect(() => {
        if (!didHydrateState || showWelcome || !shouldShowAnnouncement || showAnnouncement) {
            return
        }
        showUpdateAnnouncementModal()
    }, [didHydrateState, showWelcome, shouldShowAnnouncement, showAnnouncement, showUpdateAnnouncementModal])

    if (!didHydrateState) {
        // Rendering nothing here was the blank panel: a failed subscription and
        // a slow one produced the same empty view, and neither said so.
        if (hydration?.status === "failed") {
            return <HydrationFailed onRetry={retryHydration} reason={hydration.reason} />
        }
        return <HydrationPending />
    }

    if (showWelcome) {
        return <OnboardingView />
    }

    return (
        <div className="flex h-screen w-full flex-col">
            {showSettings && <SettingsView onDone={hideSettings} targetSection={settingsTargetSection} />}
            {showHistory && <HistoryView onDone={hideHistory} />}
            {showMcp && <McpView initialTab={mcpTab} onDone={closeMcpView} />}
            {showAccount && (
                <AccountView
                    activeOrganization={activeOrganization}
                    clineUser={clineUser}
                    onDone={hideAccount}
                    organizations={organizations}
                />
            )}
            {showWorktrees && <WorktreesView onDone={hideWorktrees} />}
            <ChatView
                hideAnnouncement={hideAnnouncement}
                isHidden={showSettings || showHistory || showMcp || showAccount || showWorktrees}
                showAnnouncement={showAnnouncement}
                showHistoryView={navigateToHistory}
            />
        </div>
    )
}

const App = () => {
    useEffect(() => announceWebviewMounted(), [])

    return (
        <Providers>
            <AppContent />
        </Providers>
    )
}

export default App
