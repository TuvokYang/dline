/**
 * Input semantic catalog: the single contract describing which chat-input
 * commands and mentions exist, how their payload is written, and how they may
 * be combined in one submission.
 *
 * The catalog is owned by Core and projected to the Webview. Both sides resolve
 * a node by its stable `id` rather than by re-parsing the typed trigger, so a
 * renamed trigger or a localized label can never change admission behavior.
 */

/** Which trigger family a descriptor belongs to. */
export type InputSemanticKind = "command" | "mention"

/** How the argument that follows the trigger is written and validated. */
export type InputSemanticPayload =
	/** The trigger stands alone. */
	| "none"
	/** Free-form text argument, for example a report description. */
	| "text"
	/** Workspace-relative path. */
	| "path"
	/** Absolute URL. */
	| "url"
	/** Stable identity of a discovered capability, for example a skill name. */
	| "capability"

/** Whether a node may share a submission with other semantic nodes. */
export type InputSemanticComposition =
	/** May be combined freely with any other combinable node. */
	| "combinable"
	/** Must be the only semantic node in the submission. */
	| "exclusive"

/** When the effect of a node ends. */
export type InputSemanticLifecycle =
	/** Applies to the turn it was submitted with. */
	| "turn"
	/** Changes durable task state and therefore establishes a lifecycle barrier. */
	| "task"

export interface InputSemanticDescriptor {
	/** Stable identity. Never derived from a label or from user-facing text. */
	readonly id: string
	readonly kind: InputSemanticKind
	/** Literal trigger the user types, including its sigil. */
	readonly trigger: string
	/** Additional accepted triggers kept for backward compatibility. */
	readonly aliases?: readonly string[]
	readonly payload: InputSemanticPayload
	readonly composition: InputSemanticComposition
	readonly lifecycle: InputSemanticLifecycle
	/**
	 * Present when the node authorizes one tool for the turn it is submitted
	 * with. Admission uses this to register explicit authorization instead of
	 * re-deriving intent from the raw text.
	 */
	readonly authorizes?: string
	/** True when the descriptor comes from discovered workspace capabilities rather than the built-in set. */
	readonly dynamic?: boolean
}

export interface InputSemanticCatalog {
	/**
	 * Monotonic revision of the descriptor set. A consumer that holds an older
	 * revision must refresh before it resolves a node, because a descriptor may
	 * have been withdrawn with its capability.
	 */
	readonly revision: number
	readonly descriptors: readonly InputSemanticDescriptor[]
}

/** Built-in command and mention descriptors that exist without workspace discovery. */
export const BUILTIN_INPUT_SEMANTICS: readonly InputSemanticDescriptor[] = [
	{
		id: "command.compact",
		kind: "command",
		trigger: "/compact",
		aliases: ["/smol", "/cmd:compact", "/cmd:smol"],
		payload: "none",
		composition: "exclusive",
		lifecycle: "task",
		authorizes: "summarize_task",
	},
	{
		id: "command.new_task",
		kind: "command",
		trigger: "/newtask",
		aliases: ["/cmd:newtask"],
		payload: "text",
		composition: "exclusive",
		lifecycle: "task",
		authorizes: "new_task",
	},
	{
		id: "command.new_rule",
		kind: "command",
		trigger: "/newrule",
		aliases: ["/cmd:newrule"],
		payload: "text",
		composition: "exclusive",
		lifecycle: "task",
		authorizes: "new_rule",
	},
	{
		id: "command.report_bug",
		kind: "command",
		trigger: "/reportbug",
		aliases: ["/cmd:reportbug"],
		payload: "text",
		composition: "exclusive",
		lifecycle: "task",
		authorizes: "report_bug",
	},
	{
		id: "command.deep_planning",
		kind: "command",
		trigger: "/deep-planning",
		aliases: ["/cmd:deep-planning"],
		payload: "text",
		composition: "exclusive",
		lifecycle: "task",
		authorizes: "new_task",
	},
	{
		id: "command.explain_changes",
		kind: "command",
		trigger: "/explain-changes",
		aliases: ["/cmd:explain-changes"],
		payload: "none",
		composition: "exclusive",
		lifecycle: "turn",
	},
	{
		id: "mention.file",
		kind: "mention",
		trigger: "@",
		payload: "path",
		composition: "combinable",
		lifecycle: "turn",
	},
	{
		id: "mention.url",
		kind: "mention",
		trigger: "@http",
		payload: "url",
		composition: "combinable",
		lifecycle: "turn",
	},
	{
		id: "mention.problems",
		kind: "mention",
		trigger: "@problems",
		payload: "none",
		composition: "combinable",
		lifecycle: "turn",
	},
	{
		id: "mention.terminal",
		kind: "mention",
		trigger: "@terminal",
		payload: "none",
		composition: "combinable",
		lifecycle: "turn",
	},
	{
		id: "mention.git_changes",
		kind: "mention",
		trigger: "@git-changes",
		payload: "none",
		composition: "combinable",
		lifecycle: "turn",
	},
]

/** Trigger prefixes that address a discovered capability by name. */
export const DYNAMIC_SEMANTIC_PREFIXES: Readonly<Record<string, InputSemanticKind>> = {
	"/skills:": "command",
	"/workflow:": "command",
	"/mcp:": "command",
}

export interface CatalogCompositionViolation {
	readonly code: "exclusive_node_combined" | "unknown_node"
	readonly nodeId: string
}

/** Resolve one descriptor by its stable identity. */
export function findDescriptor(catalog: InputSemanticCatalog, nodeId: string): InputSemanticDescriptor | undefined {
	return catalog.descriptors.find((descriptor) => descriptor.id === nodeId)
}

/**
 * Validate one submission's node set against the composition policy.
 *
 * An exclusive node changes durable task state, so it cannot share a
 * submission: the user would otherwise have no way to tell which effect the
 * turn actually authorized.
 */
export function validateComposition(
	catalog: InputSemanticCatalog,
	nodeIds: readonly string[],
): readonly CatalogCompositionViolation[] {
	const violations: CatalogCompositionViolation[] = []
	const resolved: InputSemanticDescriptor[] = []
	for (const nodeId of nodeIds) {
		const descriptor = findDescriptor(catalog, nodeId)
		if (!descriptor) {
			violations.push({ code: "unknown_node", nodeId })
			continue
		}
		resolved.push(descriptor)
	}
	if (resolved.length > 1) {
		for (const descriptor of resolved) {
			if (descriptor.composition === "exclusive") {
				violations.push({ code: "exclusive_node_combined", nodeId: descriptor.id })
			}
		}
	}
	return violations
}

/** True when the node set establishes a task lifecycle barrier for the submission. */
export function establishesLifecycleBarrier(catalog: InputSemanticCatalog, nodeIds: readonly string[]): boolean {
	return nodeIds.some((nodeId) => findDescriptor(catalog, nodeId)?.lifecycle === "task")
}

/** Tools that the node set explicitly authorizes for its turn. */
export function authorizedTools(catalog: InputSemanticCatalog, nodeIds: readonly string[]): readonly string[] {
	const tools = nodeIds
		.map((nodeId) => findDescriptor(catalog, nodeId)?.authorizes)
		.filter((tool): tool is string => tool !== undefined)
	return [...new Set(tools)]
}
