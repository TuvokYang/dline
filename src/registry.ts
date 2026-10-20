import { name, publisher, version } from "../package.json"
import { HostProvider } from "./hosts/host-provider"
import distributions from "./shared/extension-distributions.json"

interface DistributionIdentity {
    name: string
    publisher: string
    version: string
}

interface ContributionIdentity {
    packageName: string
    displayName: string
    preview: boolean
    contributionNamespace: string
    activityBarId: string
    sidebarViewId: string
    panelViewType: string
    diffUriScheme: string
    commentControllerId: string
    productIconId: string
    walkthroughId: string
    contextKeys: {
        accountEnabled: string
        isGeneratingCommit: string
        isDevMode: string
        isTestMode: string
    }
}

const contributionIdentities: Record<string, ContributionIdentity> = distributions

function commandIds(namespace: string) {
    const command = (suffix: string) => `${namespace}.${suffix}`
    return {
        PlusButton: command("plusButtonClicked"),
        McpButton: command("mcpButtonClicked"),
        SettingsButton: command("settingsButtonClicked"),
        HistoryButton: command("historyButtonClicked"),
        AccountButton: command("accountButtonClicked"),
        WorktreesButton: command("worktreesButtonClicked"),
        TerminalOutput: command("addTerminalOutputToChat"),
        AddToChat: command("addToChat"),
        FixWithCline: command("fixWithCline"),
        ExplainCode: command("explainCode"),
        ImproveCode: command("improveCode"),
        FocusChatInput: command("focusChatInput"),
        Walkthrough: command("openWalkthrough"),
        GenerateCommit: command("generateGitCommitMessage"),
        AbortCommit: command("abortGitCommitMessage"),
        ReconstructTaskHistory: command("reconstructTaskHistory"),
        RecoverUiMessages: command("recoverUiMessages"),
        ReloadWebview: command("reloadWebview"),
        JupyterGenerateCell: command("jupyterGenerateCell"),
        JupyterExplainCell: command("jupyterExplainCell"),
        JupyterImproveCell: command("jupyterImproveCell"),
        ReviewCommentReply: command("reviewComment.reply"),
        ReviewCommentAddToChat: command("reviewComment.addToChat"),
        DevCreateTestTasks: command("dev.createTestTasks"),
        DevExpireMcpOAuthTokens: command("dev.expireMcpOAuthTokens"),
    }
}

/** Build the runtime registry from the distribution identity compiled into this bundle. */
export function createExtensionRegistryInfo(distribution: DistributionIdentity) {
    const contribution = contributionIdentities[distribution.name]
    if (!contribution) {
        throw new Error(`No VS Code contribution identity is registered for '${distribution.name}'.`)
    }

    return {
        id: `${distribution.publisher}.${distribution.name}`,
        name: distribution.name,
        version: distribution.version,
        publisher: distribution.publisher,
        displayName: contribution.displayName,
        isInsiders: contribution.preview,
        contributionNamespace: contribution.contributionNamespace,
        commands: commandIds(contribution.contributionNamespace),
        viewContainers: { ActivityBar: contribution.activityBarId },
        views: { Sidebar: contribution.sidebarViewId },
        contextKeys: contribution.contextKeys,
        panelViewType: contribution.panelViewType,
        diffUriScheme: contribution.diffUriScheme,
        commentControllerId: contribution.commentControllerId,
        productIconId: contribution.productIconId,
        walkthrough: {
            id: contribution.walkthroughId,
            qualifiedId: `${distribution.publisher}.${distribution.name}#${contribution.walkthroughId}`,
        },
    }
}

/** Runtime registry for the package identity compiled into the current extension bundle. */
export const ExtensionRegistryInfo = createExtensionRegistryInfo({ name, publisher, version })

export interface HostInfo {
    /**
     * The name of the host platform, e.g VSCode, IntelliJ Ultimate Edition, etc.
     */
    platform: string
    /**
     * The operating system platform, e.g. linux, darwin, win32
     */
    os: string
    /**
     * The type of the cline host environment, e.g. 'VSCode Extension', 'Cline for JetBrains', 'CLI'
     * This is different from the platform because there are many JetBrains IDEs, but they all use the same
     * plugin.
     */
    ide: string
    /**
     * A distinct ID for this installation of the host client
     */
    distinctId: string
    /**
     * The version of the host platform, e.g. 1.103.0 for VSCode, or 2025.1.1.1 for JetBrains IDEs.
     */
    hostVersion?: string
    /**
     * The version of Cline that the host client is running
     */
    extensionVersion: string
}

let hostInfo = null as HostInfo | null

export const HostRegistryInfo = {
    init: async (distinctId: string) => {
        const host = await HostProvider.env.getHostVersion({})
        const hostVersion = host.version
        const extensionVersion = host.clineVersion || ExtensionRegistryInfo.version
        const platform = host.platform || "unknown"
        const os = process.platform || "unknown"
        const ide = host.clineType || "unknown"
        hostInfo = { hostVersion, extensionVersion, platform, os, ide, distinctId }
    },
    get: () => hostInfo,
}
