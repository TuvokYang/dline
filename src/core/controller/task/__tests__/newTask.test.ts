import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { lexSemanticInput } from "@shared/input-semantics/lexer"
import { NewTaskRequest } from "@shared/proto/dline/task"
import { toProtoSemanticInputDocument } from "@shared/proto-conversions/input-semantics/document"
import { describe, expect, it, vi } from "vitest"
import type { Controller } from "../.."
import { newTask } from "../newTask"

const catalogState = vi.hoisted(() => ({ revision: 3 }))

vi.mock("../../slash/input-semantic-catalog", () => ({
    inputSemanticCatalogService: () => ({
        current: () => ({ revision: catalogState.revision, descriptors: [] }),
    }),
}))

const COMPOSED_WITH: InputSemanticCatalog = { revision: 3, descriptors: BUILTIN_INPUT_SEMANTICS }

/** A pasted "/compact" held as a candidate, exactly as the composer submits it. */
function pastedCompactRequest(overrides?: { documentId?: string }) {
    const document = lexSemanticInput("/compact", {
        catalog: COMPOSED_WITH,
        documentId: overrides?.documentId ?? "doc-1",
        activation: "candidate_only",
    })
    return NewTaskRequest.create({
        text: "/compact",
        images: [],
        files: [],
        semanticInput: toProtoSemanticInputDocument(document),
    })
}

describe("newTask", () => {
    it("returns after task admission while the agent loop continues in the background", async () => {
        const initTask = vi.fn(async () => "task-123")
        const controller = { initTask } as unknown as Controller
        const request = NewTaskRequest.create({
            text: "Start a long-running task",
            images: [],
            files: [],
        })

        const response = await newTask(controller, request)

        expect(response.value).toBe("task-123")
        expect(initTask).toHaveBeenCalledWith("Start a long-running task", [], [], undefined, {}, { startInBackground: true })
    })

    it("passes stable Profile identities into successor task settings", async () => {
        const initTask = vi.fn(async () => "task-successor")
        const controller = { initTask } as unknown as Controller
        const request = NewTaskRequest.create({
            text: "Start the successor",
            images: [],
            files: [],
            taskSettings: {
                planModeProfileId: "plan-profile-id",
                planModeProfile: "plan-profile",
                actModeProfileId: "act-profile-id",
                actModeProfile: "act-profile",
            },
        })

        await newTask(controller, request)

        expect(initTask).toHaveBeenCalledWith(
            "Start the successor",
            [],
            [],
            undefined,
            expect.objectContaining({
                planModeProfileId: "plan-profile-id",
                planModeProfile: "plan-profile",
                actModeProfileId: "act-profile-id",
                actModeProfile: "act-profile",
            }),
            { startInBackground: true },
        )
    })

    describe("structured submission preflight", () => {
        it("forwards a document composed against the current catalog", async () => {
            catalogState.revision = 3
            const initTask = vi.fn(async () => "task-structured")
            const controller = { initTask } as unknown as Controller

            await newTask(controller, pastedCompactRequest())

            expect(initTask).toHaveBeenCalledWith(
                "/compact",
                [],
                [],
                undefined,
                {},
                expect.objectContaining({
                    startInBackground: true,
                    semanticInput: expect.objectContaining({ documentId: "doc-1", catalogRevision: "3" }),
                }),
            )
        })

        it("refuses a stale catalog revision before the task starts, so the caller keeps the draft", async () => {
            catalogState.revision = 4
            const initTask = vi.fn(async () => "task-never")
            const controller = { initTask } as unknown as Controller

            await expect(newTask(controller, pastedCompactRequest())).rejects.toThrow("semantic_input_catalog_stale")
            expect(initTask).not.toHaveBeenCalled()
        })

        it("refuses a structurally invalid document before the task starts", async () => {
            catalogState.revision = 3
            const initTask = vi.fn(async () => "task-never")
            const controller = { initTask } as unknown as Controller

            await expect(newTask(controller, pastedCompactRequest({ documentId: "" }))).rejects.toThrow(
                "New task input was rejected",
            )
            expect(initTask).not.toHaveBeenCalled()
        })
    })
})
