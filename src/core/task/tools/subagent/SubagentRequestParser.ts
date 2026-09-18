import { MAX_SUBAGENTS_PER_BATCH } from "@shared/concurrency-limits"
import { DEFAULT_SUBAGENT_TIMEOUT_SECONDS } from "@shared/subagent-settings"

/**
 * Parameters the batch tool used to take, one prompt per slot.
 *
 * Retained only to recognise them: a model still emitting this shape, or a task
 * resumed from history that contains it, must be told what to send instead
 * rather than be met with "missing required parameter: subagents", which
 * describes the absence but not the cause.
 */
const REMOVED_PROMPT_KEYS = ["prompt_1", "prompt_2", "prompt_3", "prompt_4", "prompt_5"] as const

export interface SubagentToolOptions {
	background: boolean
	timeoutSeconds: number
}

export interface SubagentRunRequest {
	kind: "single"
	agentName: string
	task: string
	context: string
	prompt: string
	options: SubagentToolOptions
}

export interface SubagentBatchItemRequest {
	index: number
	agentName: string
	task: string
	context: string
	prompt: string
	/**
	 * Profile explicitly requested for this item, if any.
	 *
	 * Absent means "resolve normally". An explicit name is a binding decision
	 * and must fail the item when it cannot be honoured, so the distinction
	 * between "unset" and "set but unavailable" is kept rather than collapsed
	 * into a resolved value here.
	 */
	profile?: string
	/** Per-item timeout in seconds; falls back to the batch option when unset. */
	timeoutSeconds?: number
}

export interface SubagentBatchRequest {
	kind: "batch"
	items: SubagentBatchItemRequest[]
	options: SubagentToolOptions
}

/**
 * Read a required non-empty string parameter.
 * @param params Raw tool parameters.
 * @param name Parameter name to read.
 * @returns Trimmed parameter text.
 */
function requireText(params: Record<string, unknown>, name: string): string {
	const value = params[name]
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`Missing required parameter: ${name}`)
	}
	return value.trim()
}

/**
 * Read an optional non-empty string parameter.
 * @param params Raw tool parameters.
 * @param name Parameter name to read.
 * @returns Trimmed parameter text, or undefined.
 */
function readText(params: Record<string, unknown>, name: string): string | undefined {
	const value = params[name]
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * Parse a boolean-like tool option.
 * @param value Raw option value.
 * @returns Parsed boolean option.
 */
function parseBoolean(value: unknown): boolean {
	if (value === undefined) return false
	if (typeof value === "boolean") return value
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase()
		if (!normalized) return false
		if (normalized === "true") return true
		if (normalized === "false") return false
	}
	throw new Error("Invalid background value. Expected true or false.")
}

/**
 * Parse timeout in seconds.
 * @param value Raw timeout value.
 * @returns Positive integer timeout in seconds.
 */
function parseTimeout(value: unknown): number {
	if (value === undefined || value === "") return DEFAULT_SUBAGENT_TIMEOUT_SECONDS
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error("Invalid timeout value. Expected a positive integer number of seconds.")
	}
	return parsed
}

/**
 * Parse shared subagent execution options.
 * @param params Raw tool parameters.
 * @returns Normalized execution options.
 */
function parseOptions(params: Record<string, unknown>): SubagentToolOptions {
	return {
		background: parseBoolean(params.background),
		timeoutSeconds: parseTimeout(params.timeout),
	}
}

/**
 * Extract one XML-like section from a prompt.
 * @param prompt Prompt containing tagged sections.
 * @param tag Section tag name.
 * @returns Trimmed section body.
 */
function extractSection(prompt: string, tag: "task" | "context"): string {
	const pattern = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i")
	const match = prompt.match(pattern)
	const value = match?.[1]?.trim()
	if (!value) {
		throw new Error(`Each prompt must include a non-empty <${tag}> section.`)
	}
	return value
}

/**
 * Parse a stable single-subagent tool request.
 * @param params Raw use_subagent parameters.
 * @returns Normalized single-subagent request.
 */
export function parseUseSubagentRequest(params: Record<string, unknown>): SubagentRunRequest {
	const agentName = readText(params, "agent_name") ?? "default"
	const task = requireText(params, "task")
	const context = requireText(params, "context")
	return {
		kind: "single",
		agentName,
		task,
		context,
		prompt: `<task>\n${task}\n</task>\n<context>\n${context}\n</context>`,
		options: parseOptions(params),
	}
}

