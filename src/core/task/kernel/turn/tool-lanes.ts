import { ClineDefaultTool } from "@shared/tools"

/**
 * Exclusivity lanes for concurrent tool execution.
 *
 * A lane names a resource that cannot be shared by two executions at the same
 * time. Concurrency eligibility is a resource question, not a read/write one:
 * two writes to different paths still collide, because the editor they drive is
 * a single Task-level instance holding per-edit state.
 *
 * Lanes are strings rather than an enum because two of them are parameterised
 * by a runtime value — the MCP server name and the resolved write path — and
 * those cannot be enumerated ahead of time.
 */
export type ToolLane = string

/** The shared DiffViewProvider instance and its mutable per-edit state. */
export const LANE_DIFF_EDITOR = "diff-editor"

/** The shared browser session, which unrelated tools also close and replace. */
export const LANE_BROWSER_SESSION = "browser-session"

/** The checkpoint committer, which writes one shadow git repository. */
export const LANE_CHECKPOINT = "checkpoint"

/** The foreground terminal, which is one visible device with ordered output. */
export const LANE_FOREGROUND_TERMINAL = "foreground-terminal"

/** The single user-interaction slot the reducer permits. */
export const LANE_USER_INTERACTION = "user-interaction"

/**
 * The hub-wide MCP pending-notification queue.
 *
 * `McpHub.getPendingNotifications()` copies and clears one array shared by every
 * server, and each MCP call drains it around its own request. A per-server lane
 * alone is therefore not enough: a call to server A would consume notifications
 * emitted for a concurrent call to server B. Until the queue is per-server, MCP
 * calls that drain it hold this lane as well.
 */
export const LANE_MCP_NOTIFICATIONS = "mcp-notifications"

/** Conservative lane for write fan-out whose final targets are discovered at execution time. */
export const LANE_DYNAMIC_WRITE_FANOUT = "dynamic-write-fanout"

/**
 * The task-level subagent execution flag.
 *
 * Both subagent paths set `taskState.isExecutingSubagent` on entry and clear it
 * in `finally`, so two overlapping outer subagent tools would have the first to
 * finish clear the flag while the second is still running.
 */
export const LANE_SUBAGENT_EXECUTION = "subagent-execution"

/**
 * The shared file-read accounting cache.
 *
 * Read handlers perform a read/increment/write against one cache, so concurrent
 * reads of the same file can both observe no entry and each store a first read.
 */
export const LANE_FILE_READ_ACCOUNTING = "file-read-accounting"

/** One MCP server connection, which serialises its own request stream. */
export function mcpServerLane(serverName: string): ToolLane {
	return `mcp-server:${serverName}`
}

/** One canonical write path, so two edits of the same file cannot interleave. */
export function writePathLane(canonicalPath: string): ToolLane {
	return `write-path:${canonicalPath}`
}

/**
 * Runtime facts a tool block contributes to its own lane set.
 *
 * These are read from the block's parameters by the caller. The lane function
 * stays pure and does not resolve paths or inspect the workspace itself.
 */
export interface ToolLaneContext {
	/** Resolved MCP server name, for tools that address one server. */
	mcpServerName?: string
	/**
	 * Canonical absolute write paths this execution will modify.
	 *
	 * A list rather than a single path because apply_patch, replace_text and
	 * rename each modify several files in one invocation. A single path would
	 * leave the second and later files unprotected, and the shared diff-editor
	 * lane would be hiding that rather than solving it.
	 */
	canonicalWritePaths?: readonly string[]
	/** Fall back to one global write lane when canonical targets cannot be confirmed. */
	conservativeWriteFanout?: boolean
}

/** Minimal structural input accepted by the pure lane resolver. */
export interface ToolLaneBlock {
	name: string
	params?: Record<string, unknown>
}

/** Derive lane context from one finalized tool block without touching its target. */
export function resolveLaneContext(tool: ToolLaneBlock): ToolLaneContext {
	const serverName = tool.params?.server_name
	return {
		mcpServerName: typeof serverName === "string" ? serverName : undefined,
	}
}

