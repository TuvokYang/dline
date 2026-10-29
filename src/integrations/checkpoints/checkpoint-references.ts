import {
    type CheckpointReferenceSet,
    createCheckpointReferenceSet,
    normalizeCheckpointHashes,
    normalizeCheckpointWorkspaceRoots,
} from "@shared/checkpoints"

/**
 * Encode a file checkpoint reference set as the canonical checkpoint's opaque
 * workspace reference.
 *
 * A single hash with no recorded root is stored bare, so references written
 * before multi-root checkpoints and references written now share one form.
 * Every other set is stored as JSON and keeps each hash bound to its root.
 */
export function encodeCheckpointWorkspaceRef(references: CheckpointReferenceSet): string {
    if (references.workspaceRoots.length === 0 && references.hashes.length === 1) return references.hashes[0]
    return JSON.stringify({ hashes: references.hashes, workspaceRoots: references.workspaceRoots })
}

/**
 * Decode a canonical workspace reference back into the reference set it names.
 *
 * Returns undefined for a reference that names no file checkpoint, so a
 * malformed reference fails the workspace restore instead of resetting a root
 * to an unintended commit.
 */
export function decodeCheckpointWorkspaceRef(workspaceRef: string): CheckpointReferenceSet | undefined {
    if (!workspaceRef.startsWith("{")) {
        return workspaceRef.length > 0 ? createCheckpointReferenceSet([workspaceRef], []) : undefined
    }
    try {
        const parsed = JSON.parse(workspaceRef) as { hashes?: unknown; workspaceRoots?: unknown }
        const hashes = normalizeCheckpointHashes(parsed.hashes)
        if (!hashes.some((hash) => hash.length > 0)) return undefined
        return createCheckpointReferenceSet(hashes, normalizeCheckpointWorkspaceRoots(parsed.workspaceRoots))
    } catch {
        return undefined
    }
}
