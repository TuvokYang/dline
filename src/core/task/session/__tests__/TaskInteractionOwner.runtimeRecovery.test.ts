import { afterEach, describe, expect, it, vi } from "vitest"
import type { InteractionOutcome } from "../../interaction/InteractionProtocol"
import { createInitialTaskState } from "../../kernel"
import type { MessageStateHandler } from "../../message-state"
import { TaskRuntime } from "../../runtime/TaskRuntime"
import type { TaskPayloadStore } from "../../stores"
import type { ActiveTaskSession } from "../ActiveTaskSession"
import { TaskInteractionOwner } from "../TaskInteractionOwner"

const runtimes: TaskRuntime[] = []
afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.disposeDeadlines()))
})

describe("interaction retirement with the real Runtime commit pipeline", () => {
    it("retries the accepted retirement receipt, not a second dialog.resolved event after the dialog is gone", async () => {
        let fail = false
        const runtime = new TaskRuntime({
            initialState: { ...createInitialTaskState("retirement"), flow: { phase: "running" } },
            vault: {
                load: async () => undefined,
                save: async () => {
                    if (fail) throw new Error("Vault unavailable")
                },
            },
            taskView: { notifyCommitted: async () => {}, notifyTransient: () => {} },
            publications: { has: async () => false, mark: async () => {} },
            executors: [{ domain: "dialog", execute: async () => {} }],
        })
        runtimes.push(runtime)
        const submit = vi.spyOn(runtime, "submit")
        const messages = {
            clineMessages: [],
            addToClineMessages: async () => {},
            flushUiMessages: async () => {},
        } as unknown as MessageStateHandler
        const owner = new TaskInteractionOwner(messages, { put: async () => "presentation" } as unknown as TaskPayloadStore)
        owner.bind({ writable: true, state: () => runtime.getState(), assembly: { runtime } } as unknown as ActiveTaskSession)
        let delivered = false
        const waiting = owner.open({ turnId: "turn", interactionId: "question", kind: "followup", presentation: "Choose" })
        void waiting.then(() => {
            delivered = true
        })
        await vi.waitFor(() => expect(runtime.getState().dialog.primary?.prepare).toBeDefined())
        let state = runtime.getState()
        const prepare = state.dialog.primary!.prepare!
        await runtime.submit({
            type: "dialog.prepared",
            generation: 0,
            interactionId: "question",
            commandId: prepare.commandId,
            originRevision: prepare.originRevision,
            receiverGeneration: 0,
            journalRef: "journal:0",
        })
        state = runtime.getState()
        const reveal = state.dialog.primary!.reveal!
        await runtime.submit({
            type: "dialog.presented",
            generation: 0,
            interactionId: "question",
            commandId: reveal.commandId,
            originRevision: reveal.originRevision,
        })
        state = runtime.getState()
        const accepted = await runtime.submit({
            type: "dialog.responded",
            generation: 0,
            taskId: state.taskId,
            turnId: "turn",
            interactionId: "question",
            stateRevision: state.revision,
            receiverGeneration: 0,
            actionId: "reply",
            draftRef: "answer",
        })
        if (accepted.kind !== "accepted") throw new Error("Response refused")
        await accepted.receipt.durable
        const answer: InteractionOutcome = { actionId: "reply", draft: { text: "proceed", images: [], files: [] } }
        fail = true
        expect(await owner.resolve("question", answer)).toBe(false)
        expect(runtime.getState().dialog.primary).toBeUndefined()
        expect(delivered).toBe(false)
        fail = false
        expect(await owner.resolve("question", answer)).toBe(true)
        expect(await waiting).toEqual(answer)
        expect(submit.mock.calls.filter(([event]) => event.type === "dialog.resolved")).toHaveLength(1)
    })
})
