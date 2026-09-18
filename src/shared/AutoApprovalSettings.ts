/**
 * Upper bound of automation a permission scope allows.
 *
 * A ceiling is not another toggle. A toggle says what the user wants right now;
 * a ceiling says how far automation may ever go for that scope, and it is
 * evaluated first. That ordering is what makes "auto-approve broadly, but never
 * for writes outside the workspace" expressible: the blanket switch cannot
 * raise a scope above its ceiling.
 */
export type ApprovalCeilingSetting = "manual_only" | "ai_approvable" | "auto"

/**
 * Permission scopes whose ceiling the user may configure.
 *
 * Scopes rather than tools, because several tools reach the same resource class
 * and users reason about the resource. Reading and writing outside the
 * workspace are separate scopes from their in-workspace counterparts because
 * their blast radius differs.
 */
export type ConfigurablePermissionScope =
	| "read_workspace"
	| "read_external"
	| "edit_workspace"
	| "edit_external"
	| "command_safe"
	| "command_all"
	| "browser"
	| "web"
	| "mcp"
	| "generate_image"
	| "focus_chain"
	| "subagent"

export interface AutoApprovalSettings {
	// Version for race condition prevention (incremented on every change)
	version: number
	// Legacy field - kept for backward compatibility with older extension versions
	// Auto-approve is now always enabled by default
	enabled: boolean
	// Legacy field - kept for backward compatibility with older extension versions
	// Favorites feature has been removed
	favorites: string[]
	// Legacy field - kept for backward compatibility with older extension versions
	// Max requests limit feature has been removed
	maxRequests: number
	// Individual action permissions
	actions: {
		readFiles: boolean // Read files and directories in the working directory
		readFilesExternally?: boolean // Read files and directories outside of the working directory
		editFiles: boolean // Edit files in the working directory
		editFilesExternally?: boolean // Edit files outside of the working directory
		executeSafeCommands?: boolean // Execute safe commands
		executeAllCommands?: boolean // Execute all commands
		useBrowser: boolean // Use browser automation
		useWeb?: boolean // Use local Web Search and Web Fetch
		useMcp: boolean // Use MCP servers
		generateImages?: boolean // Generate images through configured providers
		focusChain: boolean // Auto-approve focus chain overrides
	}
	/**
	 * Per-scope automation ceilings.
	 *
	 * Sparse and absent by default: every unset scope uses the compatibility
	 * default `auto`, so introducing ceilings does not change the approval outcome
	 * for any existing user. External read/write scopes remain separately
	 * configurable and become `manual_only` only when the user configures them so.
	 *
	 * A ceiling constrains only the scope a call is classified into. It does not
	 * inspect command text, so it makes no claim about what a command or a
	 * command-capable subagent can ultimately reach.
	 */
	ceilings?: Partial<Record<ConfigurablePermissionScope, ApprovalCeilingSetting>>
	// Global settings
	enableNotifications: boolean // Show notifications for approval and task completion
}

export const DEFAULT_AUTO_APPROVAL_SETTINGS: AutoApprovalSettings = {
	version: 1,
	enabled: true, // Legacy field - always true by default
	favorites: [], // Legacy field - kept as empty array
	maxRequests: 20, // Legacy field - kept for backward compatibility
	actions: {
		readFiles: true,
		readFilesExternally: false,
		editFiles: false,
		editFilesExternally: false,
		executeSafeCommands: true,
		executeAllCommands: false,
		useBrowser: false,
		useWeb: false,
		useMcp: true,
		generateImages: false,
		focusChain: false,
	},
	enableNotifications: false,
}
