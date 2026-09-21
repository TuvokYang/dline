import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import { ClineDefaultTool, CONVERSATIONAL_TOOL_NAMES } from "@shared/tools"

/**
 * Permission scope a tool call is classified into.
 *
 * Approval is decided per scope rather than per tool, because several tools
 * reach the same resource class and a user reasons about the resource, not the
 * tool name. Reading inside and outside the workspace are separate scopes
 * because their blast radius differs.
 */
export type PermissionScope =
	| "read_workspace"
	| "read_external"
	| "edit_workspace"
	| "edit_external"
	| "command_safe"
	| "command_all"
	| "terminate_command"
	| "browser"
	| "web"
	| "mcp"
	| "generate_image"
	| "focus_chain"
	| "subagent"
	| "conversational"

/**
 * Upper bound of automation allowed for a scope.
 *
 * A ceiling is not a switch. It states how far automation may go if the user
 * asks for it; the user's own toggle decides whether to go that far. This
 * separation is what makes "I enabled auto-approve broadly, but never for
 * writes outside the workspace" expressible.
 */
export type ApprovalCeiling =
	/** A human decides every time. No toggle and no approver may satisfy it. */
	| "manual_only"
	/** An AI approver may decide it even with the user's toggle off. */
	| "ai_approvable"
	/** The user's auto-approval toggle decides it. */
	| "auto"

/** How a block must be approved before it may execute. */
export type ApprovalKind =
	/** No approval stage; the block proceeds directly to execution. */
	| "none"
	/** Approved by policy; may resolve concurrently with other blocks. */
	| "automatic"
	/** Routed to the AI approver, which either approves or escalates. */
	| "ai_approver"
	/** Presented to the user in the single serial approval slot. */
	| "manual"

/** Resolved approval decision for one block. */
export interface ApprovalDecision {
	kind: ApprovalKind
	scope: PermissionScope
	ceiling: ApprovalCeiling
}

/**
 * Runtime facts that determine which scope a call belongs to.
 *
 * Resolution stays pure: the caller decides whether a path is external, since
 * that requires workspace knowledge the kernel deliberately does not have.
 */
export interface PermissionScopeContext {
	/** True when the call's target lies outside every workspace root. */
	isExternalPath?: boolean
	/** True when the command matched the safe-command classifier. */
	isSafeCommand?: boolean
	/** Optional tool-local gate applied in addition to its permission-scope toggle. */
	isToolAutoApproveEnabled?: boolean
}

/** Scopes whose ceiling the user may configure. */
export type ConfigurableCeilings = Partial<Record<PermissionScope, ApprovalCeiling>>

/**
 * Tools that present their own interaction and therefore have no approval stage.
 *
 * This is a fixed property of the tool, not a setting. Gating one behind
 * approval would deadlock the turn: the approval being waited for is the
 * interaction the tool has not been allowed to present. `status_update` joins
 * the conversational set because it likewise owns whether to block, which is
 * the same rule the existing runtime applies.
 */
function ownsItsInteraction(tool: ClineDefaultTool): boolean {
	return tool === ClineDefaultTool.STATUS_UPDATE || CONVERSATIONAL_TOOL_NAMES.has(tool)
}

/**
 * Tools that only withdraw an effect the user already approved.
 *
 * Terminating a command cannot reach anything the command was not already
 * allowed to reach; it takes that reach away. Sharing the command scopes made
 * stopping harder to authorize than starting, so a user who declined broad
 * command approval had to approve each termination too — exactly backwards,
 * since that is the user most likely to want the command stopped. Like
 * interaction ownership this is a fixed property of the tool, which is why the
 * scope it resolves to has a fixed ceiling rather than a configurable one.
 */
function withdrawsAnApprovedEffect(tool: ClineDefaultTool): boolean {
	return tool === ClineDefaultTool.KILL_COMMAND
}

/**
 * Default ceiling per scope.
 *
 * Every scope defaults to `auto`, which means the ceiling adds no restriction
 * and the user's existing toggle alone decides. That is deliberate: a ceiling
 * is a setting the user chooses, so introducing the concept must not silently
 * tighten approval for someone who never configured one. Reading and writing
 * outside the workspace are the scopes `manual_only` exists for, but they
 * reach it by being configured, not by default.
 */
const DEFAULT_CEILINGS: Record<PermissionScope, ApprovalCeiling> = {
	read_workspace: "auto",
	read_external: "auto",
	edit_workspace: "auto",
	edit_external: "auto",
	command_safe: "auto",
	command_all: "auto",
	terminate_command: "auto",
	browser: "auto",
	web: "auto",
	mcp: "auto",
	generate_image: "auto",
	focus_chain: "auto",
	subagent: "auto",
	conversational: "auto",
}

