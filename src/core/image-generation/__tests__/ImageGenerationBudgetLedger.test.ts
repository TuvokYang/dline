import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ImageGenerationError } from "../contracts"
import { ImageGenerationBudgetLedger } from "../ImageGenerationBudgetLedger"

async function expectImageError(promise: Promise<unknown>, code: ImageGenerationError["code"]): Promise<void> {
    try {
        await promise
        throw new Error(`Expected ImageGenerationError with code ${code}`)
    } catch (error) {
        expect(error).toBeInstanceOf(ImageGenerationError)
        expect((error as ImageGenerationError).code).toBe(code)
    }
}

describe("ImageGenerationBudgetLedger", () => {
    let tempDirectory: string
    let taskDirectory: string

    beforeEach(async () => {
        tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-image-budget-"))
        taskDirectory = path.join(tempDirectory, "tasks", "task-1")
    })

    afterEach(async () => {
        await fs.rm(tempDirectory, { recursive: true, force: true })
    })

    it("reserves, settles, releases failed work, and rejects reused request IDs", async () => {
        const first = new ImageGenerationBudgetLedger({ taskId: "task-1", taskDirectory, now: () => 1_000 })
        await first.reserve({
            requestId: "request-1",
            providerId: "openai",
            modelId: "gpt-image-2",
            estimatedCostUsd: 0.04,
            limitUsd: 0.1,
        })
        await expectImageError(
            first.reserve({
                requestId: "request-1",
                providerId: "openai",
                modelId: "gpt-image-2",
                estimatedCostUsd: 0.04,
                limitUsd: 0.1,
            }),
            "invalid_request",
        )
        await first.settle("request-1")

        const reopened = new ImageGenerationBudgetLedger({ taskId: "task-1", taskDirectory, now: () => 2_000 })
        expect(await reopened.getSpentUsd()).toBe(0.04)
        await reopened.reserve({
            requestId: "request-2",
            providerId: "openai",
            modelId: "gpt-image-2",
            estimatedCostUsd: 0.05,
            limitUsd: 0.1,
        })
        expect(await reopened.getSpentUsd()).toBe(0.04)
        await reopened.release("request-2")
        await expectImageError(
            reopened.reserve({
                requestId: "request-3",
                providerId: "openai",
                modelId: "gpt-image-2",
                estimatedCostUsd: 0.08,
                limitUsd: 0.1,
            }),
            "budget_exceeded",
        )

        const persisted = await fs.readFile(path.join(taskDirectory, "artifacts", "image-generation-budget.json"), "utf8")
        expect(persisted).not.toContain("prompt")
        expect(persisted).not.toContain("base64")
    })
})
