import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { EmptyRequest } from "@shared/proto/dline/common"
import { describe, expect, it, vi } from "vitest"
import { retryCheckpointInitialization } from "./retryCheckpointInitialization"

describe("retryCheckpointInitialization controller", () => {
    it("returns false when no active checkpoint manager is available", async () => {
        const result = await retryCheckpointInitialization({ task: undefined } as never, EmptyRequest.create({}))

        expect(result.value).toBe(false)
    })

    it("forwards the retry to the active checkpoint manager", async () => {
        const retry = vi.fn().mockResolvedValue(true)
        const checkpointManager = { retryCheckpointInitialization: retry }
        const controller = { task: createSessionFixture({ owners: { checkpoints: checkpointManager } }) }

        const result = await retryCheckpointInitialization(controller as never, EmptyRequest.create({}))

        expect(retry).toHaveBeenCalledOnce()
        expect(retry.mock.contexts[0]).toBe(checkpointManager)
        expect(result.value).toBe(true)
    })

    it("preserves a failed retry result", async () => {
        const retry = vi.fn().mockResolvedValue(false)
        const controller = {
            task: createSessionFixture({ owners: { checkpoints: { retryCheckpointInitialization: retry } } }),
        }

        const result = await retryCheckpointInitialization(controller as never, EmptyRequest.create({}))

        expect(retry).toHaveBeenCalledOnce()
        expect(result.value).toBe(false)
    })
})
