import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { SemanticComposerEngine } from "./engine"
import {
    type ComposerSegment,
    type ComposerState,
    contentLength,
    flatTextOf,
    normalizeComposerText,
    resourceAtomsOf,
} from "./model"
import { releaseStaging } from "./resource-staging"
import type { ComposerSendRefusal } from "./send-draft"
import { useComposerState } from "./useComposerState"

/**
 * The composer draft a chat view owns: one engine, plus the identities that
 * scope its resources and its submitted document.
 *
 * `draftId` names the draft owner of resources staged before a task exists;
 * the host only accepts a UUID. `documentId` names the document the draft is
 * submitted as. Both are renewed whenever a different draft is loaded, so a
 * sent draft's resources and document never bleed into the next one - except
 * that a loaded draft whose resources a draft already owns keeps that owner,
 * since only it can still submit them.
 */
/** The identities that scope one draft's resources and its submitted document. */
export interface ComposerDraftIdentity {
    readonly draftId: string
    readonly documentId: string
}

export interface ComposerDraft {
    readonly engine: SemanticComposerEngine
    readonly state: ComposerState
    readonly draftId: string
    readonly documentId: string
    /** The flat text, with each atom as one placeholder; for emptiness and change checks only, never for sending. */
    readonly flatText: string
    /**
     * Why the user's last send of this exact draft did not go out. It answers
     * that send only, so any edit of the draft clears it.
     */
    readonly sendRefusal: ComposerSendRefusal | undefined
    /**
     * Record that a send of the current draft was refused. Every send path -
     * the composer, the queue and an interaction option - reports here, so the
     * composer explains each refusal the same way.
     */
    reportSendRefusal(refusal: ComposerSendRefusal): void
    /**
     * Replace the whole draft and start a fresh document identity and history.
     * The draft identity is fresh too, unless the loaded segments hold
     * resources owned by one draft: a refused send put back keeps the owner
     * its resources are recorded under. Returns the identity, so work started
     * for the loaded draft in the same event is scoped to it.
     */
    load(segments: readonly ComposerSegment[]): ComposerDraftIdentity
    /** Empty the draft for a new owner; nothing of it stays undoable. */
    clear(): void
    /**
     * Empty a draft that was just sent. Like a native field, the sent text and
     * its commands and mentions stay one undo step away. Its resources do not:
     * the task they were sent to owns them now.
     */
    retire(): void
    /**
     * Plain-text adapter for callers that predate the semantic composer.
     *
     * Only the region that differs between the current flat text and the new
     * text is edited, so atoms outside it keep their identity. The inserted
     * text counts as an application literal, never as typed intent.
     */
    setText(next: string | ((current: string) => string)): void
}

function newDraftIdentity(draftId: string = crypto.randomUUID()): ComposerDraftIdentity {
    return { draftId, documentId: crypto.randomUUID() }
}

/**
 * The one draft that owns the loaded segments' resources, if any.
 *
 * Resources owned by several drafts cannot all be submitted by one draft, so
 * none is adopted: the loaded draft gets a fresh owner and the host refuses
 * the foreign resources at submission instead of one being picked silently.
 */
export function owningDraftOf(segments: readonly ComposerSegment[]): string | undefined {
    const owners = new Set<string>()
    for (const atom of resourceAtomsOf(segments)) {
        if (atom.ref?.owner.kind === "draft") owners.add(atom.ref.owner.draftId)
    }
    return owners.size === 1 ? [...owners][0] : undefined
}

function changedRegion(previous: string, next: string): { start: number; end: number; inserted: string } {
    let prefix = 0
    const limit = Math.min(previous.length, next.length)
    while (prefix < limit && previous[prefix] === next[prefix]) prefix++
    let suffix = 0
    while (suffix < limit - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
    return { start: prefix, end: previous.length - suffix, inserted: next.slice(prefix, next.length - suffix) }
}

export function useComposerDraft(): ComposerDraft {
    const engine = useMemo(() => new SemanticComposerEngine(), [])
    const state = useComposerState(engine)
    // Preview URLs and retry sources live only as long as the composer that shows them.
    useEffect(() => () => releaseStaging(engine), [engine])
    const identityRef = useRef<ComposerDraftIdentity>(newDraftIdentity())

    const load = useCallback(
        (segments: readonly ComposerSegment[]) => {
            const identity = newDraftIdentity(owningDraftOf(segments))
            identityRef.current = identity
            engine.apply({ type: "load", segments })
            return identity
        },
        [engine],
    )

    const clear = useCallback(() => {
        load([])
    }, [load])

    const retire = useCallback(() => {
        const current = engine.getState().segments
        // A send and its settlement may both retire the draft; the second call
        // finds nothing sent and must not replace the undo step the first kept.
        if (contentLength(current) === 0) return
        const sent = current.filter((segment) => !isResourceSegment(segment))
        identityRef.current = newDraftIdentity()
        // A refused send puts this draft back, previews included, so what its
        // resources hold must outlive the clear until the next draft is loaded.
        engine.holdThroughNextLoad(engine.getState())
        engine.apply({ type: "load", segments: [], ...(contentLength(sent) > 0 ? { undoTo: sent } : {}) })
    }, [engine])

    const setText = useCallback(
        (next: string | ((current: string) => string)) => {
            const previous = flatTextOf(engine.getState().segments)
            const value = normalizeComposerText(typeof next === "function" ? next(previous) : next)
            if (value === previous) return
            if (value.length === 0) {
                clear()
                return
            }
            const { start, end, inserted } = changedRegion(previous, value)
            engine.apply({ type: "insert_text", text: inserted, source: "app_action", range: { start, end } })
        },
        [clear, engine],
    )

    // Bound to the draft it answers: drafts are immutable, so a refusal whose
    // segments are no longer the current ones has been answered by an edit.
    const [refused, setRefused] = useState<{ refusal: ComposerSendRefusal; segments: readonly ComposerSegment[] }>()
    const reportSendRefusal = useCallback(
        (refusal: ComposerSendRefusal) => setRefused({ refusal, segments: engine.getState().segments }),
        [engine],
    )
    const sendRefusal = refused?.segments === state.segments ? refused.refusal : undefined

    const flatText = useMemo(() => flatTextOf(state.segments), [state.segments])
    const { draftId, documentId } = identityRef.current
    return {
        engine,
        state,
        draftId,
        documentId,
        flatText,
        sendRefusal,
        reportSendRefusal,
        load,
        clear,
        retire,
        setText,
    }
}

function isResourceSegment(segment: ComposerSegment): boolean {
    return segment.kind === "atom" && segment.atom.kind === "resource"
}
