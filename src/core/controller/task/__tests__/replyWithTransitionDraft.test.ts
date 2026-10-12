import { createInitialTaskState, type TaskState } from "@core/task/kernel"
import type { ChatContent } from "@shared/ChatContent"
import {
    SEMANTIC_INPUT_SCHEMA_VERSION,
    type SemanticInputDocument,
    type SemanticInputNode,
} from "@shared/input-semantics/document"
import { DispatchInteractionResponse } from "@shared/proto/dline/task"
import { toProtoSemanticInputDocument } from "@shared/proto-conversions/input-semantics/document"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { dispatchInteraction } from "../dispatchInteraction"
import { controllerTransitionDraftCarrier, holdTransitionDraft, replyWithTransitionDraft } from "../replyWithTransitionDraft"

vi.mock("../dispatchInteraction", () => ({ dispatchInteraction: vi.fn() }))
const dispatch = vi.mocked(dispatchInteraction)

function awaitingCompletion(): TaskState {
    return {
        ...createInitialTaskState("task-1"),
        revision: 18,
        dialog: {
            approvalsByBlock: {},
            primary: {
                interactionId: "interaction-1",
                turnId: "turn-1",
                kind: "completion",
                status: "awaiting",
                createdRevision: 6,
                presentationRef: "presentation-1",
                actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
                receiverGeneration: 0,
            },
        },
    } as TaskState
}

function controllerWith(state: TaskState) {
    return { task: { taskId: "task-1", taskInstanceId: "open-1", state: () => state } } as never
}

const DRAFT = { message: "E2E_PLAN_DRAFT", images: ["image"], files: ["file"] }

const IMAGE_NODE: SemanticInputNode = {
    kind: "image",
    entityId: "entity-image",
    resourceId: "resource-image",
    displayName: "shot.png",
}

function documentOf(rawText: string, nodes: SemanticInputNode[]): SemanticInputDocument {
    return {
        schemaVersion: SEMANTIC_INPUT_SCHEMA_VERSION,
        parserVersion: "test",
        catalogRevision: "catalog-1",
        documentId: "document-1",
        rawText,
        nodes,
        resources: [],
    }
}

function sessionWith(state: TaskState, record = vi.fn().mockResolvedValue("recorded")) {
    return { taskId: "task-1", state: () => state, transitionDrafts: { record } } as never
}

describe("replyWithTransitionDraft", () => {
    beforeEach(() => dispatch.mockReset())

    it("answers the awaiting dialog for the opening the switch was committed on", async () => {
        dispatch.mockResolvedValue(DispatchInteractionResponse.create({ accepted: true, result: "accepted" }))

        await expect(replyWithTransitionDraft(controllerWith(awaitingCompletion()), DRAFT)).resolves.toBe("replied")

        expect(dispatch).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                taskId: "task-1",
                // dispatchInteraction refuses a reply that names no opening.
                taskInstanceId: "open-1",
                turnId: "turn-1",
                interactionId: "interaction-1",
                actionId: "reply",
                stateRevision: 18,
                draft: { text: "E2E_PLAN_DRAFT", images: ["image"], files: ["file"] },
            }),
        )
    })

    it("reports a refused answer so the switch is not taken as done", async () => {
        dispatch.mockResolvedValue(DispatchInteractionResponse.create({ accepted: false, result: "stale_interaction" }))

        await expect(replyWithTransitionDraft(controllerWith(awaitingCompletion()), DRAFT)).resolves.toBe("rejected")
    })

    it("leaves an empty draft and a task with no awaiting dialog to the Webview", async () => {
        const idle = { ...createInitialTaskState("task-1"), revision: 3 } as TaskState

        await expect(replyWithTransitionDraft(controllerWith(awaitingCompletion()), { message: "  " })).resolves.toBe("none")
        await expect(replyWithTransitionDraft(controllerWith(idle), DRAFT)).resolves.toBe("none")
        await expect(replyWithTransitionDraft({ task: undefined } as never, DRAFT)).resolves.toBe("none")
        expect(dispatch).not.toHaveBeenCalled()
    })

    it("replies with the structured draft and names its resources only as document nodes", async () => {
        dispatch.mockResolvedValue(DispatchInteractionResponse.create({ accepted: true, result: "accepted" }))
        const document = documentOf("look ", [{ kind: "text", text: "look " }, IMAGE_NODE])
        const draft: ChatContent = { message: "look ", images: ["image"], files: ["file"], semanticInput: document }

        await expect(replyWithTransitionDraft(controllerWith(awaitingCompletion()), draft)).resolves.toBe("replied")

        expect(dispatch).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                draft: { text: "look ", images: [], files: [], semanticInput: toProtoSemanticInputDocument(document) },
            }),
        )
    })

    it("keeps the flat lists of a structured draft that holds no resource", async () => {
        dispatch.mockResolvedValue(DispatchInteractionResponse.create({ accepted: true, result: "accepted" }))
        const document = documentOf("/compact", [{ kind: "literal", text: "/compact", source: "pasted" }])

        await replyWithTransitionDraft(controllerWith(awaitingCompletion()), { ...DRAFT, semanticInput: document })

        expect(dispatch).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                draft: {
                    text: "E2E_PLAN_DRAFT",
                    images: ["image"],
                    files: ["file"],
                    semanticInput: toProtoSemanticInputDocument(document),
                },
            }),
        )
    })
})

