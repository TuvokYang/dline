import type { FileNodeOrigin, SemanticResourceRef } from "@shared/input-semantics/document"
import {
    InputResourceKind,
    InputResourceRequest,
    type InputResourceStageResults,
    SelectInputResourcesRequest,
    type StagedInputResource,
    StageInputBytesRequest,
    StageInputTextRequest,
    StageInputUrisRequest,
} from "@shared/proto/dline/file"
import { fromProtoSemanticResourceRef, toProtoSemanticResourceRef } from "@shared/proto-conversions/input-semantics/document"
import { CHAT_CONSTANTS } from "@/components/chat/chat-view/constants"
import { FileServiceClient } from "@/services/grpc-client"
import {
    createReadyResourceAtom,
    createStagingResourceAtom,
    failedResourceAtom,
    type PendingResource,
    readyResourceAtom,
    type StagedResource,
} from "./atoms"
import type { SemanticComposerEngine } from "./engine"
import {
    atomsOf,
    type ComposerRange,
    type ComposerState,
    contentLength,
    findAtom,
    type ResourceAtom,
    resourceAtomsOf,
} from "./model"

/**
 * Staging of attachments as owned input resources, at their insertion position.
 *
 * A placeholder atom is inserted first, so the position the user chose survives
 * however long the host takes; it then becomes ready with the reference Core
 * staged, or stays in place as a failed atom with a recoverable error. The
 * draft id names the draft owner when no task exists yet; with a task, the host
 * chooses the task owner itself.
 */

const STAGE_FAILED = { code: "semantic_input_resource_stage_failed", message: "The attachment could not be staged." }

/** Called with how many attachments were left out because the draft was full. */
export type ResourceLimitListener = (refused: number) => void

/**
 * Admit as many items as the draft has room for right now.
 *
 * The room is counted at the moment of insertion, not when the input event
 * started: two pastes in flight would otherwise both fit into the same free
 * slots and exceed the per-message limit together.
 */
function admit<T>(engine: SemanticComposerEngine, items: readonly T[], onLimit?: ResourceLimitListener): T[] {
    const free = Math.max(0, CHAT_CONSTANTS.MAX_IMAGES_AND_FILES_PER_MESSAGE - resourceAtomsOf(engine.getState().segments).length)
    const admitted = items.slice(0, free)
    if (admitted.length < items.length) onLimit?.(items.length - admitted.length)
    return admitted
}

function nodeKindOf(kind: InputResourceKind): "image" | "file" {
    return kind === InputResourceKind.INPUT_RESOURCE_KIND_IMAGE ? "image" : "file"
}

function originOf(kind: InputResourceKind, fallback: FileNodeOrigin): FileNodeOrigin {
    return kind === InputResourceKind.INPUT_RESOURCE_KIND_PASTED_TEXT ? "pasted_text" : fallback
}

/** What the composer keeps of one staged result; undefined when the host returned no usable reference. */
function stagedResourceOf(
    staged: StagedInputResource,
    fallbackDisplayName: string,
    fallbackOrigin: FileNodeOrigin,
): StagedResource | undefined {
    const ref = fromProtoSemanticResourceRef(staged.ref)
    if (!ref) return undefined
    return {
        ref,
        displayName: staged.displayName || fallbackDisplayName,
        nodeKind: nodeKindOf(staged.kind),
        fileOrigin: originOf(staged.kind, fallbackOrigin),
        ...(staged.lineCount === undefined ? {} : { lineCount: staged.lineCount }),
    }
}

/** Insert placeholders, one per item, at `range` in order; return their identities. */
function insertPlaceholders(
    engine: SemanticComposerEngine,
    pending: readonly PendingResource[],
    range?: ComposerRange,
): ResourceAtom[] {
    const atoms = pending.map(createStagingResourceAtom)
    atoms.forEach((atom, index) => {
        if (atom.previewUrl) leaseOf(engine, atom.entityId).previewUrl = atom.previewUrl
        engine.apply({ type: "insert_atom", atom, ...(index === 0 && range ? { range } : {}) })
    })
    return atoms
}

type StageRequest = () => Promise<InputResourceStageResults>

/**
 * What this module holds for one resource atom beyond the atom itself: the
 * preview URL it created, and the stage a failed atom can repeat.
 *
 * Only this module holds what an atom was staged from (bytes, a URI, a text),
 * so the retry lives here rather than in the atom, which stays serializable.
 */