/**
 * Lanes held by every built-in tool, before runtime context is applied.
 *
 * A tool absent from this map holds no static lane; it may still acquire a
 * parameterised lane through its context. Read-only tools are deliberately
 * absent — they are the tools that may overlap freely.
 */
const STATIC_LANES: Partial<Record<ClineDefaultTool, readonly ToolLane[]>> = {
	// Every file-editing tool drives the one shared DiffViewProvider. Its
	// open() overwrites editType, originalContent and isEditing, so two edits
	// corrupt each other even when their paths differ.
	[ClineDefaultTool.FILE_NEW]: [LANE_DIFF_EDITOR],
	[ClineDefaultTool.FILE_EDIT]: [LANE_DIFF_EDITOR],
	[ClineDefaultTool.NEW_RULE]: [LANE_DIFF_EDITOR],
	[ClineDefaultTool.APPLY_PATCH]: [LANE_DIFF_EDITOR],
	[ClineDefaultTool.REPLACE_TEXT]: [LANE_DIFF_EDITOR, LANE_DYNAMIC_WRITE_FANOUT],
	[ClineDefaultTool.RENAME]: [LANE_DIFF_EDITOR, LANE_DYNAMIC_WRITE_FANOUT],

	// The browser handler reassigns config.services.browserSession on launch,
	// so a concurrent action would address a session that no longer exists.
	[ClineDefaultTool.BROWSER]: [LANE_BROWSER_SESSION],

	// Command execution owns the foreground terminal device.
	//
	// A command can also rewrite files it never named, which no lane here can
	// express. That reach is deliberately not contained by an exclusivity lane:
	// the prompt discourages it today, and the intended mechanisms are the AI
	// approver and a command sandbox allowlist. Serialising every command
	// against every edit would be a large standing cost for a guarantee this
	// lane cannot actually provide.
	[ClineDefaultTool.BASH]: [LANE_FOREGROUND_TERMINAL],
	[ClineDefaultTool.KILL_COMMAND]: [LANE_FOREGROUND_TERMINAL],

	// Both subagent entry points own the same task-level execution flag.
	[ClineDefaultTool.USE_SUBAGENT]: [LANE_SUBAGENT_EXECUTION],
	[ClineDefaultTool.USE_SUBAGENTS]: [LANE_SUBAGENT_EXECUTION],

	// Read handlers share the file-read accounting cache.
	[ClineDefaultTool.FILE_READ]: [LANE_FILE_READ_ACCOUNTING],

	// MCP calls drain the hub-wide notification queue around their request.
	[ClineDefaultTool.MCP_USE]: [LANE_MCP_NOTIFICATIONS],

	// Turn-ending and conversational tools occupy the one interaction slot.
	[ClineDefaultTool.ATTEMPT]: [LANE_USER_INTERACTION],
	[ClineDefaultTool.ASK]: [LANE_USER_INTERACTION],
	[ClineDefaultTool.MAKE_PLAN]: [LANE_USER_INTERACTION],
	[ClineDefaultTool.QNA_RESPOND]: [LANE_USER_INTERACTION],
	[ClineDefaultTool.GENERATE_REPORT]: [LANE_USER_INTERACTION],
	[ClineDefaultTool.ACT_MODE]: [LANE_USER_INTERACTION],
	[ClineDefaultTool.STATUS_UPDATE]: [LANE_USER_INTERACTION],
	[ClineDefaultTool.NEW_TASK]: [LANE_USER_INTERACTION],
	[ClineDefaultTool.SPAWN_TASK]: [LANE_USER_INTERACTION],
	[ClineDefaultTool.REPORT_BUG]: [LANE_USER_INTERACTION],
	[ClineDefaultTool.CONDENSE]: [LANE_USER_INTERACTION],
	[ClineDefaultTool.SUMMARIZE_TASK]: [LANE_USER_INTERACTION],

	// The focus chain rewrites the one shared todo list.
	[ClineDefaultTool.TODO]: [LANE_USER_INTERACTION],
	[ClineDefaultTool.CHANGE_TODO_LIST]: [LANE_USER_INTERACTION],
}

