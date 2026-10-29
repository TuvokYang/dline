import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { RelativePathsRequest } from "@shared/proto/dline/file"
import type React from "react"
import { useCallback } from "react"
import { FileServiceClient } from "@/services/grpc-client"
import { classifyPaste } from "@/services/input-semantics/paste-intent"
import {
    classifyTransferFiles,
    isDocumentAttachmentUri,
    parseAttachableFileUris,
    readResourceUris,
} from "@/utils/composer-transfer"
import { createMentionAtom } from "./semantic-composer/atoms"
import type { SemanticComposerEngine } from "./semantic-composer/engine"
import { type ComposerRange, type ComposerSegment, selectionRange } from "./semantic-composer/model"
import { stageFiles, stagePastedText, stageSelectedResources, stageUris } from "./semantic-composer/resource-staging"

/** Providers reject images beyond this edge length, so they are refused before staging. */
const MAX_IMAGE_EDGE_PX = 7500

export interface ComposerResourceInputOptions {
    readonly engine: SemanticComposerEngine
    readonly draftId: string
    readonly catalog: InputSemanticCatalog
    /** Whether attachments may be added to this draft at all. */
    readonly attachmentsEnabled: boolean
    /** How many more attachments fit in this draft. */
    readonly freeSlots: number
    /** Whether the host's file dialog may offer images. */
    readonly imagesAllowed: boolean
    /** Files were refused for their size or type. */
    readonly onRejectedFiles: () => void
    /** Images were refused for their dimensions. */
    readonly onOversizedImages: () => void
    /** Text too long to inline was refused because no text resource can be added. */
    readonly onRefusedText: () => void
    /** Attachments were left out because the draft already holds as many as a message may carry. */
    readonly onAttachmentLimit: () => void
}

export interface ComposerResourceInput {
    /**
     * Runs before the editor's plain-text paste, for every paste except this
     * composer's own fragment; prevents the default when it takes the paste over.
     */
    readonly handlePaste: (event: React.ClipboardEvent<HTMLDivElement>) => void
    /**
     * Claims pasted text that is not a plain inline insert - a link, file URIs,
     * or text too long to inline - and returns whether it did.
     *
     * The editor calls it when a paste reaches it only as an insertion, without
     * a readable clipboard event, so such text is never inlined by accident.
     */
    readonly handlePastedText: (text: string, range: ComposerRange) => boolean
    /** Handles a drop at the flat offset it landed on, or at the caret when the offset is unknown. */
    readonly handleDrop: (event: React.DragEvent, offset: number | undefined) => void
    /** Opens the host's file dialog and inserts the picked files at the caret. */
    readonly selectResources: () => void
}

function edgeLengthsOf(file: File): Promise<{ width: number; height: number } | undefined> {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file)
        const image = new Image()
        image.onload = () => {
            URL.revokeObjectURL(url)
            resolve({ width: image.naturalWidth, height: image.naturalHeight })
        }
        image.onerror = () => {
            URL.revokeObjectURL(url)
            resolve(undefined)
        }
        image.src = url
    })
}

/** Split images into those a provider accepts and those whose dimensions it would refuse. */
async function partitionByDimensions(images: readonly File[]): Promise<{ accepted: File[]; oversized: number }> {
    const sizes = await Promise.all(images.map(edgeLengthsOf))
    const accepted = images.filter((_, index) => {
        const size = sizes[index]
        // An image the Webview cannot decode is left to the host, which reports why it failed.
        return !size || (size.width <= MAX_IMAGE_EDGE_PX && size.height <= MAX_IMAGE_EDGE_PX)
    })
    return { accepted, oversized: images.length - accepted.length }
}

/**
 * The position an asynchronous insertion still applies to: the one captured at
 * the event while the draft is unchanged, otherwise wherever the caret is now,
 * so text typed in the meantime is never split.
 */
function positionFor(engine: SemanticComposerEngine, segmentsAtEvent: readonly ComposerSegment[], range: ComposerRange) {
    return engine.getState().segments === segmentsAtEvent ? range : selectionRange(engine.getState().selection)
}

