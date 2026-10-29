import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { lexSemanticInput } from "@shared/input-semantics/lexer"
import { act, render, renderHook, screen, waitFor } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ComposerSegment, ResourceAtom } from "../../input/semantic-composer/model"
import { projectComposerDocument } from "../../input/semantic-composer/projection"

const staging = vi.hoisted(() => ({ stageLegacyAttachments: vi.fn(async () => undefined), releaseStaging: vi.fn() }))
vi.mock("../../input/semantic-composer/resource-staging", () => staging)

import { useChatState } from "./useChatState"

const CATALOG = { revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS } as unknown as InputSemanticCatalog

const typed = (text: string): ComposerSegment => ({ kind: "text", text, source: "typed" })
const restored = (text: string): ComposerSegment => ({ kind: "text", text, source: "restored" })

const pastedImage: ResourceAtom = {
    kind: "resource",
    entityId: "r-1",
    nodeKind: "image",
    fileOrigin: "pasted_file",
    displayName: "shot.png",
    status: "staging",
}

function hasRecognizedCommand(segments: readonly ComposerSegment[]): boolean {
    const { document } = projectComposerDocument(segments, { catalog: CATALOG, documentId: "doc-check" })
    return document.nodes.some((node) => node.kind === "slash_command" && node.state === "recognized")
}

afterEach(() => {
    vi.clearAllMocks()
})

describe("useChatState task ownership", () => {
    it("reenables Welcome submission after the active task is closed", async () => {
        const { result, rerender } = renderHook(({ taskId }: { taskId?: string }) => useChatState([], taskId), {
            initialProps: { taskId: "task-1" as string | undefined },
        })

        act(() => result.current.setSendingDisabled(true))
        expect(result.current.sendingDisabled).toBe(true)

        rerender({ taskId: undefined })

        await waitFor(() => expect(result.current.sendingDisabled).toBe(false))
    })

    it("keeps submitted Welcome input undoable after the created task becomes active", () => {
        const { result, rerender } = renderHook(({ taskId }: { taskId?: string }) => useChatState([], taskId), {
            initialProps: { taskId: undefined as string | undefined },
        })

        act(() => result.current.setInputValue("submitted task"))
        act(() => {
            result.current.composer.retire()
            result.current.setSendingDisabled(true)
        })
        rerender({ taskId: "task-1" })
        expect(result.current.inputValue).toBe("")

        act(() => result.current.composer.engine.undo())
        expect(result.current.inputValue).toBe("submitted task")
    })

    it("settles task ownership before the switched task accepts a new draft", () => {
        function TaskDraftProbe({ taskId }: { taskId: string }) {
            const state = useChatState([], taskId)
            useLayoutEffect(() => {
                if (taskId === "task-2") state.setInputValue("task two draft")
            }, [state.setInputValue, taskId])
            return <textarea aria-label="Task draft" readOnly value={state.inputValue} />
        }

        const view = render(<TaskDraftProbe taskId="task-1" />)
        view.rerender(<TaskDraftProbe taskId="task-2" />)

        expect(screen.getByRole("textbox", { name: "Task draft" })).toHaveValue("task two draft")
    })

    it("restores a captured successor draft after the successor task becomes active", async () => {
        const { result, rerender } = renderHook(({ taskId }: { taskId: string }) => useChatState([], taskId), {
            initialProps: { taskId: "task-1" },
        })

        act(() => {
            result.current.setInputValue("unsent successor draft")
            result.current.setActiveQuote("quote")
        })
        rerender({ taskId: "task-2" })
        await waitFor(() => expect(result.current.inputValue).toBe(""))
        expect(result.current.activeQuote).toBeNull()

        act(() => {
            result.current.restoreDraft({ text: "unsent successor draft", images: [], files: [], activeQuote: "quote" })
        })

        expect(result.current.inputValue).toBe("unsent successor draft")
        expect(result.current.activeQuote).toBe("quote")
        expect(staging.stageLegacyAttachments).not.toHaveBeenCalled()

        rerender({ taskId: "task-3" })
        await waitFor(() => expect(result.current.inputValue).toBe(""))
    })

    it("stages the flat attachments of a recalled draft into the draft that recalled it", () => {
        const { result } = renderHook(() => useChatState([]))

        act(() => {
            result.current.restoreDraft({ text: "see these", images: ["data:image/png;base64,AA=="], files: ["/a.txt"] })
        })

        const { engine, draftId } = result.current.composer
        expect(staging.stageLegacyAttachments).toHaveBeenCalledWith(engine, draftId, ["data:image/png;base64,AA=="], ["/a.txt"])
        expect(result.current.inputValue).toBe("see these")
    })
})