describe("transition draft content", () => {
    it("keeps and delivers a resource with no text around it, and nothing for a blank draft", async () => {
        const record = vi.fn().mockResolvedValue("recorded")
        const session = sessionWith(awaitingCompletion(), record)

        await expect(holdTransitionDraft(session, { message: "", semanticInput: documentOf("", [IMAGE_NODE]) })).resolves.toBe(
            "held",
        )
        await expect(
            holdTransitionDraft(session, { message: "", semanticInput: documentOf(" ", [{ kind: "text", text: " " }]) }),
        ).resolves.toBe("none")
        expect(record).toHaveBeenCalledTimes(1)
    })
})

describe("holdTransitionDraft", () => {
    it("keeps the full draft against the dialog awaiting its reply", async () => {
        const record = vi.fn().mockResolvedValue("recorded")
        const document = documentOf("look ", [{ kind: "text", text: "look " }, IMAGE_NODE])

        await expect(
            holdTransitionDraft(sessionWith(awaitingCompletion(), record), { message: "look ", semanticInput: document }),
        ).resolves.toBe("held")

        expect(record).toHaveBeenCalledWith("interaction-1", { text: "look ", images: [], files: [], semanticInput: document })
    })

    it("keeps nothing without a dialog awaiting a reply or without content", async () => {
        const record = vi.fn().mockResolvedValue("recorded")
        const idle = { ...createInitialTaskState("task-1"), revision: 3 } as TaskState

        await expect(holdTransitionDraft(sessionWith(idle, record), DRAFT)).resolves.toBe("none")
        await expect(holdTransitionDraft(sessionWith(awaitingCompletion(), record), { message: "  " })).resolves.toBe("none")
        await expect(holdTransitionDraft({ taskId: "task-1", state: () => awaitingCompletion() } as never, DRAFT)).resolves.toBe(
            "none",
        )

        expect(record).not.toHaveBeenCalled()
    })

    it("treats a dialog that closed before the record as nothing to keep", async () => {
        const record = vi.fn().mockResolvedValue("refused")

        await expect(holdTransitionDraft(sessionWith(awaitingCompletion(), record), DRAFT)).resolves.toBe("none")
    })

    it("reports a draft a dialog awaits but that could not be made durable", async () => {
        for (const result of ["persist_failed", "read_only"]) {
            const record = vi.fn().mockResolvedValue(result)

            await expect(holdTransitionDraft(sessionWith(awaitingCompletion(), record), DRAFT)).resolves.toBe("failed")
        }
    })

    it("lets a thrown record reach the engine, which owns the failure", async () => {
        const record = vi.fn().mockRejectedValue(new Error("disk full"))

        await expect(holdTransitionDraft(sessionWith(awaitingCompletion(), record), DRAFT)).rejects.toThrow("disk full")
    })
})

describe("controllerTransitionDraftCarrier", () => {
    beforeEach(() => dispatch.mockReset())

    function controllerOn(state: TaskState, record = vi.fn().mockResolvedValue("recorded")) {
        return {
            task: { taskId: "task-1", taskInstanceId: "open-1", state: () => state, transitionDrafts: { record } },
        } as never
    }

    const SOURCE = { operationId: "operation-1", taskId: "task-1", chatContent: DRAFT }

    it("holds and delivers only for the task the transition was requested on", async () => {
        const record = vi.fn().mockResolvedValue("recorded")
        const carrier = controllerTransitionDraftCarrier(controllerOn(awaitingCompletion(), record))
        const elsewhere = { ...SOURCE, taskId: "task-2" }

        await expect(carrier.hold(elsewhere)).resolves.toBe("none")
        await expect(carrier.deliver(elsewhere)).resolves.toBe("undelivered")
        expect(record).not.toHaveBeenCalled()
        expect(dispatch).not.toHaveBeenCalled()
    })

    it("reports an empty draft apart from one that found no dialog to answer", async () => {
        const idle = { ...createInitialTaskState("task-1"), revision: 3 } as TaskState
        const carrier = controllerTransitionDraftCarrier(controllerOn(idle))

        await expect(carrier.deliver({ ...SOURCE, chatContent: { message: " " } })).resolves.toBe("empty")
        await expect(carrier.deliver(SOURCE)).resolves.toBe("undelivered")
    })

    it("reports delivery only when the awaiting dialog accepted the reply", async () => {
        const carrier = controllerTransitionDraftCarrier(controllerOn(awaitingCompletion()))

        dispatch.mockResolvedValueOnce(DispatchInteractionResponse.create({ accepted: true, result: "accepted" }))
        await expect(carrier.deliver(SOURCE)).resolves.toBe("delivered")
        dispatch.mockResolvedValueOnce(DispatchInteractionResponse.create({ accepted: false, result: "stale_interaction" }))
        await expect(carrier.deliver(SOURCE)).resolves.toBe("undelivered")
    })
})
