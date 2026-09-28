import * as path from "path"
import type { ClineMessage } from "./ExtensionMessage"

export interface CheckpointReferenceSet {
	hashes: string[]
	workspaceRoots: string[]
}

function normalizeWorkspacePath(workspacePath: string): string {
	const resolved = path.resolve(workspacePath)
	return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** Promote persisted legacy scalar hashes to the current ordered reference set. */
export function normalizeCheckpointHashes(value: unknown): string[] {
	if (typeof value === "string") {
		return value.length > 0 ? [value] : []
	}
	if (!Array.isArray(value)) {
		return []
	}
	return value.filter((hash): hash is string => typeof hash === "string")
}

export function normalizeCheckpointWorkspaceRoots(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return []
	}
	return value.filter((workspacePath): workspacePath is string => typeof workspacePath === "string" && workspacePath.length > 0)
}

export function createCheckpointReferenceSet(
	hashes: readonly string[],
	workspaceRoots: readonly string[],
): CheckpointReferenceSet {
	return {
		hashes: [...hashes],
		workspaceRoots: [...workspaceRoots],
	}
}

export function hasFileCheckpoint(referenceSet: CheckpointReferenceSet | undefined): boolean {
	return referenceSet?.hashes.some((hash) => hash.length > 0) ?? false
}

export function readCheckpointReferenceSet(input: {
	lastCheckpointHash?: unknown
	checkpointWorkspaceRoots?: unknown
}): CheckpointReferenceSet | undefined {
	const hashes = normalizeCheckpointHashes(input.lastCheckpointHash)
	if (hashes.length === 0) {
		return undefined
	}
	return createCheckpointReferenceSet(hashes, normalizeCheckpointWorkspaceRoots(input.checkpointWorkspaceRoots))
}

/** Normalize one persisted message without retaining the legacy scalar representation. */
export function normalizeStoredCheckpointMessage(message: ClineMessage): ClineMessage {
	const legacyValue = (message as ClineMessage & { lastCheckpointHash?: unknown }).lastCheckpointHash
	if (legacyValue === undefined) {
		return message
	}
	const hashes = normalizeCheckpointHashes(legacyValue)
	const workspaceRoots = normalizeCheckpointWorkspaceRoots(
		(message as ClineMessage & { checkpointWorkspaceRoots?: unknown }).checkpointWorkspaceRoots,
	)
	return {
		...message,
		lastCheckpointHash: hashes,
		...(workspaceRoots.length > 0 ? { checkpointWorkspaceRoots: workspaceRoots } : {}),
	}
}

/** Resolve by persisted root identity, using array position only for legacy references without root metadata. */
export function getCheckpointHashForWorkspace(
	referenceSet: CheckpointReferenceSet,
	workspacePath: string,
	fallbackIndex: number,
): string | undefined {
	const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath)
	const persistedIndex = referenceSet.workspaceRoots.findIndex(
		(candidate) => normalizeWorkspacePath(candidate) === normalizedWorkspacePath,
	)
	if (persistedIndex >= 0) {
		const hash = referenceSet.hashes[persistedIndex]
		return hash && hash.length > 0 ? hash : undefined
	}
	if (referenceSet.workspaceRoots.length > 0) {
		return undefined
	}
	const legacyHash = referenceSet.hashes[fallbackIndex]
	return legacyHash && legacyHash.length > 0 ? legacyHash : undefined
}

export function checkpointReferenceSetsEqual(
	left: CheckpointReferenceSet | undefined,
	right: CheckpointReferenceSet | undefined,
): boolean {
	if (!left || !right) {
		return false
	}
	const leftHasRoots = left.workspaceRoots.length > 0
	const rightHasRoots = right.workspaceRoots.length > 0
	if (leftHasRoots || rightHasRoots) {
		if (
			!leftHasRoots ||
			!rightHasRoots ||
			left.workspaceRoots.length !== right.workspaceRoots.length ||
			left.hashes.length !== left.workspaceRoots.length ||
			right.hashes.length !== right.workspaceRoots.length
		) {
			return false
		}
		return left.workspaceRoots.every((workspaceRoot, index) => {
			const leftHash = left.hashes[index] ?? ""
			const rightHash = getCheckpointHashForWorkspace(right, workspaceRoot, index) ?? ""
			return leftHash === rightHash
		})
	}
	return left.hashes.length === right.hashes.length && left.hashes.every((hash, index) => hash === right.hashes[index])
}