/**
 * Resolve every lane a tool execution must hold exclusively.
 *
 * @param toolName Registered tool identity.
 * @param context Runtime facts read from the block's parameters.
 * @returns Lanes to acquire; empty when the tool may overlap freely.
 */
export function resolveToolLanes(toolName: string, context: ToolLaneContext = {}): ToolLane[] {
	const lanes = new Set<ToolLane>(STATIC_LANES[toolName as ClineDefaultTool] ?? [])

	if (context.mcpServerName) {
		lanes.add(mcpServerLane(context.mcpServerName))
	}
	for (const writePath of context.canonicalWritePaths ?? []) {
		if (writePath) {
			lanes.add(writePathLane(writePath))
		}
	}
	if (context.conservativeWriteFanout) lanes.add(LANE_DYNAMIC_WRITE_FANOUT)

	return Array.from(lanes)
}

/**
 * Whether two lane sets may execute concurrently.
 *
 * @param a Lanes held by one execution.
 * @param b Lanes held by another execution.
 * @returns True when the two sets are disjoint.
 */
export function lanesAreCompatible(a: readonly ToolLane[], b: readonly ToolLane[]): boolean {
	if (a.length === 0 || b.length === 0) {
		return true
	}
	const held = new Set(a)
	return !b.some((lane) => held.has(lane))
}

/**
 * Tools that acquire an MCP server lane once their server name is known.
 *
 * The lane is parameterised, so a tool listed here resolves to no static lane
 * and depends on its context. Declaring the dependency explicitly lets the
 * coverage check distinguish "freely concurrent" from "context supplies it".
 */
export const MCP_SCOPED_TOOLS: ReadonlySet<ClineDefaultTool> = new Set([ClineDefaultTool.MCP_USE, ClineDefaultTool.MCP_ACCESS])

/**
 * Tools that acquire a write-path lane once their path is resolved.
 *
 * These already hold the diff-editor lane; the path lane additionally prevents
 * two edits of the same file from being ordered arbitrarily against each other
 * once the editor itself stops being the bottleneck.
 */
export const PATH_SCOPED_TOOLS: ReadonlySet<ClineDefaultTool> = new Set([
	ClineDefaultTool.FILE_NEW,
	ClineDefaultTool.FILE_EDIT,
	ClineDefaultTool.NEW_RULE,
	ClineDefaultTool.APPLY_PATCH,
	ClineDefaultTool.REPLACE_TEXT,
	ClineDefaultTool.RENAME,
])

/**
 * Tools that are free of exclusivity constraints.
 *
 * Membership is an assertion that the tool touches no shared mutable runtime
 * resource. It exists so a newly added tool fails the coverage check rather
 * than silently defaulting to unrestricted concurrency.
 */
export const UNRESTRICTED_TOOLS: ReadonlySet<ClineDefaultTool> = new Set([
	ClineDefaultTool.SEARCH,
	ClineDefaultTool.LIST_FILES,
	ClineDefaultTool.LIST_CODE_DEF,
	ClineDefaultTool.FIND_REFERENCES,
	ClineDefaultTool.WEB_FETCH,
	ClineDefaultTool.WEB_SEARCH,
	ClineDefaultTool.MCP_DOCS,
	ClineDefaultTool.LOAD_MCP,
	ClineDefaultTool.LOAD_SKILL,
	ClineDefaultTool.LOAD_WORKFLOW,
	ClineDefaultTool.GENERATE_EXPLANATION,
	ClineDefaultTool.GENERATE_IMAGE,
])

/**
 * Whether a tool's lane assignment has been declared.
 *
 * Every registered tool must be classified, so that adding one is a deliberate
 * decision about what it may run beside rather than an omission.
 *
 * @param toolName Registered tool identity.
 * @returns True when the tool holds a static lane, resolves a parameterised
 *   one, or is explicitly declared unrestricted.
 */
export function hasDeclaredLaneAssignment(toolName: string): boolean {
	const tool = toolName as ClineDefaultTool
	return (
		STATIC_LANES[tool] !== undefined ||
		MCP_SCOPED_TOOLS.has(tool) ||
		PATH_SCOPED_TOOLS.has(tool) ||
		UNRESTRICTED_TOOLS.has(tool)
	)
}