/**
 * Read the batch items as a list, from either transport.
 *
 * Native tool calls deliver a real array. The XML and restore paths carry every
 * parameter as text, so the same array arrives as a JSON string; both are the
 * same request and must parse identically rather than force the caller to know
 * which transport it came through.
 *
 * @param value Raw `subagents` parameter.
 * @returns The item list, still unvalidated.
 */
function readItemList(value: unknown): unknown[] {
	if (Array.isArray(value)) {
		return value
	}
	if (typeof value === "string") {
		const text = value.trim()
		if (!text) {
			throw new Error("Missing required parameter: subagents")
		}
		let decoded: unknown
		try {
			decoded = JSON.parse(text)
		} catch {
			throw new Error("Invalid subagents value. Expected a JSON array of subagent items.")
		}
		if (!Array.isArray(decoded)) {
			throw new Error("Invalid subagents value. Expected a JSON array of subagent items.")
		}
		return decoded
	}
	throw new Error("Missing required parameter: subagents")
}

/**
 * Read one required field of a batch item.
 *
 * The item number is part of the message because a batch fails as a whole: the
 * caller has to be told which of up to 32 items to correct, not merely that one
 * of them was wrong.
 *
 * @param item Raw batch item.
 * @param name Field name to read.
 * @param position One-based item position, used for the error message.
 * @returns Trimmed field text.
 */
function requireItemText(item: Record<string, unknown>, name: string, position: number): string {
	const value = item[name]
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`Subagent item ${position} is missing required field: ${name}`)
	}
	return value.trim()
}

/**
 * Read one optional field of a batch item.
 * @param item Raw batch item.
 * @param name Field name to read.
 * @returns Trimmed field text, or undefined.
 */
function readItemText(item: Record<string, unknown>, name: string): string | undefined {
	const value = item[name]
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * Reject the parameters this tool used to take.
 *
 * A model that emits the old shape gets a message naming the replacement, so
 * the next attempt can succeed. Without this the request would fail on the
 * absent `subagents` parameter and give no hint that the contract changed.
 *
 * @param params Raw tool parameters.
 */
function rejectRemovedPromptParams(params: Record<string, unknown>): void {
	const present = REMOVED_PROMPT_KEYS.filter((key) => params[key] !== undefined)
	if (present.length === 0) {
		return
	}
	throw new Error(
		`The ${present.join(", ")} parameter${present.length > 1 ? "s are" : " is"} no longer supported. ` +
			"Send a single subagents array instead, where each item has agent_name, task, context, and optionally profile and timeout.",
	)
}

/**
 * Parse a batch subagent tool request.
 * @param params Raw use_subagents parameters.
 * @returns Normalized batch-subagent request.
 */
export function parseUseSubagentsRequest(params: Record<string, unknown>): SubagentBatchRequest {
	rejectRemovedPromptParams(params)
	const rawItems = readItemList(params.subagents)
	if (rawItems.length === 0) {
		throw new Error("Missing required parameter: subagents")
	}
	if (rawItems.length > MAX_SUBAGENTS_PER_BATCH) {
		throw new Error(
			`Too many subagents: ${rawItems.length}. At most ${MAX_SUBAGENTS_PER_BATCH} items are allowed in one call.`,
		)
	}

	const options = parseOptions(params)
	const items = rawItems.map((raw, position) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error(`Subagent item ${position + 1} must be an object with task and context fields.`)
		}
		const item = raw as Record<string, unknown>
		const task = requireItemText(item, "task", position + 1)
		const context = requireItemText(item, "context", position + 1)
		const itemTimeout = item.timeout
		return {
			index: position + 1,
			agentName: readItemText(item, "agent_name") ?? "default",
			task,
			context,
			prompt: `<task>\n${task}\n</task>\n<context>\n${context}\n</context>`,
			...(readItemText(item, "profile") ? { profile: readItemText(item, "profile") } : {}),
			// An item without its own timeout inherits the batch option rather
			// than carrying a duplicate of it, so raising the shared timeout
			// still reaches every item that did not override it.
			...(itemTimeout === undefined ? {} : { timeoutSeconds: parseTimeout(itemTimeout) }),
		}
	})

	return { kind: "batch", items, options }
}
