import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { type ComponentProps, forwardRef, type ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { SemanticComposerEngine } from "@/components/chat/input/semantic-composer/engine"
import type { ComposerSendDraft } from "@/components/chat/input/semantic-composer/send-draft"
import type { ComposerDraft } from "@/components/chat/input/semantic-composer/useComposerDraft"
import type { InteractionDraft } from "@/task-interaction/types"
import { InputSection } from "./InputSection"

// The text area captures one frozen draft per send; the same segments arrive
// for every click, as they would until the composer re-renders.
vi.mock("@/components/chat/ChatTextArea", () => {
    const captured = {
        segments: [{ kind: "text", text: "captured", source: "typed" }],
        text: "captured",
        images: ["image"],
        files: ["file"],
    } as unknown as ComposerSendDraft
    const modeSwitch = {
        segments: [{ kind: "text", text: "mode switch", source: "typed" }],
        text: "mode switch",
        images: ["mode-image"],
        files: ["mode-file"],
    } as unknown as ComposerSendDraft
    return {
        default: forwardRef<
            HTMLDivElement,
            {
                onSend: (draft: ComposerSendDraft) => void
                onSendBlocked?: (draft: ComposerSendDraft, mode: "queued" | "steering") => void
                sendingDisabled: boolean
            }
        >((props, _ref) => (
            <>
                <button
                    onClick={() => (props.sendingDisabled ? props.onSendBlocked?.(captured, "queued") : props.onSend(captured))}
                    type="button">
                    Submit
                </button>
                <button onClick={() => props.onSendBlocked?.(captured, "steering")} type="button">
                    Steer
                </button>
                <button onClick={() => props.onSend(modeSwitch)} type="button">
                    Complete Mode Switch
                </button>
            </>
        )),
    }
})
vi.mock("@/components/chat/QuotedMessagePreview", () => ({ default: ({ children }: { children?: ReactNode }) => children }))

const mocks = vi.hoisted(() => ({
    flushPendingTaskSettingsRequests: vi.fn(async () => undefined),
}))

vi.mock("@components/settings/utils/settingsHandlers", () => ({
    flushPendingTaskSettingsRequests: mocks.flushPendingTaskSettingsRequests,
}))

const draft = (text: string): InteractionDraft => ({ text, images: [], files: [], activeQuote: null, ownerRevision: 1 })

/** Give any pending replay effect and its async submit chain a chance to run. */
async function settleEffects(): Promise<void> {
    for (let tick = 0; tick < 5; tick++) {
        await Promise.resolve()
    }
}

/** A composer whose draft-changing calls are observable; the engine itself is real. */
function composerStub(text: string): ComposerDraft {
    const engine = new SemanticComposerEngine()
    return {
        engine,
        state: engine.getState(),
        draftId: "00000000-0000-4000-8000-000000000001",
        documentId: "00000000-0000-4000-8000-000000000002",
        flatText: text,
        sendRefusal: undefined,
        reportSendRefusal: vi.fn(),
        load: vi.fn(),
        clear: vi.fn(),
        retire: vi.fn(),
        setText: vi.fn(),
    }
}

function props(currentDraft: InteractionDraft): ComponentProps<typeof InputSection> {
    return {
        // InputSection now receives the catalog it composes and recalls drafts against.
        semanticCatalog: { revision: 1, descriptors: [] },
        chatState: {
            composer: composerStub(currentDraft.text),
            composerRef: { current: null },
            activeQuote: null,
            setActiveQuote: vi.fn(),
            isTextAreaFocused: false,
            inputValue: currentDraft.text,
            setInputValue: vi.fn(),
            sendingDisabled: false,
            handleFocusChange: vi.fn(),
            restoreDraft: vi.fn(),
        },
        messageHandlers: { handleSendMessage: vi.fn() },
        scrollBehavior: { isAtBottom: true, scrollToBottomAuto: vi.fn() },
        placeholderText: "Type a message...",
        shouldDisableFilesAndImages: false,
        imagesAllowed: true,
        draft: currentDraft,
        onDraftAccepted: vi.fn(),
    } as unknown as ComponentProps<typeof InputSection>
}

describe("InputSection deferred task submission", () => {
    it("keeps a blocked Resume draft in the composer rather than enqueueing it", () => {
        const current = props(draft("resume with this note"))
        const onEnqueue = vi.fn(async () => true)
        const onSubmit = vi.fn(async () => undefined)
        render(
            <InputSection
                {...current}
                canQueueInput={true}
                enabled={false}
                onEnqueueInput={onEnqueue}
                onSubmit={onSubmit}
                submitKind="resume"
            />,
        )
        fireEvent.click(screen.getByRole("button", { name: "Submit" }))
        expect(onEnqueue).not.toHaveBeenCalled()
        expect(onSubmit).not.toHaveBeenCalled()
        expect(current.chatState.composer.retire).not.toHaveBeenCalled()
    })

    it("waits for Task settings before submitting the next request", async () => {
        let releaseSettings!: () => void
        mocks.flushPendingTaskSettingsRequests.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    releaseSettings = resolve
                }),
        )
        const onSubmit = vi.fn(async () => undefined)
        const current = props(draft("pending settings"))
        render(<InputSection {...current} enabled={true} onSubmit={onSubmit} submissionScope="task-1" />)

        fireEvent.click(screen.getByRole("button", { name: "Submit" }))
        await waitFor(() => expect(mocks.flushPendingTaskSettingsRequests).toHaveBeenCalledWith("task-1"))
        expect(onSubmit).not.toHaveBeenCalled()

        releaseSettings()
        await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
    })

    it("submits the input-owned draft instead of a stale parent draft", async () => {
        const onSubmit = vi.fn(async () => undefined)
        const current = props(draft("stale parent"))
        render(<InputSection {...current} enabled={true} onSubmit={onSubmit} submissionScope="task-1" />)

        fireEvent.click(screen.getByRole("button", { name: "Submit" }))

        await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
        expect(onSubmit).toHaveBeenCalledWith({
            text: "captured",
            images: ["image"],
            files: ["file"],
            activeQuote: null,
            ownerRevision: 1,
        })
    })

    // A blocked send must never be replayed by a later state flip. Enabling the
    // input only means the composer may submit again; it must not resurrect a
    // draft the user captured earlier and has since stopped tracking.
    it("does not submit a blocked draft when the same task interaction becomes enabled", async () => {
        const onSubmit = vi.fn(async () => undefined)
        const initial = props(draft("initial"))
        const { rerender } = render(<InputSection {...initial} enabled={false} onSubmit={onSubmit} submissionScope="task-1" />)

        fireEvent.click(screen.getByRole("button", { name: "Submit" }))
        expect(onSubmit).not.toHaveBeenCalled()

        const updated = props(draft("changed after enter"))
        rerender(<InputSection {...updated} enabled={true} onSubmit={onSubmit} submissionScope="task-1" />)

        await settleEffects()
        expect(onSubmit).not.toHaveBeenCalled()
    })

    // Cancelling re-enables the input once the task settles into its resume
    // interaction. That transition must not deliver anything the user typed
    // while the task was still running.
    it("does not submit a blocked draft after a cancel re-enables the input", async () => {
        const onSubmit = vi.fn(async () => undefined)
        const initial = props(draft("typed during run"))
        const { rerender } = render(<InputSection {...initial} enabled={false} onSubmit={onSubmit} submissionScope="task-1" />)

        fireEvent.click(screen.getByRole("button", { name: "Submit" }))

        // Cancel keeps the same task identity, so scope alone cannot fence the replay.
        const cancelled = props(draft("typed during run"))
        rerender(<InputSection {...cancelled} enabled={true} onSubmit={onSubmit} submissionScope="task-1" />)

        await settleEffects()
        expect(onSubmit).not.toHaveBeenCalled()
    })

    it("does not submit a blocked draft when task ownership changes", async () => {
        const onSubmit = vi.fn(async () => undefined)
        const initial = props(draft("initial"))
        const { rerender } = render(<InputSection {...initial} enabled={false} onSubmit={onSubmit} submissionScope="task-1" />)

        fireEvent.click(screen.getByRole("button", { name: "Submit" }))
        const updated = props(draft("new task"))
        rerender(<InputSection {...updated} enabled={true} onSubmit={onSubmit} submissionScope="task-2" />)

        await settleEffects()
        expect(onSubmit).not.toHaveBeenCalled()
    })

    it("does not submit a blocked mode-switch draft when the input becomes enabled", async () => {
        const onSubmit = vi.fn(async () => undefined)
        const initial = props(draft("initial"))
        const { rerender } = render(<InputSection {...initial} enabled={false} onSubmit={onSubmit} submissionScope="task-1" />)

        fireEvent.click(screen.getByRole("button", { name: "Complete Mode Switch" }))
        expect(onSubmit).not.toHaveBeenCalled()

        const updated = props(draft("changed after switch"))
        rerender(<InputSection {...updated} enabled={true} onSubmit={onSubmit} submissionScope="task-1" />)

        await settleEffects()
        expect(onSubmit).not.toHaveBeenCalled()
    })

    // A blocked send is retained as a visible queue entry instead of being
    // dropped, but it must still never be delivered by a state flip.
    it("enqueues a blocked draft instead of submitting it", async () => {
        const onSubmit = vi.fn(async () => undefined)
        const onEnqueue = vi.fn()
        const current = props(draft("queue me"))
        render(
            <InputSection {...current} enabled={false} onEnqueueInput={onEnqueue} onSubmit={onSubmit} submissionScope="task-1" />,
        )

        fireEvent.click(screen.getByRole("button", { name: "Submit" }))

        expect(onEnqueue).toHaveBeenCalledWith({ text: "captured", images: ["image"], files: ["file"] }, "queued")
        await settleEffects()
        expect(onSubmit).not.toHaveBeenCalled()
    })

    it("hands a steered draft to the queue as steering input", async () => {
        const onSubmit = vi.fn(async () => undefined)
        const onEnqueue = vi.fn()
        render(
            <InputSection
                {...props(draft("steer me"))}
                onEnqueueInput={onEnqueue}
                onSubmit={onSubmit}
                submissionScope="task-1"
            />,
        )

        fireEvent.click(screen.getByRole("button", { name: "Steer" }))

        expect(onEnqueue).toHaveBeenCalledWith({ text: "captured", images: ["image"], files: ["file"] }, "steering")
        await settleEffects()
        expect(onSubmit).not.toHaveBeenCalled()
    })

    // The queue panel owns the text once the entry is accepted. Leaving it in the
    // composer showed the same input twice and invited a duplicate send.
    it("clears the composer once a blocked draft is queued", async () => {
        const current = props(draft("queue me"))
        render(
            <InputSection
                {...current}
                enabled={false}
                onEnqueueInput={vi.fn()}
                onSubmit={vi.fn(async () => undefined)}
                submissionScope="task-1"
            />,
        )

        fireEvent.click(screen.getByRole("button", { name: "Submit" }))
        await settleEffects()

        // A queued draft was sent, so it stays one undo away like any other send.
        expect(current.chatState.composer.retire).toHaveBeenCalledOnce()
        expect(current.chatState.composer.clear).not.toHaveBeenCalled()
    })

    it("keeps a blocked draft visible until the durable enqueue is accepted", async () => {
        let acceptEnqueue!: (accepted: boolean) => void
        const onEnqueue = vi.fn(
            () =>
                new Promise<boolean>((resolve) => {
                    acceptEnqueue = resolve
                }),
        )
        const current = props(draft("queue me"))
        render(
            <InputSection
                {...current}
                enabled={false}
                onEnqueueInput={onEnqueue}
                onSubmit={vi.fn(async () => undefined)}
                submissionScope="task-1"
            />,
        )

        fireEvent.click(screen.getByRole("button", { name: "Submit" }))
        expect(current.chatState.composer.retire).not.toHaveBeenCalled()

        acceptEnqueue(false)
        await settleEffects()
        expect(current.chatState.composer.retire).not.toHaveBeenCalled()
    })

    // Clearing the composer is a state update, so the text area still reports the
    // old value until React re-renders. A send arriving in that window used to
    // queue the same draft again, leaving the user with duplicates and text that
    // looked like it was never taken.
    it("does not queue the same draft twice before the composer re-renders", () => {
        const onEnqueue = vi.fn()
        const current = props(draft("queue me"))
        render(
            <InputSection
                {...current}
                enabled={false}
                onEnqueueInput={onEnqueue}
                onSubmit={vi.fn(async () => undefined)}
                submissionScope="task-1"
            />,
        )

        const submit = screen.getByRole("button", { name: "Submit" })
        fireEvent.click(submit)
        fireEvent.click(submit)

        expect(onEnqueue).toHaveBeenCalledOnce()
    })

    // The queue only drains at a turn end or a tool round. When the task will
    // reach neither, an entry accepted here would sit there forever while the
    // user believes the text was sent.
    it("does not queue a blocked draft when the task has no delivery point left", () => {
        const onEnqueue = vi.fn()
        const current = props(draft("keep me"))
        render(
            <InputSection
                {...current}
                canQueueInput={false}
                enabled={false}
                onEnqueueInput={onEnqueue}
                onSubmit={vi.fn(async () => undefined)}
                submissionScope="task-1"
            />,
        )

        fireEvent.click(screen.getByRole("button", { name: "Submit" }))

        expect(onEnqueue).not.toHaveBeenCalled()
        // The draft stays where the user can still see and resend it.
        expect(current.chatState.composer.retire).not.toHaveBeenCalled()
        expect(current.chatState.composer.clear).not.toHaveBeenCalled()
        // ...and the refused send is explained instead of vanishing without a trace.
        expect(current.chatState.composer.reportSendRefusal).toHaveBeenCalledWith("input_not_ready")
    })

    // `enabled` is undefined whenever the composer has no interaction to answer,
    // which is the common case while a task runs. The text area still blocks the
    // send and queues it, so the composer has to be cleared on this path too.
    it("clears the composer when the send was blocked without an explicit enabled flag", async () => {
        const onEnqueue = vi.fn()
        const current = props(draft("queue me"))
        current.chatState = { ...current.chatState, sendingDisabled: true }
        render(
            <InputSection
                {...current}
                onEnqueueInput={onEnqueue}
                onSubmit={vi.fn(async () => undefined)}
                submissionScope="task-1"
            />,
        )

        fireEvent.click(screen.getByRole("button", { name: "Submit" }))
        await settleEffects()

        expect(onEnqueue).toHaveBeenCalledWith({ text: "captured", images: ["image"], files: ["file"] }, "queued")
        expect(current.chatState.composer.retire).toHaveBeenCalledOnce()
    })

    // The queue is the only place a blocked send can survive. Without a queue to
    // hand it to there is nothing to clear the composer for, and wiping it would
    // destroy what the user typed.
    it("keeps the draft in the composer when there is no queue to receive it", () => {
        const current = props(draft("keep me"))
        render(<InputSection {...current} enabled={false} onSubmit={vi.fn(async () => undefined)} submissionScope="task-1" />)

        fireEvent.click(screen.getByRole("button", { name: "Submit" }))

        expect(current.chatState.composer.retire).not.toHaveBeenCalled()
        expect(current.chatState.composer.clear).not.toHaveBeenCalled()
    })

    // Editing pulls the entry back into the composer, because adding images or
    // file references is only possible there.
    it("loads a queue entry back into the composer when editing starts", () => {
        const current = props(draft("current"))
        render(
            <InputSection
                {...current}
                inputQueue={[{ id: "entry-1", text: "queued text", images: ["img"], files: ["file"], mode: "queued" }]}
                onEditQueuedInput={vi.fn()}
                onSubmit={vi.fn(async () => undefined)}
                submissionScope="task-1"
            />,
        )

        fireEvent.click(screen.getByTestId("input-queue-toggle"))
        fireEvent.click(screen.getByTestId("input-queue-edit-entry-1"))

        expect(current.chatState.restoreDraft).toHaveBeenCalledWith({
            text: "queued text",
            images: ["img"],
            files: ["file"],
            activeQuote: null,
        })
    })

    // The composer now stands for the entry, so a quote left over from earlier
    // must go: committing would otherwise attach a quote the user never chose.
    it("clears a leftover quote when the edited entry carries none", () => {
        const current = props(draft("current"))
        current.chatState = { ...current.chatState, activeQuote: "unrelated quote" }
        render(
            <InputSection
                {...current}
                inputQueue={[{ id: "entry-1", text: "queued text", images: [], files: [], mode: "queued" }]}
                onEditQueuedInput={vi.fn()}
                onSubmit={vi.fn(async () => undefined)}
                submissionScope="task-1"
            />,
        )

        fireEvent.click(screen.getByTestId("input-queue-toggle"))
        fireEvent.click(screen.getByTestId("input-queue-edit-entry-1"))

        // Restoring the entry replaces the quote with the entry's own, which is none.
        expect(current.chatState.restoreDraft).toHaveBeenCalledWith(expect.objectContaining({ activeQuote: null }))
    })

    // Editing must round-trip: the next blocked send commits the entry being
    // edited instead of creating a second copy of it.
    it("commits the edited entry instead of enqueuing a duplicate", () => {
        const onEnqueue = vi.fn()
        const onCommitEdit = vi.fn()
        const current = props(draft("current"))
        render(
            <InputSection
                {...current}
                enabled={false}
                inputQueue={[{ id: "entry-1", text: "queued text", images: [], files: [], mode: "queued" }]}
                onCommitQueuedInput={onCommitEdit}
                onEditQueuedInput={vi.fn()}
                onEnqueueInput={onEnqueue}
                onSubmit={vi.fn(async () => undefined)}
                submissionScope="task-1"
            />,
        )

        fireEvent.click(screen.getByTestId("input-queue-toggle"))
        fireEvent.click(screen.getByTestId("input-queue-edit-entry-1"))
        fireEvent.click(screen.getByRole("button", { name: "Submit" }))

        expect(onCommitEdit).toHaveBeenCalledWith("entry-1", {
            text: "captured",
            images: ["image"],
            files: ["file"],
        })
        expect(onEnqueue).not.toHaveBeenCalled()
    })

    // The edited entry can vanish while the composer still holds it, by removal
    // or by switching tasks. The next blocked send is then new input and must be
    // queued; committing it to a dead id would silently discard what was typed.
    it("queues the draft when the entry being edited disappeared", () => {
        const onEnqueue = vi.fn()
        const onCommitEdit = vi.fn()
        const current = props(draft("current"))
        const entry = { id: "entry-1", text: "queued text", images: [], files: [], mode: "queued" as const }
        const view = (
            <InputSection
                {...current}
                enabled={false}
                inputQueue={[entry]}
                onCommitQueuedInput={onCommitEdit}
                onEditQueuedInput={vi.fn()}
                onEnqueueInput={onEnqueue}
                onSubmit={vi.fn(async () => undefined)}
                submissionScope="task-1"
            />
        )
        const { rerender } = render(view)

        fireEvent.click(screen.getByTestId("input-queue-toggle"))
        fireEvent.click(screen.getByTestId("input-queue-edit-entry-1"))
        rerender(
            <InputSection
                {...current}
                enabled={false}
                inputQueue={[]}
                onCommitQueuedInput={onCommitEdit}
                onEditQueuedInput={vi.fn()}
                onEnqueueInput={onEnqueue}
                onSubmit={vi.fn(async () => undefined)}
                submissionScope="task-1"
            />,
        )
        fireEvent.click(screen.getByRole("button", { name: "Submit" }))

        expect(onCommitEdit).not.toHaveBeenCalled()
        expect(onEnqueue).toHaveBeenCalledWith({ text: "captured", images: ["image"], files: ["file"] }, "queued")
    })

    // Cancelling releases the backend gate and drops the composer's claim, so
    // the next blocked send is treated as new input rather than an edit.
    it("releases the edit when the user cancels it", () => {
        const onCancelEdit = vi.fn()
        const onCommitEdit = vi.fn()
        const onEnqueue = vi.fn()
        const current = props(draft("current"))
        render(
            <InputSection
                {...current}
                enabled={false}
                inputQueue={[{ id: "entry-1", text: "queued text", images: [], files: [], mode: "queued", editing: true }]}
                onCancelQueuedInput={onCancelEdit}
                onCommitQueuedInput={onCommitEdit}
                onEditQueuedInput={vi.fn()}
                onEnqueueInput={onEnqueue}
                onSubmit={vi.fn(async () => undefined)}
                submissionScope="task-1"
            />,
        )

        fireEvent.click(screen.getByTestId("input-queue-toggle"))
        fireEvent.click(screen.getByTestId("input-queue-cancel-edit-entry-1"))
        fireEvent.click(screen.getByRole("button", { name: "Submit" }))

        expect(onCancelEdit).toHaveBeenCalledWith("entry-1")
        expect(onCommitEdit).not.toHaveBeenCalled()
        expect(onEnqueue).toHaveBeenCalledWith({ text: "captured", images: ["image"], files: ["file"] }, "queued")
    })

    it("allows a successor interaction while the previous submission is still settling", async () => {
        let resolveFirstSubmit!: () => void
        let resolveSecondSubmit!: () => void
        const onSubmit = vi
            .fn<(draft: InteractionDraft) => Promise<undefined>>()
            .mockImplementationOnce(
                () =>
                    new Promise<undefined>((resolve) => {
                        resolveFirstSubmit = () => resolve(undefined)
                    }),
            )
            .mockImplementationOnce(
                () =>
                    new Promise<undefined>((resolve) => {
                        resolveSecondSubmit = () => resolve(undefined)
                    }),
            )
            .mockResolvedValue(undefined)
        const first = props(draft("first"))
        const { rerender } = render(
            <InputSection
                {...first}
                enabled={true}
                onSubmit={onSubmit}
                submissionIdentity="interaction-1"
                submissionScope="task-1"
            />,
        )
        const submit = screen.getByRole("button", { name: "Submit" })

        fireEvent.click(submit)
        fireEvent.click(submit)
        await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())

        const second = props({ ...draft("second"), ownerRevision: 2 })
        rerender(
            <InputSection
                {...second}
                enabled={true}
                onSubmit={onSubmit}
                submissionIdentity="interaction-2"
                submissionScope="task-1"
            />,
        )
        fireEvent.click(submit)
        fireEvent.click(submit)
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))

        resolveFirstSubmit()
        await settleEffects()
        fireEvent.click(submit)
        expect(onSubmit).toHaveBeenCalledTimes(2)

        resolveSecondSubmit()
        await settleEffects()
        fireEvent.click(submit)
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(3))
    })

    it("ignores a duplicate direct submission until the first one settles", async () => {
        mocks.flushPendingTaskSettingsRequests.mockClear()
        let resolveFirstSubmit!: () => void
        const onSubmit = vi
            .fn<(draft: InteractionDraft) => Promise<undefined>>()
            .mockImplementationOnce(
                () =>
                    new Promise<undefined>((resolve) => {
                        resolveFirstSubmit = () => resolve(undefined)
                    }),
            )
            .mockResolvedValue(undefined)
        const current = props(draft("ready"))
        render(<InputSection {...current} enabled={true} onSubmit={onSubmit} submissionScope="task-1" />)

        const submit = screen.getByRole("button", { name: "Submit" })
        fireEvent.click(submit)
        fireEvent.click(submit)

        await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
        expect(mocks.flushPendingTaskSettingsRequests).toHaveBeenCalledOnce()

        resolveFirstSubmit()
        await settleEffects()
        fireEvent.click(submit)

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    })

    // An enabled composer must still submit normally; removing the replay path
    // must not disable ordinary sending.
    it("still submits directly while the input is enabled", async () => {
        const onSubmit = vi.fn(async () => undefined)
        const current = props(draft("ready"))
        render(<InputSection {...current} enabled={true} onSubmit={onSubmit} submissionScope="task-1" />)

        fireEvent.click(screen.getByRole("button", { name: "Submit" }))

        await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
    })
})
