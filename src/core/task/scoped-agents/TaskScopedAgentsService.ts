import path from "node:path"
import type { ToolUse } from "@core/assistant-message"
import {
	applyScopedAgentsTurnBudget,
	resolveScopedAgents,
	type ScopedAgentsCandidate,
	type ScopedAgentsTarget,
} from "@core/prompts/prompt-input-monitor/ScopedAgentsResolver"
import type { ClineStorageMessage, ClineUserAgentsInstructionsContentBlock } from "@shared/messages"
import { ClineDefaultTool } from "@shared/tools"

interface WorkspaceRootEntry {
	readonly path: string
	readonly name?: string
}

export interface TaskScopedAgentsServiceDeps {
	readonly cwd: string
	readonly workspaceRoots: () => readonly WorkspaceRootEntry[]
	readonly isEnabled: () => boolean
	readonly history: () => readonly ClineStorageMessage[]
	readonly trackExact: (paths: readonly string[]) => Promise<void>
	readonly onStale: () => void
	readonly resolve?: typeof resolveScopedAgents
}

function comparable(candidate: string): string {
	const resolved = path.resolve(candidate)
	return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function parsePatchPaths(input: string | undefined): string[] {
	if (!input) return []
	const markers = ["*** Add File:", "*** Update File:", "*** Delete File:", "*** Move File:"]
	return input.split("\n").flatMap((line) => {
		const marker = markers.find((candidate) => line.startsWith(candidate))
		const value = marker ? line.slice(marker.length).trim() : ""
		return value ? [value] : []
	})
}

function staticPatternBase(pattern: string): string {
	const wildcard = pattern.search(/[?*[{]/)
	const prefix = wildcard >= 0 ? pattern.slice(0, wildcard) : pattern
	const normalized = prefix.replace(/[\\/]+$/, "")
	return normalized ? path.dirname(normalized) : "."
}

function resolveDeclaredPath(candidate: string, cwd: string, roots: readonly WorkspaceRootEntry[]): string {
	if (path.isAbsolute(candidate)) return path.resolve(candidate)
	if (candidate.startsWith("@")) {
		const separator = candidate.indexOf("/")
		const name = separator >= 0 ? candidate.slice(1, separator) : candidate.slice(1)
		const relative = separator >= 0 ? candidate.slice(separator + 1) : ""
		const root = roots.find((entry) => entry.name === name || path.basename(entry.path) === name)
		if (root) return path.resolve(root.path, relative)
	}
	return path.resolve(cwd, candidate)
}

export function projectToolScopedAgentsTargets(
	tools: readonly ToolUse[],
	cwd: string,
	roots: readonly WorkspaceRootEntry[],
): ScopedAgentsTarget[] {
	const targets = new Map<string, ScopedAgentsTarget>()
	const add = (candidate: string | undefined, kind: ScopedAgentsTarget["kind"]) => {
		if (!candidate?.trim()) return
		const absolutePath = resolveDeclaredPath(candidate.trim(), cwd, roots)
		targets.set(comparable(absolutePath), { absolutePath, kind })
	}

	for (const tool of tools) {
		const params = tool.params as Record<string, string | undefined>
		if (tool.name === ClineDefaultTool.APPLY_PATCH) {
			for (const candidate of parsePatchPaths(params.input)) add(candidate, "file")
			continue
		}
		if (tool.name === ClineDefaultTool.BASH) {
			add(params.workdirectory ?? cwd, "directory")
			continue
		}
		if (tool.name === ClineDefaultTool.REPLACE_TEXT && params.file_pattern) {
			add(staticPatternBase(params.file_pattern), "directory")
			continue
		}
		const candidate = params.path ?? params.file_path
		if (!candidate) continue
		const directoryTool =
			tool.name === ClineDefaultTool.LIST_FILES ||
			tool.name === ClineDefaultTool.SEARCH ||
			tool.name === ClineDefaultTool.LIST_CODE_DEF
		add(candidate, directoryTool ? "directory" : "file")
	}
	return [...targets.values()]
}

export class TaskScopedAgentsService {
	private readonly pinned = new Set<string>()
	private hydrated = false
	private stale = false
	private replacementPending = false

	constructor(private readonly deps: TaskScopedAgentsServiceDeps) {}

	async resolveTurn(turnId: string, tools: readonly ToolUse[]): Promise<ClineUserAgentsInstructionsContentBlock | undefined> {
		if (!this.deps.isEnabled()) return undefined
		const roots = this.normalizedRoots()
		this.hydrate(roots)
		const targets = projectToolScopedAgentsTargets(tools, this.deps.cwd, roots)
		if (targets.length === 0) return undefined

		const resolution = await (this.deps.resolve ?? resolveScopedAgents)(
			roots.map((root) => root.path),
			targets,
		)
		await this.deps.trackExact(resolution.candidates.map((candidate) => candidate.absolutePath))
		const newlyPinned: ScopedAgentsCandidate[] = []
		for (const candidate of resolution.candidates) {
			const key = comparable(candidate.absolutePath)
			if (this.pinned.has(key)) continue
			this.pinned.add(key)
			if (candidate.state === "present") newlyPinned.push(candidate)
		}
		if (newlyPinned.length === 0) return undefined

		const budget = applyScopedAgentsTurnBudget(newlyPinned)
		if (!budget.content) return undefined
		const block: ClineUserAgentsInstructionsContentBlock = {
			type: "agents_instructions",
			turn_id: turnId,
			content: budget.content,
			sources: budget.entries.map((entry) => ({
				workspace_root_index: entry.workspaceRootIndex,
				path: entry.relativePath,
				bytes: Buffer.byteLength(entry.content, "utf8"),
				...(entry.truncated ? { truncated: true } : {}),
			})),
			...(budget.omittedCount > 0 ? { omitted_count: budget.omittedCount } : {}),
			...(this.replacementPending ? { replaces_previous: true } : {}),
		}
		this.replacementPending = false
		return block
	}

	markChanged(absolutePath: string): void {
		if (!this.pinned.has(comparable(absolutePath)) || this.stale) return
		this.stale = true
		this.deps.onStale()
	}

	refresh(): void {
		if (this.pinned.size === 0 && !this.stale) return
		this.pinned.clear()
		this.stale = false
		this.replacementPending = true
	}

	private normalizedRoots(): WorkspaceRootEntry[] {
		const configured = this.deps.workspaceRoots()
		return configured.length > 0
			? configured.map((root) => ({ ...root, path: path.resolve(root.path) }))
			: [{ path: this.deps.cwd }]
	}

	private hydrate(roots: readonly WorkspaceRootEntry[]): void {
		if (this.hydrated) return
		this.hydrated = true
		for (const message of this.deps.history()) {
			if (!Array.isArray(message.content)) continue
			for (const block of message.content) {
				if (block.type !== "agents_instructions") continue
				for (const source of block.sources) {
					const root = roots[source.workspace_root_index]
					if (root) this.pinned.add(comparable(path.join(root.path, source.path)))
				}
			}
		}
	}
}
