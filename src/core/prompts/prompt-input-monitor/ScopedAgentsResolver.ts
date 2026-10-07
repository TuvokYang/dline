import fs from "node:fs/promises"
import path from "node:path"

export const SCOPED_AGENTS_FILE_MAX_BYTES = 12_000
export const SCOPED_AGENTS_TURN_HARD_MAX_BYTES = 48_000
const AGENTS_FILE_NAME = "AGENTS.md"
const TRUNCATION_MARKER = "\n[AGENTS.md truncated]"

export interface ScopedAgentsTarget {
	readonly absolutePath: string
	readonly kind: "file" | "directory"
}

export interface ScopedAgentsCandidate {
	readonly workspaceRoot: string
	readonly workspaceRootIndex: number
	readonly absolutePath: string
	readonly relativePath: string
	readonly scopeRelativeDirectory: string
	readonly state: "present" | "missing" | "unreadable"
	readonly content?: string
	readonly contentBytes: number
	readonly truncated: boolean
	readonly diagnostic?: "invalid_utf8" | "read_failed"
}

export interface ScopedAgentsResolution {
	readonly candidates: readonly ScopedAgentsCandidate[]
	readonly diagnostics: Readonly<Record<"invalid_utf8" | "read_failed", number>>
}

export interface ScopedAgentsBudgetEntry {
	readonly workspaceRootIndex: number
	readonly relativePath: string
	readonly content: string
	readonly truncated: boolean
}

export interface ScopedAgentsBudgetResult {
	readonly entries: readonly ScopedAgentsBudgetEntry[]
	readonly content: string
	readonly contentBytes: number
	readonly omittedCount: number
}

function comparablePath(candidate: string): string {
	const resolved = path.resolve(candidate)
	return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function resolveWorkspaceRoot(roots: readonly string[], candidate: string): { root: string; index: number } | undefined {
	const resolvedCandidate = comparablePath(candidate)
	return roots
		.map((root, index) => ({ root: path.resolve(root), comparable: comparablePath(root), index }))
		.filter((entry) => isWithin(entry.comparable, resolvedCandidate))
		.sort((left, right) => right.comparable.length - left.comparable.length || left.index - right.index)[0]
}

function candidatePaths(
	roots: readonly string[],
	targets: readonly ScopedAgentsTarget[],
): Array<{
	workspaceRoot: string
	workspaceRootIndex: number
	absolutePath: string
}> {
	const candidates = new Map<string, { workspaceRoot: string; workspaceRootIndex: number; absolutePath: string }>()
	for (const target of targets) {
		const owner = resolveWorkspaceRoot(roots, target.absolutePath)
		if (!owner) continue
		const targetDirectory = path.resolve(
			target.kind === "directory" ? target.absolutePath : path.dirname(target.absolutePath),
		)
		if (!isWithin(comparablePath(owner.root), comparablePath(targetDirectory))) continue
		const relativeDirectory = path.relative(owner.root, targetDirectory)
		if (!relativeDirectory) continue
		let current = owner.root
		for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
			current = path.join(current, segment)
			const agentsPath = path.join(current, AGENTS_FILE_NAME)
			candidates.set(comparablePath(agentsPath), {
				workspaceRoot: owner.root,
				workspaceRootIndex: owner.index,
				absolutePath: agentsPath,
			})
		}
	}
	return [...candidates.values()].sort((left, right) => {
		if (left.workspaceRootIndex !== right.workspaceRootIndex) return left.workspaceRootIndex - right.workspaceRootIndex
		const leftRelative = path.relative(left.workspaceRoot, left.absolutePath)
		const rightRelative = path.relative(right.workspaceRoot, right.absolutePath)
		const depthDifference = leftRelative.split(path.sep).length - rightRelative.split(path.sep).length
		return depthDifference || leftRelative.localeCompare(rightRelative)
	})
}

function decodeUtf8Prefix(buffer: Buffer, maxBytes: number): string | undefined {
	const limited = buffer.subarray(0, Math.min(buffer.length, Math.max(0, maxBytes)))
	for (let end = limited.length; end >= Math.max(0, limited.length - 3); end--) {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(limited.subarray(0, end))
		} catch {
			// A UTF-8 code point can span at most four bytes, so only the tail may be partial.
		}
	}
	return undefined
}

export function sliceUtf8ByBytes(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return ""
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
	return decodeUtf8Prefix(Buffer.from(value, "utf8"), maxBytes) ?? ""
}

