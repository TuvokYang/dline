import { name, publisher, version } from "../package.json"
import { HostProvider } from "./hosts/host-provider"

/**
 * Contribution IDs are a stable public namespace shared by every distribution package.
 *
 * Insiders changes package.json.name to `dline-insiders` before esbuild runs, but its
 * commands and view IDs intentionally remain `dline.*`. Deriving contributions from
 * the distribution name leaves the installed extension unable to resolve its Webview.
 */
const CONTRIBUTION_NAMESPACE = "dline"

const ClineCommands = {
	PlusButton: `${CONTRIBUTION_NAMESPACE}.plusButtonClicked`,
	McpButton: `${CONTRIBUTION_NAMESPACE}.mcpButtonClicked`,
	SettingsButton: `${CONTRIBUTION_NAMESPACE}.settingsButtonClicked`,
	HistoryButton: `${CONTRIBUTION_NAMESPACE}.historyButtonClicked`,
	AccountButton: `${CONTRIBUTION_NAMESPACE}.accountButtonClicked`,
	WorktreesButton: `${CONTRIBUTION_NAMESPACE}.worktreesButtonClicked`,
	TerminalOutput: `${CONTRIBUTION_NAMESPACE}.addTerminalOutputToChat`,
	AddToChat: `${CONTRIBUTION_NAMESPACE}.addToChat`,
	FixWithCline: `${CONTRIBUTION_NAMESPACE}.fixWithCline`,
	ExplainCode: `${CONTRIBUTION_NAMESPACE}.explainCode`,
	ImproveCode: `${CONTRIBUTION_NAMESPACE}.improveCode`,
	FocusChatInput: `${CONTRIBUTION_NAMESPACE}.focusChatInput`,
	Walkthrough: `${CONTRIBUTION_NAMESPACE}.openWalkthrough`,
	GenerateCommit: `${CONTRIBUTION_NAMESPACE}.generateGitCommitMessage`,
	AbortCommit: `${CONTRIBUTION_NAMESPACE}.abortGitCommitMessage`,
	ReconstructTaskHistory: `${CONTRIBUTION_NAMESPACE}.reconstructTaskHistory`,
	RecoverUiMessages: `${CONTRIBUTION_NAMESPACE}.recoverUiMessages`,
	// Jupyter Notebook commands
	JupyterGenerateCell: `${CONTRIBUTION_NAMESPACE}.jupyterGenerateCell`,
	JupyterExplainCell: `${CONTRIBUTION_NAMESPACE}.jupyterExplainCell`,
	JupyterImproveCell: `${CONTRIBUTION_NAMESPACE}.jupyterImproveCell`,
}

const ClineViewContainerIds = {
	ActivityBar: `${CONTRIBUTION_NAMESPACE}-ActivityBar`,
}

const ClineViewIds = {
	Sidebar: `${CONTRIBUTION_NAMESPACE}.SidebarProvider`,
}

interface DistributionIdentity {
	name: string
	publisher: string
	version: string
}

/** Build runtime identity without coupling stable contribution IDs to the distribution package name. */
export function createExtensionRegistryInfo(distribution: DistributionIdentity) {
	return {
		id: `${distribution.publisher}.${distribution.name}`,
		name: distribution.name,
		version: distribution.version,
		publisher: distribution.publisher,
		contributionNamespace: CONTRIBUTION_NAMESPACE,
		commands: ClineCommands,
		viewContainers: ClineViewContainerIds,
		views: ClineViewIds,
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