/**
 * Scopes whose ceiling is fixed by the architecture rather than by the user.
 *
 * `conversational` covers tools that present their own interaction. A
 * `manual_only` ceiling on such a tool would be unsatisfiable rather than
 * strict, so the ceiling is not configurable and the conflict cannot arise.
 *
 * `terminate_command` covers withdrawing an already approved effect. A ceiling
 * there would only make a command harder to stop than it was to start, which
 * is a restriction that protects nothing.
 */
const FIXED_CEILING_SCOPES: ReadonlySet<PermissionScope> = new Set<PermissionScope>(["conversational", "terminate_command"])

/**
 * Tools that reach the filesystem for reading.
 *
 * A symbol tool such as `find_references` belongs here even though its result
 * can name files the call never did. Scope answers "what is this call allowed
 * to address", which is the declared target; it does not bound what a language
 * server reports back. Classifying the tool as external regardless of its
 * target only moved a permitted workspace read onto the "read all files"
 * toggle, which withheld nothing while making the workspace ceiling
 * unreachable for it.
 */
const READ_TOOLS: ReadonlySet<ClineDefaultTool> = new Set([
	ClineDefaultTool.FILE_READ,
	ClineDefaultTool.SEARCH,
	ClineDefaultTool.LIST_FILES,
	ClineDefaultTool.LIST_CODE_DEF,
	ClineDefaultTool.FIND_REFERENCES,
	ClineDefaultTool.LOAD_SKILL,
	ClineDefaultTool.LOAD_WORKFLOW,
	ClineDefaultTool.SUMMARIZE_TASK,
	ClineDefaultTool.GENERATE_EXPLANATION,
])

/**
 * Tools that mutate files.
 *
 * `rename` and `replace_text` discover their full write set at execution time.
 * That fan-out is contained by the dynamic write lane in `tool-lanes`, which
 * serialises them against other edits; approval classifies the target the call
 * declares, exactly as it does for a single-file edit.
 */
const EDIT_TOOLS: ReadonlySet<ClineDefaultTool> = new Set([
	ClineDefaultTool.FILE_NEW,
	ClineDefaultTool.FILE_EDIT,
	ClineDefaultTool.NEW_RULE,
	ClineDefaultTool.APPLY_PATCH,
	ClineDefaultTool.REPLACE_TEXT,
	ClineDefaultTool.RENAME,
])

/** Direct scope assignments for tools whose scope needs no runtime context. */
const DIRECT_SCOPES: Partial<Record<ClineDefaultTool, PermissionScope>> = {
	[ClineDefaultTool.BROWSER]: "browser",
	[ClineDefaultTool.WEB_FETCH]: "web",
	[ClineDefaultTool.WEB_SEARCH]: "web",
	[ClineDefaultTool.REPORT_BUG]: "web",
	[ClineDefaultTool.MCP_USE]: "mcp",
	[ClineDefaultTool.MCP_ACCESS]: "mcp",
	[ClineDefaultTool.MCP_DOCS]: "mcp",
	[ClineDefaultTool.LOAD_MCP]: "mcp",
	[ClineDefaultTool.KILL_COMMAND]: "terminate_command",
	[ClineDefaultTool.GENERATE_IMAGE]: "generate_image",
	[ClineDefaultTool.TODO]: "focus_chain",
	[ClineDefaultTool.CHANGE_TODO_LIST]: "focus_chain",
	[ClineDefaultTool.NEW_TASK]: "subagent",
	[ClineDefaultTool.SPAWN_TASK]: "subagent",
	[ClineDefaultTool.USE_SUBAGENT]: "subagent",
	[ClineDefaultTool.USE_SUBAGENTS]: "subagent",
}

/**
 * Classify a tool call into its permission scope.
 *
 * @param toolName Registered tool identity.
 * @param context Runtime facts supplied by the caller.
 * @returns The scope whose ceiling and toggle govern this call.
 */
export function resolvePermissionScope(toolName: string, context: PermissionScopeContext = {}): PermissionScope {
	const tool = toolName as ClineDefaultTool

	if (READ_TOOLS.has(tool)) {
		return context.isExternalPath ? "read_external" : "read_workspace"
	}
	if (EDIT_TOOLS.has(tool)) {
		return context.isExternalPath ? "edit_external" : "edit_workspace"
	}
	if (tool === ClineDefaultTool.BASH) {
		return context.isSafeCommand ? "command_safe" : "command_all"
	}

	return DIRECT_SCOPES[tool] ?? "conversational"
}

