import {
    type FileNodeOrigin,
    INPUT_SOURCES,
    type InputResourceOwner,
    type MentionCapturePolicy,
    type MentionKind,
    type SemanticResourceRef,
    type SlashCommandComposition,
    type SlashCommandNamespace,
} from "@shared/input-semantics/document"
import { newEntityId } from "./atoms"
import { describeChip } from "./chip-presentation"
import { type ComposerAtom, type ComposerSegment, type ComposerTextSource, normalizeSegments, type ResourceAtom } from "./model"

/**
 * Copy and paste of draft fragments.
 *
 * Inside the composer a fragment keeps its atoms, so cutting a sentence that
 * contains a command and pasting it elsewhere moves the command, not a look-alike
 * string. Other applications receive plain text.
 */

export const COMPOSER_FRAGMENT_MIME = "application/x-dline-composer-fragment"

interface SerializedFragment {
    readonly version: 1
    /** Resource atoms are only valid in the composer whose draft owns them. */
    readonly composerId: string
    readonly segments: readonly ComposerSegment[]
}

// Typed as exhaustive records, so a new enum member fails to compile until it is accepted here too.
const NAMESPACES: Record<SlashCommandNamespace, true> = { cmd: true, workflow: true, skill: true, mcp: true }
const COMPOSITIONS: Record<SlashCommandComposition, true> = { composable: true, lifecycle_barrier: true }
const MENTION_KINDS: Record<MentionKind, true> = {
    file: true,
    folder: true,
    url: true,
    problems: true,
    terminal: true,
    git_changes: true,
    git_commit: true,
}
const CAPTURE_POLICIES: Record<MentionCapturePolicy, true> = { snapshot_at_submit: true, resolve_at_execute: true }
const FILE_ORIGINS: Record<FileNodeOrigin, true> = { pasted_text: true, pasted_file: true, uploaded_file: true }

type Untrusted = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Untrusted => typeof value === "object" && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === "string"
const isIdentifier = (value: unknown): value is string => typeof value === "string" && value.length > 0
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const isGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1
const isMember = <T extends string>(members: Record<T, true>, value: unknown): value is T =>
    typeof value === "string" && Object.hasOwn(members, value)
const isOptional = (value: unknown, accepts: (value: unknown) => boolean) => value === undefined || accepts(value)
const isTextSource = (value: unknown): value is ComposerTextSource => INPUT_SOURCES.some((source) => source === value)

function commandAtomOf(atom: Untrusted): ComposerAtom | undefined {
    if (!isString(atom.commandId) || !isString(atom.sourceText) || !isString(atom.canonicalName)) return undefined
    if (!isMember(NAMESPACES, atom.namespace) || !isMember(COMPOSITIONS, atom.compositionMode)) return undefined
    return {
        kind: "command",
        entityId: newEntityId(),
        commandId: atom.commandId,
        sourceText: atom.sourceText,
        canonicalName: atom.canonicalName,
        namespace: atom.namespace,
        compositionMode: atom.compositionMode,
    }
}

function mentionAtomOf(atom: Untrusted): ComposerAtom | undefined {
    if (!isMember(MENTION_KINDS, atom.mentionKind) || !isString(atom.sourceText) || !isString(atom.canonicalRef)) return undefined
    if (!isOptional(atom.workspaceHint, isString)) return undefined
    if (!isOptional(atom.capturePolicy, (value) => isMember(CAPTURE_POLICIES, value))) return undefined
    return {
        kind: "mention",
        entityId: newEntityId(),
        mentionKind: atom.mentionKind,
        sourceText: atom.sourceText,
        canonicalRef: atom.canonicalRef,
        ...(isString(atom.workspaceHint) ? { workspaceHint: atom.workspaceHint } : {}),
        ...(isMember(CAPTURE_POLICIES, atom.capturePolicy) ? { capturePolicy: atom.capturePolicy } : {}),
    }
}

function resourceOwnerOf(owner: unknown): InputResourceOwner | undefined {
    if (!isRecord(owner)) return undefined
    if (owner.kind === "draft" && isIdentifier(owner.draftId)) return { kind: "draft", draftId: owner.draftId }
    if (owner.kind === "task" && isIdentifier(owner.taskId)) return { kind: "task", taskId: owner.taskId }
    return undefined
}

/**
 * Rebuild a resource reference field by field, so no foreign property rides
 * along into the draft. The host verifies owner, generation and hash again
 * when the draft is submitted; this only refuses shapes it would never accept.
 */