async function readCandidate(input: {
	workspaceRoot: string
	workspaceRootIndex: number
	absolutePath: string
}): Promise<ScopedAgentsCandidate> {
	const relativePath = path.relative(input.workspaceRoot, input.absolutePath).split(path.sep).join("/")
	const scopeRelativeDirectory = path.dirname(relativePath).split(path.sep).join("/")
	let handle: fs.FileHandle | undefined
	try {
		handle = await fs.open(input.absolutePath, "r")
		const buffer = Buffer.alloc(SCOPED_AGENTS_FILE_MAX_BYTES + 4)
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
		const truncated = bytesRead > SCOPED_AGENTS_FILE_MAX_BYTES
		const content = decodeUtf8Prefix(buffer.subarray(0, bytesRead), SCOPED_AGENTS_FILE_MAX_BYTES)
		if (content === undefined) {
			return {
				...input,
				relativePath,
				scopeRelativeDirectory,
				state: "unreadable",
				contentBytes: 0,
				truncated: false,
				diagnostic: "invalid_utf8",
			}
		}
		return {
			...input,
			relativePath,
			scopeRelativeDirectory,
			state: "present",
			content,
			contentBytes: Buffer.byteLength(content, "utf8"),
			truncated,
		}
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined
		return {
			...input,
			relativePath,
			scopeRelativeDirectory,
			state: code === "ENOENT" || code === "EISDIR" ? "missing" : "unreadable",
			contentBytes: 0,
			truncated: false,
			...(code === "ENOENT" || code === "EISDIR" ? {} : { diagnostic: "read_failed" as const }),
		}
	} finally {
		await handle?.close().catch(() => undefined)
	}
}

export async function resolveScopedAgents(
	workspaceRoots: readonly string[],
	targets: readonly ScopedAgentsTarget[],
): Promise<ScopedAgentsResolution> {
	const candidates = await Promise.all(candidatePaths(workspaceRoots, targets).map(readCandidate))
	const diagnostics = { invalid_utf8: 0, read_failed: 0 }
	for (const candidate of candidates) {
		if (candidate.diagnostic) diagnostics[candidate.diagnostic]++
	}
	return { candidates, diagnostics }
}

function renderEntry(entry: ScopedAgentsBudgetEntry): string {
	return `## ${entry.relativePath}\n\n${entry.content}${entry.truncated ? TRUNCATION_MARKER : ""}`
}

export function applyScopedAgentsTurnBudget(
	candidates: readonly ScopedAgentsCandidate[],
	maxBytes = SCOPED_AGENTS_TURN_HARD_MAX_BYTES,
): ScopedAgentsBudgetResult {
	const present = candidates
		.filter(
			(candidate): candidate is ScopedAgentsCandidate & { state: "present"; content: string } =>
				candidate.state === "present" && typeof candidate.content === "string" && candidate.content.length > 0,
		)
		.sort((left, right) => {
			if (left.workspaceRootIndex !== right.workspaceRootIndex) return left.workspaceRootIndex - right.workspaceRootIndex
			const depthDifference = left.relativePath.split("/").length - right.relativePath.split("/").length
			return depthDifference || left.relativePath.localeCompare(right.relativePath)
		})
	const entries: ScopedAgentsBudgetEntry[] = []
	let remaining = Math.max(0, Math.min(maxBytes, SCOPED_AGENTS_TURN_HARD_MAX_BYTES))
	let omittedCount = 0

	for (let index = 0; index < present.length; index++) {
		const candidate = present[index]
		const baseEntry: ScopedAgentsBudgetEntry = {
			workspaceRootIndex: candidate.workspaceRootIndex,
			relativePath: candidate.relativePath,
			content: candidate.content,
			truncated: candidate.truncated,
		}
		const separatorBytes = entries.length === 0 ? 0 : Buffer.byteLength("\n\n", "utf8")
		const renderedBytes = Buffer.byteLength(renderEntry(baseEntry), "utf8")
		if (separatorBytes + renderedBytes <= remaining) {
			entries.push(baseEntry)
			remaining -= separatorBytes + renderedBytes
			continue
		}

		const emptyEntry = { ...baseEntry, content: "", truncated: true }
		const overheadBytes = separatorBytes + Buffer.byteLength(renderEntry(emptyEntry), "utf8")
		let includedCurrent = false
		if (remaining > overheadBytes) {
			const content = sliceUtf8ByBytes(candidate.content, remaining - overheadBytes)
			entries.push({ ...baseEntry, content, truncated: true })
			remaining = 0
			includedCurrent = true
		}
		omittedCount += present.length - index - (includedCurrent ? 1 : 0)
		break
	}

	const content = entries.map(renderEntry).join("\n\n")
	return { entries, content, contentBytes: Buffer.byteLength(content, "utf8"), omittedCount }
}