/**
 * Resolve the ceiling in force for a scope.
 *
 * @param scope Permission scope.
 * @param configured User-configured ceiling overrides.
 * @returns The configured ceiling, otherwise the declared default.
 */
export function resolveApprovalCeiling(scope: PermissionScope, configured: ConfigurableCeilings = {}): ApprovalCeiling {
	if (FIXED_CEILING_SCOPES.has(scope)) {
		return DEFAULT_CEILINGS[scope]
	}
	return configured[scope] ?? DEFAULT_CEILINGS[scope]
}

/**
 * Whether the user has enabled auto-approval for a scope.
 *
 * Scopes map onto the existing `AutoApprovalSettings.actions` flags so this
 * introduces no second permission store. A scope with no corresponding flag is
 * not auto-approvable by toggle.
 */
function isScopeToggledOn(scope: PermissionScope, settings: AutoApprovalSettings): boolean {
	const actions = settings.actions
	switch (scope) {
		case "read_workspace":
			return actions.readFiles === true
		case "read_external":
			return actions.readFilesExternally === true
		case "subagent":
			// The existing runtime governs use_subagent(s) with the read-file
			// toggles. Giving the scope its own name makes a future dedicated
			// setting possible without silently changing today's policy to
			// "never automatic" in the meantime.
			return actions.readFiles === true
		case "edit_workspace":
			return actions.editFiles === true
		case "edit_external":
			return actions.editFilesExternally === true
		case "command_safe":
			return actions.executeSafeCommands === true || actions.executeAllCommands === true
		case "command_all":
			return actions.executeAllCommands === true
		case "browser":
			return actions.useBrowser === true
		case "web":
			return actions.useWeb === true
		case "mcp":
			return actions.useMcp === true
		case "generate_image":
			return actions.generateImages === true
		case "focus_chain":
			return actions.focusChain === true
		default:
			return false
	}
}

/** Inputs to one approval decision. */
export interface ApprovalKindInput {
	toolName: string
	settings: AutoApprovalSettings
	ceilings?: ConfigurableCeilings
	context?: PermissionScopeContext
	/** The enclosing tool approval may satisfy this nested call when the ceiling permits it. */
	inheritsApproval?: boolean
	/**
	 * Blanket approval switches held outside `AutoApprovalSettings`.
	 *
	 * `AutoApprovalSettings.enabled` is a legacy field that is always true; the
	 * switches that actually grant broad approval are separate global settings.
	 * They are inputs here so the ceiling can be shown to outrank them, which is
	 * the claim that makes a ceiling different from another toggle.
	 */
	blanket?: {
		/** Global "approve everything" switch. */
		yoloMode?: boolean
		/** Global "approve all tools" switch. */
		approveAll?: boolean
	}
}

/**
 * Decide how a block must be approved.
 *
 * Resolution order is fixed and the ceiling is evaluated before every approval
 * signal, so a `manual_only` scope cannot be automated by any combination of
 * per-scope toggles, blanket switches, or the AI approver:
 *
 *   1. a `manual_only` ceiling forces manual approval;
 *   2. an inherited parent approval removes the nested approval stage;
 *   3. tools that present their own interaction have no approval stage;
 *   4. a blanket switch or an enabled per-scope toggle grants automatic approval;
 *   5. an `ai_approvable` ceiling routes the block to the AI approver;
 *   6. otherwise the user decides manually.
 *
 * Step 2 cannot conflict with step 1, because the scope those tools resolve to
 * has a fixed ceiling that the user cannot raise or lower.
 *
 * @param input Tool identity, settings, ceilings, blanket switches and context.
 * @returns The approval decision under the supplied permission state.
 */
export function resolveApprovalKind(input: ApprovalKindInput): ApprovalDecision {
	const tool = input.toolName as ClineDefaultTool
	const scope = resolvePermissionScope(input.toolName, input.context)
	const ceiling = resolveApprovalCeiling(scope, input.ceilings)

	if (ceiling === "manual_only") {
		return { kind: "manual", scope, ceiling }
	}
	if (input.inheritsApproval === true) {
		return { kind: "none", scope, ceiling }
	}
	if (ownsItsInteraction(tool) || withdrawsAnApprovedEffect(tool)) {
		return { kind: "none", scope, ceiling }
	}

	const blanketGrants = input.blanket?.yoloMode === true || input.blanket?.approveAll === true
	const scopedToggleGrants = input.context?.isToolAutoApproveEnabled !== false && isScopeToggledOn(scope, input.settings)
	if (blanketGrants || scopedToggleGrants) {
		return { kind: "automatic", scope, ceiling }
	}
	if (ceiling === "ai_approvable") {
		return { kind: "ai_approver", scope, ceiling }
	}
	return { kind: "manual", scope, ceiling }
}
