import type { UiMessage } from "../ExtensionMessage"

interface PersistedCheckpointReferences {
    readonly hashes: readonly string[]
    readonly workspaceRoots: readonly string[]
}

type PersistedCheckpointState =
    | { readonly kind: "chat-only" }
    | { readonly kind: "files"; readonly references: PersistedCheckpointReferences }
    | { readonly kind: "ambiguous" }

/**
 * Drop an earlier checkpoint only when the next drawn checkpoint completely
 * supersedes its visible restore place.
 *
 * Stored rows remain untouched. This projection is evaluated from the final
 * transcript, so a Retry that later hides its failed request cannot leave two
 * indistinguishable checkpoints on screen merely because the backend observed
 * the rows before that request was recorded.
 */
export function dropSupersededAdjacentCheckpoints(drawn: readonly UiMessage[]): UiMessage[] {
    const projected: UiMessage[] = []
    for (const message of drawn) {
        while (projected.length > 0 && supersedesAdjacentCheckpoint(projected[projected.length - 1], message)) {
            projected.pop()
        }
        projected.push(message)
    }
    return projected
}

/** Whether `later` stands in the same drawn restore place as `earlier`. */
export function supersedesAdjacentCheckpoint(earlier: UiMessage, later: UiMessage | undefined): boolean {
    if (earlier.say !== "checkpoint_created" || later?.say !== "checkpoint_created") return false
    if (later.partial === true || earlier.isCheckpointCheckedOut) return false

    const earlierState = readPersistedState(earlier)
    if (earlierState.kind === "chat-only") {
        // Preserve the existing chat-only rule: the later checkpoint restores the
        // same visible conversation and may additionally restore files.
        return true
    }
    if (earlierState.kind === "ambiguous") return false

    const laterState = readPersistedState(later)
    if (laterState.kind !== "files" || !isRoundCheckpoint(earlier) || !isRoundCheckpoint(later)) return false
    return persistedReferencesEqual(earlierState.references, laterState.references)
}

/** Pre-edit and pre-compaction rows are named restore boundaries, not round duplicates. */
function isRoundCheckpoint(message: UiMessage): boolean {
    return message.checkpointSource === undefined || message.checkpointSource.kind === "round_start"
}

/** Distinguish no file restore point from malformed or partially comparable persisted data. */
function readPersistedState(message: UiMessage): PersistedCheckpointState {
    const hashes = readHashes((message as UiMessage & { lastCheckpointHash?: unknown }).lastCheckpointHash)
    if (!hashes) return { kind: "ambiguous" }
    if (!hashes.some((hash) => hash.length > 0)) return { kind: "chat-only" }

    const workspaceRoots = readWorkspaceRoots(
        (message as UiMessage & { checkpointWorkspaceRoots?: unknown }).checkpointWorkspaceRoots,
    )
    if (
        !workspaceRoots ||
        (workspaceRoots.length > 0 &&
            (workspaceRoots.length !== hashes.length || workspaceRoots.some((workspaceRoot) => workspaceRoot.length === 0)))
    ) {
        return { kind: "ambiguous" }
    }
    return { kind: "files", references: { hashes, workspaceRoots } }
}

/** Legacy scalar hashes can reach projection only before storage normalization. */
function readHashes(value: unknown): readonly string[] | undefined {
    if (value === undefined) return []
    if (typeof value === "string") return value.length > 0 ? [value] : []
    if (!Array.isArray(value) || !value.every((hash): hash is string => typeof hash === "string")) return undefined
    return value
}

function readWorkspaceRoots(value: unknown): readonly string[] | undefined {
    if (value === undefined) return []
    if (!Array.isArray(value) || !value.every((root): root is string => typeof root === "string")) return undefined
    return value
}

/** Compare root-to-hash identity; legacy rows without roots retain ordered comparison. */
function persistedReferencesEqual(left: PersistedCheckpointReferences, right: PersistedCheckpointReferences): boolean {
    const leftHasRoots = left.workspaceRoots.length > 0
    const rightHasRoots = right.workspaceRoots.length > 0
    if (leftHasRoots !== rightHasRoots || left.hashes.length !== right.hashes.length) return false

    if (!leftHasRoots) {
        return left.hashes.every((hash, index) => hash === right.hashes[index])
    }

    const rightByRoot = new Map<string, string>()
    for (let index = 0; index < right.workspaceRoots.length; index += 1) {
        const root = right.workspaceRoots[index]
        if (rightByRoot.has(root)) return false
        rightByRoot.set(root, right.hashes[index])
    }
    if (rightByRoot.size !== left.workspaceRoots.length) return false

    const seenLeftRoots = new Set<string>()
    return left.workspaceRoots.every((root, index) => {
        if (seenLeftRoots.has(root)) return false
        seenLeftRoots.add(root)
        return rightByRoot.get(root) === left.hashes[index]
    })
}
