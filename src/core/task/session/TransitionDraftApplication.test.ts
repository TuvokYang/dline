import { describe, expect, it, vi } from "vitest"
import { transition } from "../kernel/transition"
import type { TaskEvent, TaskState } from "../kernel/types"
import { createInitialTaskState } from "../kernel/types"
import type { RuntimeFacade } from "../runtime"
import type { TaskPayloadStore } from "../stores"
import { TransitionDraftApplication } from "./TransitionDraftApplication"

function awaitingReply(): TaskState {
    return {
        ...createInitialTaskState("task-1"),
        flow: { phase: "waiting" },
        dialog: {
            approvalsByBlock: {},
            primary: {
                interactionId: "i-1",
                turnId: "turn-1",
                kind: "followup",
                status: "awaiting",
                createdRevision: 1,
                presentationRef: "question:i-1",
                actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
                receiverGeneration: 0,
            },
        },
    }
}

function harness(initial: TaskState, writable = true) {
    let state = initial
    const stored = new Map<string, Uint8Array>()
    const payloads: TaskPayloadStore = {
        put: vi.fn(async (bytes: Uint8Array) => {
            const ref = `sha256:${stored.size}`
            stored.set(ref, bytes)
            return ref
        }),
        read: vi.fn(async (ref: string) => {
            const bytes = stored.get(ref)
            if (!bytes) throw new Error("TaskPayloadNotFound")
            return bytes
        }),
    }
    const runtime = {
        getState: () => state,
        isWritable: () => writable,
        submit: vi.fn(async (event: TaskEvent) => {
            const result = transition(state, event)
            if (result.kind === "rejected") return result
            state = result.state
            return { ...result, receipt: { durable: Promise.resolve() } }
        }),
    } as unknown as RuntimeFacade
    return { application: new TransitionDraftApplication(runtime, payloads), payloads, stored, runtime }
}

const DRAFT = {
    text: "use /cmd:compact later",
    images: [],
    files: [],
    semanticInput: {
        schemaVersion: 1 as const,
        parserVersion: "1.0.0",
        catalogRevision: "3",
        documentId: "doc-1",
        rawText: "use /cmd:compact later",
        nodes: [{ kind: "literal" as const, text: "use /cmd:compact later", source: "pasted" as const }],
        resources: [],
    },
}

describe("TransitionDraftApplication", () => {
    it("keeps the draft for the awaiting dialog and gives it back with its document", async () => {
        const { application } = harness(awaitingReply())

        await expect(application.record("i-1", DRAFT)).resolves.toBe("recorded")
        const projected = await application.project()

        expect(projected).toMatchObject({ text: DRAFT.text, semanticInput: DRAFT.semanticInput })
        expect(projected?.draftId).toEqual(expect.any(String))
    })

    it("writes nothing for a task this window may not write", async () => {
        const { application, payloads } = harness(awaitingReply(), false)

        await expect(application.record("i-1", DRAFT)).resolves.toBe("read_only")
        expect(payloads.put).not.toHaveBeenCalled()
    })

    it("reports a refusal when no dialog awaits the draft", async () => {
        const { application } = harness(createInitialTaskState("task-1"))

        await expect(application.record("i-1", DRAFT)).resolves.toBe("refused")
        await expect(application.project()).resolves.toBeUndefined()
    })

    it("reads a lost payload as no draft", async () => {
        const { application, stored } = harness(awaitingReply())
        await application.record("i-1", DRAFT)
        stored.clear()

        await expect(application.project()).resolves.toBeUndefined()
    })

    it("reads each recorded draft once, also when its payload is lost", async () => {
        const { application, payloads, stored } = harness(awaitingReply())
        await application.record("i-1", DRAFT)
        stored.clear()

        await application.project()
        await application.project()
        expect(payloads.read).toHaveBeenCalledTimes(1)

        // A newly recorded draft is a new fact and is read again.
        await application.record("i-1", DRAFT)
        await expect(application.project()).resolves.toMatchObject({ text: DRAFT.text })
        expect(payloads.read).toHaveBeenCalledTimes(2)
    })
})