describe("useChatState draft history (WS-041)", () => {
    it("keeps a sent draft one undo away and gives the next draft a new identity", () => {
        const { result } = renderHook(() => useChatState([]))
        act(() => result.current.setInputValue("submitted draft"))
        const sent = { draftId: result.current.composer.draftId, documentId: result.current.composer.documentId }

        act(() => result.current.composer.retire())
        expect(result.current.inputValue).toBe("")
        expect(result.current.composer.draftId).not.toBe(sent.draftId)
        expect(result.current.composer.documentId).not.toBe(sent.documentId)

        act(() => result.current.composer.engine.undo())
        expect(result.current.inputValue).toBe("submitted draft")
        act(() => result.current.composer.engine.redo())
        expect(result.current.inputValue).toBe("")
    })

    it("keeps the sent draft undoable when the settlement retires the already empty draft again", () => {
        const { result } = renderHook(() => useChatState([]))
        act(() => result.current.setInputValue("sent once"))

        act(() => result.current.composer.retire())
        const nextDraftId = result.current.composer.draftId
        act(() => result.current.composer.retire())

        expect(result.current.composer.draftId).toBe(nextDraftId)
        act(() => result.current.composer.engine.undo())
        expect(result.current.inputValue).toBe("sent once")
    })

    it("does not bring back the resources of a sent draft, which the task now owns", () => {
        const { result } = renderHook(() => useChatState([]))
        act(() => result.current.composer.load([typed("look "), { kind: "atom", atom: pastedImage }]))

        act(() => result.current.composer.retire())
        act(() => result.current.composer.engine.undo())

        expect(result.current.composer.state.segments).toEqual([typed("look ")])
    })

    it("leaves nothing to undo when a sent draft held only resources", () => {
        const { result } = renderHook(() => useChatState([]))
        act(() => result.current.composer.load([{ kind: "atom", atom: pastedImage }]))

        act(() => result.current.composer.retire())

        expect(result.current.composer.engine.canUndo()).toBe(false)
    })

    it("does not carry history across an explicit ownership reset", () => {
        const { result } = renderHook(() => useChatState([]))

        act(() => result.current.setInputValue("other task draft"))
        act(() => result.current.resetState())
        act(() => result.current.composer.engine.undo())

        expect(result.current.inputValue).toBe("")
    })
})

describe("useChatState recalled drafts (WS-041 AC-09)", () => {
    it("brings a refused draft's unconfirmed candidate back held", () => {
        const { result } = renderHook(() => useChatState([]))
        const semanticInput = lexSemanticInput("/compact", {
            catalog: CATALOG,
            documentId: "doc-1",
            activation: "candidate_only",
        })

        act(() => {
            result.current.restoreDraft({ text: "/compact", images: [], files: [], activeQuote: null, semanticInput })
        })

        expect(result.current.composer.state.segments).toEqual([restored("/compact")])
        expect(hasRecognizedCommand(result.current.composer.state.segments)).toBe(false)
    })

    it("keeps a restored fragment held when typing completes it into a command", () => {
        const { result } = renderHook(() => useChatState([]))
        const semanticInput = lexSemanticInput("/compac", {
            catalog: CATALOG,
            documentId: "doc-2",
            activation: "candidate_only",
        })

        act(() => {
            result.current.restoreDraft({ text: "/compac", images: [], files: [], activeQuote: null, semanticInput })
        })
        act(() => result.current.composer.engine.apply({ type: "insert_text", text: "t", source: "typed" }))

        expect(result.current.inputValue).toBe("/compact")
        expect(hasRecognizedCommand(result.current.composer.state.segments)).toBe(false)
        // The same text typed from scratch is a live command.
        expect(hasRecognizedCommand([typed("/compact")])).toBe(true)
    })

    it("keeps the typed command of a recalled draft without a document live and holds the rest", () => {
        const { result } = renderHook(() => useChatState([]))

        act(() => {
            result.current.restoreDraft({ text: "/compact now", images: [], files: [], activeQuote: null })
        })

        expect(result.current.composer.state.segments).toEqual([typed("/compact"), restored(" now")])
    })
})