/**
 * Whether input that started asynchronous work for one draft may still be
 * inserted: not once another draft was loaded, whose owner never staged it.
 */
function stillSameDraft(engine: SemanticComposerEngine, generation: number): boolean {
    if (engine.generation === generation) return true
    console.warn("[composer] late input dropped: another draft was loaded before it was ready")
    return false
}

/**
 * Paste, drop and file-dialog input of the semantic composer.
 *
 * Every attachment becomes a resource atom at the position it was pasted or
 * dropped, staged by the host as a copy the draft owns. Explorer drops of
 * readable workspace files become mentions instead, because the agent can read
 * them where they are. Long pasted text is staged as a text resource so it is
 * neither inlined into the message nor repeated in every later request.
 */
export function useComposerResourceInput(options: ComposerResourceInputOptions): ComposerResourceInput {
    const {
        engine,
        draftId,
        catalog,
        attachmentsEnabled,
        freeSlots,
        imagesAllowed,
        onRejectedFiles,
        onOversizedImages,
        onRefusedText,
        onAttachmentLimit,
    } = options

    const stageImagesAndFiles = useCallback(
        async (
            images: readonly File[],
            files: readonly File[],
            origin: "pasted_file" | "uploaded_file",
            range: ComposerRange,
        ) => {
            const segmentsAtEvent = engine.getState().segments
            const generation = engine.generation
            if (files.length > 0) void stageFiles(engine, draftId, files, origin, range, onAttachmentLimit)
            if (images.length === 0) return
            const { accepted, oversized } = await partitionByDimensions(images)
            if (oversized > 0) onOversizedImages()
            if (!stillSameDraft(engine, generation)) return
            // Staging admits only what still fits once the images were decoded.
            await stageFiles(engine, draftId, accepted, origin, positionFor(engine, segmentsAtEvent, range), onAttachmentLimit)
        },
        [draftId, engine, onAttachmentLimit, onOversizedImages],
    )

    /**
     * Take over a paste whose text and clipboard items are known, or leave it
     * to the editor's plain insert. Every branch decides synchronously: the
     * browser pastes as soon as the handler yields.
     */
    const claimPaste = useCallback(
        (text: string, items: readonly DataTransferItem[], range: ComposerRange): boolean => {
            // On Linux, files copied in a file manager arrive as file:// URIs in the text.
            const fileUris = parseAttachableFileUris(text)
            if (fileUris.length > 0) {
                if (attachmentsEnabled) void stageUris(engine, draftId, fileUris, "pasted_file", range, onAttachmentLimit)
                return true
            }
            const intent = classifyPaste(text, items, { attachmentsEnabled, hasFreeSlot: freeSlots > 0 })
            switch (intent.kind) {
                case "native":
                    // The editor inserts the text itself, held as pasted.
                    return false
                case "url":
                    // A trailing space lets the user delete the link as one unit.
                    engine.apply({ type: "insert_text", text: `${intent.url} `, source: "pasted", range })
                    return true
                case "oversized_text":
                    void stagePastedText(engine, draftId, intent.text, range, onAttachmentLimit)
                    return true
                case "refused_text":
                    // Claimed so the browser does not inline it either.
                    onRefusedText()
                    return true
                case "images":
                    void stageImagesAndFiles(intent.files, [], "pasted_file", range)
                    return true
            }
        },
        [attachmentsEnabled, draftId, engine, freeSlots, onAttachmentLimit, onRefusedText, stageImagesAndFiles],
    )

    const handlePaste = useCallback(
        (event: React.ClipboardEvent<HTMLDivElement>) => {
            const { clipboardData } = event
            const range = selectionRange(engine.getState().selection)
            // Files copied in a file manager arrive as clipboard files.
            const files = classifyTransferFiles(Array.from(clipboardData.files ?? []))
            if (files.rejected.length > 0 && (files.attachments.length > 0 || files.images.length === 0)) onRejectedFiles()
            if (files.attachments.length > 0) {
                event.preventDefault()
                if (attachmentsEnabled) void stageImagesAndFiles(files.images, files.attachments, "pasted_file", range)
                return
            }
            if (claimPaste(clipboardData.getData("text/plain"), Array.from(clipboardData.items ?? []), range)) {
                event.preventDefault()
            }
        },
        [attachmentsEnabled, claimPaste, engine, onRejectedFiles, stageImagesAndFiles],
    )

    const handlePastedText = useCallback((text: string, range: ComposerRange) => claimPaste(text, [], range), [claimPaste])

    /** Insert workspace files dropped from the Explorer as mentions at the drop position. */
    const insertMentions = useCallback(
        async (uris: readonly string[], range: ComposerRange) => {
            const segmentsAtEvent = engine.getState().segments
            const generation = engine.generation
            try {
                const response = await FileServiceClient.getRelativePaths(RelativePathsRequest.create({ uris: [...uris] }))
                if (!stillSameDraft(engine, generation)) return
                let position = positionFor(engine, segmentsAtEvent, range)
                for (const path of response.paths) {
                    const atom = createMentionAtom(catalog, path)
                    if (!atom) {
                        console.warn("[composer] dropped file refused: the catalog does not resolve it as a mention")
                        continue
                    }
                    engine.apply({ type: "insert_atom", atom, range: position })
                    position = selectionRange(engine.getState().selection)
                }
            } catch (error) {
                console.error("Error getting relative paths:", error)
            }
        },
        [catalog, engine],
    )

    const handleDrop = useCallback(
        (event: React.DragEvent, offset: number | undefined) => {
            event.preventDefault()
            const at = offset ?? selectionRange(engine.getState().selection).end
            const range = { start: at, end: at }

            // 1. An Explorer drop: binary documents are attached, everything else is mentioned.
            const resourceUris = readResourceUris(event.dataTransfer)
            if (resourceUris.length > 0) {
                const documents = resourceUris.filter(isDocumentAttachmentUri)
                const readable = resourceUris.filter((uri) => !isDocumentAttachmentUri(uri))
                if (documents.length > 0 && attachmentsEnabled)
                    void stageUris(engine, draftId, documents, "uploaded_file", range, onAttachmentLimit)
                if (readable.length > 0) void insertMentions(readable, range)
                return
            }

            // 2. An OS file-manager drop: files arrive as bytes without a host path.
            const dropped = classifyTransferFiles(Array.from(event.dataTransfer.files))
            if (dropped.rejected.length > 0) onRejectedFiles()
            if (dropped.images.length + dropped.attachments.length + dropped.rejected.length > 0) {
                if (attachmentsEnabled) void stageImagesAndFiles(dropped.images, dropped.attachments, "uploaded_file", range)
                return
            }

            // 3. A text drop; Linux file managers may send files as file:// URIs only.
            const text = event.dataTransfer.getData("text")
            const fileUris = parseAttachableFileUris(text)
            if (fileUris.length > 0) {
                if (attachmentsEnabled) void stageUris(engine, draftId, fileUris, "uploaded_file", range, onAttachmentLimit)
            } else if (text && !claimPaste(text, [], range)) {
                // Dropped text is foreign text, held exactly like a paste (WS-041 AC-07, AC-09).
                engine.apply({ type: "insert_text", text, source: "pasted", range })
            }
        },
        [
            attachmentsEnabled,
            claimPaste,
            draftId,
            engine,
            insertMentions,
            onAttachmentLimit,
            onRejectedFiles,
            stageImagesAndFiles,
        ],
    )

    const selectResources = useCallback(() => {
        if (!attachmentsEnabled || freeSlots <= 0) return
        void stageSelectedResources(engine, draftId, imagesAllowed, freeSlots, onAttachmentLimit)
    }, [attachmentsEnabled, draftId, engine, freeSlots, imagesAllowed, onAttachmentLimit])

    return { handlePaste, handlePastedText, handleDrop, selectResources }
}
