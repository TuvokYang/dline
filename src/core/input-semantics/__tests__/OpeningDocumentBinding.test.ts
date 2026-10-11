import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { describe, expect, it, vi } from "vitest"
import type { EventSubmissionResult } from "@/core/task/runtime"
import { SemanticInputRejectedError } from "@/core/task/session/TaskInputAdmission"
import type { DraftDocumentAdoption } from "../DraftInputResourceStore"
import { resourceFailed, resourceSucceeded } from "../InputResourceFailure"
import { preflightOpeningDocument, releaseOpeningOnceDurable } from "../OpeningDocumentBinding"

const DOCUMENT = { documentId: "doc-opening", resources: [] } as unknown as SemanticInputDocument

const accepted = (revision: number) =>
    ({ kind: "accepted", state: {}, commands: [], receipt: { revision } }) as unknown as EventSubmissionResult
const rejected = () => ({ kind: "rejected", state: {}, reason: "read_only" }) as unknown as EventSubmissionResult

function adoption(): DraftDocumentAdoption & { release: ReturnType<typeof vi.fn> } {
    return { document: DOCUMENT, release: vi.fn(async () => {}) }
}

describe("preflightOpeningDocument", () => {
    it("lets an opening whose draft resources verify through", async () => {
        await expect(preflightOpeningDocument(DOCUMENT, async () => resourceSucceeded(undefined))).resolves.toBeUndefined()
    })

    it("refuses an opening whose draft resources would not be adopted, before any task exists", async () => {
        const verify = async () => resourceFailed<void>("semantic_input_resource_changed", "changed after staging", "res-1")

        await expect(preflightOpeningDocument(DOCUMENT, verify)).rejects.toBeInstanceOf(SemanticInputRejectedError)
    })
})

describe("releaseOpeningOnceDurable", () => {
    it("removes the draft copies only after the accepted start is durable", async () => {
        const opening = adoption()
        let durable!: () => void
        const waitForDurable = vi.fn(() => new Promise<void>((resolve) => (durable = resolve)))

        const releasing = releaseOpeningOnceDurable(opening, accepted(7), { waitForDurable })
        await Promise.resolve()

        expect(waitForDurable).toHaveBeenCalledExactlyOnceWith(7)
        expect(opening.release).not.toHaveBeenCalled()
        durable()
        await releasing
        expect(opening.release).toHaveBeenCalledOnce()
    })

    it("keeps the draft copies when the start was refused", async () => {
        const opening = adoption()
        const waitForDurable = vi.fn(async () => {})

        await releaseOpeningOnceDurable(opening, rejected(), { waitForDurable })

        expect(waitForDurable).not.toHaveBeenCalled()
        expect(opening.release).not.toHaveBeenCalled()
    })

    it("keeps the draft copies when durability cannot be confirmed", async () => {
        const opening = adoption()

        await expect(
            releaseOpeningOnceDurable(opening, accepted(3), {
                waitForDurable: async () => Promise.reject(new Error("disk full")),
            }),
        ).rejects.toThrow("disk full")
        expect(opening.release).not.toHaveBeenCalled()
    })
})
