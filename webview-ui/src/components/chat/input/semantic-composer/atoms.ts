import { type InputSemanticCatalog, resolveCommandTrigger } from "@shared/input-semantics/catalog"
import { commandNamespaceOf } from "@shared/input-semantics/command-namespace"
import type { FileNodeOrigin, SemanticResourceRef } from "@shared/input-semantics/document"
import { formatMentionReference, parseMentionReference } from "@shared/input-semantics/mention-reference"
import type { CommandAtom, MentionAtom, ResourceAtom, ResourceAtomError } from "./model"

/**
 * Factories for the atoms application actions and menu picks insert.
 *
 * An atom names an entity, never free text: a command by catalog identity, a
 * mention by its reference, a resource by the reference Core staged. Each atom
 * gets a fresh identity, so diagnostics, undo and removal address it directly.
 */

export function newEntityId(): string {
    return crypto.randomUUID()
}

/** The user-facing name without the slash and without its namespace prefix. */
function canonicalNameOf(trigger: string): string {
    const withoutSlash = trigger.startsWith("/") ? trigger.slice(1) : trigger
    const lastColon = withoutSlash.lastIndexOf(":")
    return lastColon === -1 ? withoutSlash : withoutSlash.slice(lastColon + 1)
}

/**
 * A command atom for a menu pick or an application action.
 *
 * `trigger` is the spelling the menu showed; the catalog must still resolve it
 * to `commandId`, so a capability withdrawn while the menu was open is refused
 * instead of being written as an inert look-alike.
 */
export function createCommandAtom(catalog: InputSemanticCatalog, commandId: string, trigger: string): CommandAtom | undefined {
    const descriptor = resolveCommandTrigger(catalog, trigger)
    if (!descriptor || descriptor.id !== commandId || descriptor.kind !== "command") return undefined
    return {
        kind: "command",
        entityId: newEntityId(),
        commandId: descriptor.id,
        sourceText: trigger,
        canonicalName: canonicalNameOf(descriptor.trigger),
        namespace: commandNamespaceOf(descriptor.id),
        compositionMode: descriptor.lifecycle === "task" ? "lifecycle_barrier" : "composable",
    }
}

/**
 * A mention atom for an unquoted reference: a workspace path, optionally with a
 * `root:` prefix, a URL, a commit, `problems`, `terminal` or `git-changes`.
 *
 * The written form comes from the shared reference grammar, so the atom reads
 * exactly as Core resolves it.
 */
export function createMentionAtom(catalog: InputSemanticCatalog, reference: string): MentionAtom | undefined {
    const parsed = parseMentionReference(reference)
    if (!catalog.descriptors.some((descriptor) => descriptor.id === `mention.${parsed.kind}`)) return undefined
    return {
        kind: "mention",
        entityId: newEntityId(),
        mentionKind: parsed.kind,
        sourceText: `@${formatMentionReference(reference)}`,
        canonicalRef: parsed.ref,
        ...(parsed.workspaceHint === undefined ? {} : { workspaceHint: parsed.workspaceHint }),
        capturePolicy: "snapshot_at_submit",
    }
}

/** What the composer knows about a resource before the host has staged it. */
export interface PendingResource {
    readonly nodeKind: "image" | "file"
    readonly fileOrigin: FileNodeOrigin
    readonly displayName: string
    readonly previewUrl?: string
}

/** A placeholder that holds the insertion position while the host stages the bytes. */
export function createStagingResourceAtom(pending: PendingResource): ResourceAtom {
    return {
        kind: "resource",
        entityId: newEntityId(),
        nodeKind: pending.nodeKind,
        fileOrigin: pending.fileOrigin,
        displayName: pending.displayName,
        status: "staging",
        ...(pending.previewUrl === undefined ? {} : { previewUrl: pending.previewUrl }),
    }
}

/** What the host reports for one staged resource. */
export interface StagedResource {
    readonly ref: SemanticResourceRef
    readonly displayName: string
    readonly nodeKind: "image" | "file"
    readonly fileOrigin: FileNodeOrigin
    readonly lineCount?: number
}

/** The same atom, now bound to the reference Core staged; position and identity are kept. */
export function readyResourceAtom(atom: ResourceAtom, staged: StagedResource): ResourceAtom {
    const { error: _error, ...rest } = atom
    return {
        ...rest,
        nodeKind: staged.nodeKind,
        fileOrigin: staged.fileOrigin,
        displayName: staged.displayName,
        status: "ready",
        ref: staged.ref,
        ...(staged.lineCount === undefined ? {} : { lineCount: staged.lineCount }),
    }
}

/** The same atom, kept in place with a recoverable error. */
export function failedResourceAtom(atom: ResourceAtom, error: ResourceAtomError): ResourceAtom {
    const { ref: _ref, ...rest } = atom
    return { ...rest, status: "failed", error }
}

/** A resource atom for a reference that is already staged, as when a draft comes back. */
export function createReadyResourceAtom(staged: StagedResource, entityId: string = newEntityId()): ResourceAtom {
    return {
        kind: "resource",
        entityId,
        nodeKind: staged.nodeKind,
        fileOrigin: staged.fileOrigin,
        displayName: staged.displayName,
        status: "ready",
        ref: staged.ref,
        ...(staged.lineCount === undefined ? {} : { lineCount: staged.lineCount }),
    }
}