function resourceRefOf(ref: unknown): SemanticResourceRef | undefined {
    if (!isRecord(ref)) return undefined
    const owner = resourceOwnerOf(ref.owner)
    if (!owner) return undefined
    if (!isIdentifier(ref.resourceId) || !isIdentifier(ref.expectedContentHash) || !isIdentifier(ref.mediaType)) {
        return undefined
    }
    if (!isCount(ref.byteLength) || !isGeneration(ref.generation)) return undefined
    return {
        resourceId: ref.resourceId,
        expectedContentHash: ref.expectedContentHash,
        mediaType: ref.mediaType,
        byteLength: ref.byteLength,
        owner,
        generation: ref.generation,
    }
}

/**
 * Only a ready resource is copied. A staging or failed chip is settled and
 * retried through its own entity, which the copy does not have, so a copy
 * would block sending forever. The preview URL is not copied either: it is
 * released with the original chip, which would leave the copy pointing at a
 * revoked URL.
 */
function resourceAtomOf(atom: Untrusted): ResourceAtom | undefined {
    if (atom.status !== "ready") return undefined
    const ref = resourceRefOf(atom.ref)
    if (!ref) return undefined
    if (atom.nodeKind !== "image" && atom.nodeKind !== "file") return undefined
    if (!isMember(FILE_ORIGINS, atom.fileOrigin) || !isString(atom.displayName) || !isOptional(atom.lineCount, isCount)) {
        return undefined
    }
    return {
        kind: "resource",
        entityId: newEntityId(),
        nodeKind: atom.nodeKind,
        fileOrigin: atom.fileOrigin,
        displayName: atom.displayName,
        status: "ready",
        ref,
        ...(isCount(atom.lineCount) ? { lineCount: atom.lineCount } : {}),
    }
}

/** A resource chip left out of a copy; see {@link resourceAtomOf}. */
const OMITTED = "omitted"

/**
 * Rebuild one segment from untrusted clipboard data, field by field, so
 * nothing but the composer's own model reaches the draft. Every atom gets a
 * fresh identity: a draft never holds one entity twice.
 */
function readSegment(value: unknown): ComposerSegment | typeof OMITTED | undefined {
    if (!isRecord(value)) return undefined
    if (value.kind === "text") {
        return isString(value.text) && isTextSource(value.source)
            ? { kind: "text", text: value.text, source: value.source }
            : undefined
    }
    if (value.kind !== "atom" || !isRecord(value.atom)) return undefined
    const { atom } = value
    // Dropping a resource cannot inject anything, so a chip that is not ready is omitted, not refused.
    const read =
        atom.kind === "command"
            ? commandAtomOf(atom)
            : atom.kind === "mention"
              ? mentionAtomOf(atom)
              : atom.kind === "resource"
                ? (resourceAtomOf(atom) ?? OMITTED)
                : undefined
    return read === undefined || read === OMITTED ? read : { kind: "atom", atom: read }
}

export function serializeFragment(segments: readonly ComposerSegment[], composerId: string): string {
    const fragment: SerializedFragment = { version: 1, composerId, segments }
    return JSON.stringify(fragment)
}

/**
 * Read a fragment copied from this composer, or `undefined` for anything else.
 *
 * Only this composer's own fragments keep their structure. A fragment from
 * another draft carries resources another owner holds, commands and mentions
 * resolved against another catalog, and text whose typed provenance this
 * draft cannot vouch for; such a paste is foreign text, so the caller treats
 * its plain text like any other paste. A fragment that fails validation in
 * any part is rejected whole rather than pasted partially.
 */
export function parseFragment(raw: string, composerId: string): ComposerSegment[] | undefined {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return undefined
    }
    if (!isRecord(parsed) || parsed.version !== 1 || parsed.composerId !== composerId || !Array.isArray(parsed.segments)) {
        return undefined
    }
    const segments: ComposerSegment[] = []
    for (const value of parsed.segments) {
        const segment = readSegment(value)
        if (segment === undefined) return undefined
        if (segment !== OMITTED) segments.push(segment)
    }
    return normalizeSegments(segments)
}

/** The fragment as text for other applications; a resource reads as its bracketed name. */
export function plainTextOfFragment(segments: readonly ComposerSegment[]): string {
    return segments
        .map((segment) => {
            if (segment.kind === "text") return segment.text
            const { atom } = segment
            return atom.kind === "resource" ? `[${atom.displayName}]` : describeChip(atom).plainText
        })
        .join("")
}
