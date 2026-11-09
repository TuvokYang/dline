import type { UiMessage } from "@shared/ExtensionMessage"
import { useCallback, useLayoutEffect, useRef } from "react"
import type { MessageWindowGeneration } from "../../utils/messageWindowGeneration"

/** One page of the opening's served sequence, cut around the requested anchor. */
export interface AnchoredPage {
    messages: UiMessage[]
    startIndex: number
    anchorFound: boolean
}

/** Where the target row lands in the viewport. */
export type JumpAlign = "start" | "center"

/** Numeric targets retain the existing timestamp-only navigation semantics. */
export type MessageJumpTarget = number | { anchorIndex: number; anchorTs?: number }

/** Match a real source member, never an inherited viewport context or a page offset. */
export function matchesMessageTarget(message: UiMessage, target: MessageJumpTarget): boolean {
    return typeof target === "number"
        ? message.ts === target
        : message.messageIndex === target.anchorIndex && (target.anchorTs === undefined || message.ts === target.anchorTs)
}

/** What a jump needs from the message list that owns the loaded window. */
export interface JumpToMessagePort {
    /** Identifies the opening; a jump started for another one never lands. */
    taskKey: string | undefined
    generation: MessageWindowGeneration
    /**
     * Whether the message is in the rendered rows.
     *
     * Its identity must change whenever the rendered rows do: a jump that
     * replaced the window scrolls once the new rows are committed.
     */
    isLoaded: (target: MessageJumpTarget) => boolean
    /** Bring the message's row to `align` in the viewport, for as long as `isStillWanted` holds. */
    scrollToMessage: (
        target: MessageJumpTarget,
        behavior: "auto" | "smooth",
        align: JumpAlign,
        isStillWanted: () => boolean,
    ) => void
    fetchAnchoredPage: (target: MessageJumpTarget) => Promise<AnchoredPage>
    /** Replace the loaded window with the page, keeping copies the stream has already moved past. */
    replaceWindow: (page: AnchoredPage, target: MessageJumpTarget) => void
    /** Leave auto-follow and drop work that belongs to the window being left. */
    enterBrowsing: () => void
}

type PendingScroll = { target: MessageJumpTarget; generation: number; align: JumpAlign }

/**
 * Jump the chat to a message anywhere in the task's history.
 *
 * Every navigation that targets a message, the trajectory rail and the sticky
 * user message alike, goes through here. Each jump advances the window
 * generation first, so of two jumps only the later one acts, and pages or edge
 * jumps launched before it are dropped. A loaded message is scrolled to
 * directly; any other one replaces the window with a page centred on it and is
 * scrolled to once that page is laid out.
 */
export function useJumpToMessage(port: JumpToMessagePort): (target: MessageJumpTarget, align?: JumpAlign) => Promise<void> {
    const portRef = useRef(port)
    portRef.current = port
    const pendingScrollRef = useRef<PendingScroll | null>(null)

    useLayoutEffect(() => {
        const pending = pendingScrollRef.current
        if (!pending) return
        const { generation, isLoaded, scrollToMessage } = port
        if (!generation.isCurrent(pending.generation)) {
            pendingScrollRef.current = null
            return
        }
        // React may run this against the rows of the window being replaced.
        if (!isLoaded(pending.target)) return
        pendingScrollRef.current = null
        // Row heights are estimates until the new window is measured, so the scroll keeps re-targeting.
        scrollToMessage(pending.target, "auto", pending.align, () => portRef.current.generation.isCurrent(pending.generation))
    }, [port])

    return useCallback(async (target: MessageJumpTarget, align: JumpAlign = "start") => {
        const current = portRef.current
        current.enterBrowsing()
        pendingScrollRef.current = null

        if (current.isLoaded(target)) {
            const generation = current.generation.advance()
            current.scrollToMessage(target, "smooth", align, () => portRef.current.generation.isCurrent(generation))
            return
        }

        const taskKey = current.taskKey
        const generation = current.generation.replace()
        const stillWanted = () => portRef.current.taskKey === taskKey && portRef.current.generation.isCurrent(generation)
        try {
            const page = await current.fetchAnchoredPage(target)
            // A missing or shifted source target ends only this click, without replacing the window.
            if (!stillWanted() || !page.anchorFound || !page.messages.some((message) => matchesMessageTarget(message, target))) {
                return
            }
            pendingScrollRef.current = { target, generation, align }
            portRef.current.replaceWindow(page, target)
        } catch (error) {
            if (stillWanted()) console.error("fetchMessage:", error)
        } finally {
            portRef.current.generation.settle(generation)
        }
    }, [])
}