interface StagingLease {
    previewUrl?: string
    retry?: () => Promise<void>
}

/**
 * Leases per engine. A removed atom keeps its lease while undo can bring it
 * back; whenever states stop being reachable - a load, a dropped undo step,
 * discarded redo steps - every lease no reachable state names is released, so
 * preview URLs and retained bytes do not outlive the draft that held them.
 */
const leases = new WeakMap<SemanticComposerEngine, Map<string, StagingLease>>()

function isReachable(engine: SemanticComposerEngine, entityId: string): boolean {
    return reachableEntityIds(engine.reachableStates()).has(entityId)
}

function reachableEntityIds(states: readonly ComposerState[]): Set<string> {
    return new Set(states.flatMap((state) => atomsOf(state.segments).map((atom) => atom.entityId)))
}

function releaseLease(lease: StagingLease): void {
    if (lease.previewUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(lease.previewUrl)
}

function leasesOf(engine: SemanticComposerEngine): Map<string, StagingLease> {
    let map = leases.get(engine)
    if (!map) {
        const owned = new Map<string, StagingLease>()
        engine.onReachabilityChange((reachable) => {
            const kept = reachableEntityIds(reachable)
            for (const [entityId, lease] of owned) {
                if (kept.has(entityId)) continue
                releaseLease(lease)
                owned.delete(entityId)
            }
        })
        leases.set(engine, owned)
        map = owned
    }
    return map
}

/**
 * Release every lease of an engine whose composer is going away. Undo cannot
 * outlive the composer, so nothing it holds can be brought back.
 */
export function releaseStaging(engine: SemanticComposerEngine): void {
    const owned = leases.get(engine)
    if (!owned) return
    for (const lease of owned.values()) releaseLease(lease)
    owned.clear()
}

function leaseOf(engine: SemanticComposerEngine, entityId: string): StagingLease {
    const owned = leasesOf(engine)
    let lease = owned.get(entityId)
    if (!lease) {
        lease = {}
        owned.set(entityId, lease)
    }
    return lease
}

/**
 * Settle each placeholder with its result.
 *
 * An atom the user already removed stays removed, but it is settled where undo
 * can still bring it back, so it does not return as a placeholder that waits forever.
 */
function settle(
    engine: SemanticComposerEngine,
    atoms: readonly ResourceAtom[],
    results: InputResourceStageResults | undefined,
    fallbackOrigin: FileNodeOrigin,
    retryOf: (index: number) => StageRequest,
): void {
    atoms.forEach((atom, index) => {
        const located = findAtom(engine.getState().segments, atom.entityId)?.atom
        const current = located?.kind === "resource" ? located : atom
        const result = results?.results[index]
        const staged = result?.staged ? stagedResourceOf(result.staged, current.displayName, fallbackOrigin) : undefined
        if (staged) {
            engine.apply({ type: "replace_atom", entityId: atom.entityId, atom: readyResourceAtom(current, staged) })
            return
        }
        const error = result?.error ? { code: result.error.code, message: result.error.message } : STAGE_FAILED
        // A failure for an atom no state can reach any more must not leave a
        // retry behind: nothing could ever use or release it.
        if (!isReachable(engine, atom.entityId)) {
            const lease = leasesOf(engine).get(atom.entityId)
            if (lease) releaseLease(lease)
            leasesOf(engine).delete(atom.entityId)
            return
        }
        leaseOf(engine, atom.entityId).retry = () => run(engine, [current], retryOf(index), fallbackOrigin, () => retryOf(index))
        engine.apply({
            type: "replace_atom",
            entityId: atom.entityId,
            atom: failedResourceAtom(current, { ...error, retryable: true }),
        })
    })
}

async function run(
    engine: SemanticComposerEngine,
    atoms: readonly ResourceAtom[],
    request: StageRequest,
    fallbackOrigin: FileNodeOrigin,
    retryOf: (index: number) => StageRequest,
): Promise<void> {
    try {
        settle(engine, atoms, await request(), fallbackOrigin, retryOf)
    } catch (error) {
        console.warn("Staging input resources failed", error)
        settle(engine, atoms, undefined, fallbackOrigin, retryOf)
    }
}

/**
 * Stage a failed resource atom again, in place and under the same identity.
 *
 * Returns false when the composer no longer holds what the atom was staged
 * from, as for a resource of a restored draft; the user can only remove it.
 */
export function retryResource(engine: SemanticComposerEngine, entityId: string): boolean {
    const lease = leasesOf(engine).get(entityId)
    const retry = lease?.retry
    const current = findAtom(engine.getState().segments, entityId)?.atom
    if (!lease || !retry || current?.kind !== "resource" || current.status !== "failed") return false
    lease.retry = undefined
    const { error: _error, ...rest } = current
    engine.apply({ type: "replace_atom", entityId, atom: { ...rest, status: "staging" } })
    void retry()
    return true
}

function previewUrlOf(file: File): string | undefined {
    return file.type.startsWith("image/") && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined
}

/** Stage files that only exist as bytes in the Webview, such as a clipboard image or an OS drop. */
export async function stageFiles(
    engine: SemanticComposerEngine,
    draftId: string,
    offered: readonly File[],
    origin: FileNodeOrigin,
    range?: ComposerRange,
    onLimit?: ResourceLimitListener,
): Promise<void> {
    const files = admit(engine, offered, onLimit)
    if (files.length === 0) return
    const atoms = insertPlaceholders(
        engine,
        files.map((file) => {
            const previewUrl = previewUrlOf(file)
            return {
                nodeKind: file.type.startsWith("image/") ? "image" : "file",
                fileOrigin: origin,
                displayName: file.name || "attachment",
                ...(previewUrl ? { previewUrl } : {}),
            }
        }),
        range,
    )
    const stageBytes = (batch: readonly File[]) => async () => {
        const payload = await Promise.all(
            batch.map(async (file) => ({
                fileName: file.name || "attachment",
                data: new Uint8Array(await file.arrayBuffer()),
                // A pasted image only has the clipboard's generic name; the host names it instead.
                pastedImage: origin === "pasted_file" && file.type.startsWith("image/"),
            })),
        )
        return FileServiceClient.stageInputBytes(StageInputBytesRequest.create({ draftId, files: payload }))
    }
    await run(engine, atoms, stageBytes(files), origin, (index) => stageBytes([files[index]]))
}

/** Stage copies of files the host can read by URI, such as an Explorer drop or a pasted file URI. */
export async function stageUris(
    engine: SemanticComposerEngine,
    draftId: string,
    offered: readonly string[],
    origin: FileNodeOrigin,
    range?: ComposerRange,
    onLimit?: ResourceLimitListener,
): Promise<void> {
    const uris = admit(engine, offered, onLimit)
    if (uris.length === 0) return
    const atoms = insertPlaceholders(
        engine,
        uris.map((uri) => ({
            nodeKind: "file",
            fileOrigin: origin,
            displayName: decodeURIComponent(uri.split(/[\\/]/).pop() || uri),
        })),
        range,
    )
    const stageCopies = (batch: readonly string[]) => () =>
        FileServiceClient.stageInputUris(StageInputUrisRequest.create({ draftId, uris: [...batch] }))
    await run(engine, atoms, stageCopies(uris), origin, (index) => stageCopies([uris[index]]))
}

/** Stage a long paste as a `.txt` resource at the position it was pasted (WS-041 AC-07). */
export async function stagePastedText(
    engine: SemanticComposerEngine,
    draftId: string,
    text: string,
    range?: ComposerRange,
    onLimit?: ResourceLimitListener,
): Promise<void> {
    if (admit(engine, [text], onLimit).length === 0) return
    const atoms = insertPlaceholders(engine, [{ nodeKind: "file", fileOrigin: "pasted_text", displayName: "pasted.txt" }], range)
    const stageText = () => FileServiceClient.stageInputText(StageInputTextRequest.create({ draftId, text }))
    await run(engine, atoms, stageText, "pasted_text", () => stageText)
}

/**
 * Let the user pick files in the host's dialog and insert what was staged at the caret.
 *
 * The host decides how many files were picked, so there is no placeholder to
 * hold the position; each result is inserted ready, or failed with its error,
 * in the order the dialog returned them. A cancelled dialog returns nothing.
 *
 * The dialog stays open while the user may switch drafts. Its files were staged
 * for the draft that opened it, so when the editor loads another draft in the
 * meantime they are dropped rather than inserted into a draft that does not own them.
 * The host stages at most `maxCount` of the picked files.
 */
export async function stageSelectedResources(
    engine: SemanticComposerEngine,
    draftId: string,
    imagesAllowed: boolean,
    maxCount: number,
    onLimit?: ResourceLimitListener,
): Promise<void> {
    const generation = engine.generation
    let results: InputResourceStageResults
    try {
        results = await FileServiceClient.selectInputResources(
            SelectInputResourcesRequest.create({ draftId, imagesAllowed, maxCount: Math.max(0, maxCount) }),
        )
    } catch (error) {
        console.warn("Selecting input resources failed", error)
        return
    }
    if (engine.generation !== generation) {
        console.warn("[composer] picked files dropped: another draft was loaded while the dialog was open")
        return
    }
    // Other input may have filled the draft while the dialog was open.
    for (const result of admit(engine, results.results, onLimit)) {
        const staged = result.staged ? stagedResourceOf(result.staged, "attachment", "uploaded_file") : undefined
        const atom = staged
            ? createReadyResourceAtom(staged)
            : failedResourceAtom(
                  createStagingResourceAtom({
                      nodeKind: "file",
                      fileOrigin: "uploaded_file",
                      displayName: result.error?.displayName || "attachment",
                  }),
                  result.error ? { code: result.error.code, message: result.error.message } : STAGE_FAILED,
              )
        engine.apply({ type: "insert_atom", atom })
    }
}

/**
 * Open the verified local copy of a ready resource in the editor.
 *
 * The host opens it read-only, so the copy the draft will send cannot be
 * edited behind the composer's back.
 */
export async function openResource(draftId: string, atom: ResourceAtom): Promise<void> {
    if (atom.status !== "ready" || !atom.ref) return
    await requestOpen(draftId, atom.ref)
}

/**
 * Open the verified local copy of a resource the active task already holds,
 * such as a queued entry's attachment.
 *
 * The host checks a task-owned reference against the task's own record, so no
 * draft takes part; a reference still owned by a draft is not the queue's to open.
 */
export async function openTaskResource(ref: SemanticResourceRef): Promise<void> {
    if (ref.owner.kind !== "task") return
    await requestOpen("", ref)
}

async function requestOpen(draftId: string, ref: SemanticResourceRef): Promise<void> {
    try {
        const result = await FileServiceClient.openInputResource(
            InputResourceRequest.create({ draftId, ref: toProtoSemanticResourceRef(ref) }),
        )
        if (result.error) console.warn(`Opening input resource failed: ${result.error.code}`)
    } catch (error) {
        console.warn("Opening input resource failed", error)
    }
}

function bytesOfDataUrl(dataUrl: string): Uint8Array<ArrayBuffer> | undefined {
    const match = /^data:[^;,]*;base64,(.*)$/s.exec(dataUrl)
    if (!match) return undefined
    const binary = atob(match[1])
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

/**
 * Bring a recalled draft's flat attachments back as resources at the end of the draft.
 *
 * Drafts composed before the semantic composer carried images as data URLs and
 * files as host paths; neither is a lasting identity, so they are staged again.
 */
export async function stageLegacyAttachments(
    engine: SemanticComposerEngine,
    draftId: string,
    images: readonly string[],
    files: readonly string[],
): Promise<void> {
    const generation = engine.generation
    const end = contentLength(engine.getState().segments)
    engine.apply({ type: "select", selection: { anchor: end, focus: end } })
    const imageFiles = images.flatMap((dataUrl, index) => {
        const bytes = bytesOfDataUrl(dataUrl)
        const type = /^data:([^;,]*)/.exec(dataUrl)?.[1] ?? "image/png"
        return bytes ? [new File([bytes], `image-${index + 1}.${type.split("/")[1] ?? "png"}`, { type })] : []
    })
    await stageFiles(engine, draftId, imageFiles, "pasted_file")
    // The recalled draft may have been replaced while its images were staged;
    // its files belong to it, not to the draft now in the composer.
    if (engine.generation !== generation) return
    await stageUris(
        engine,
        draftId,
        files.map((path) => (path.startsWith("file:") ? path : `file:///${path.replace(/\\/g, "/").replace(/^\/+/, "")}`)),
        "uploaded_file",
    )
}
