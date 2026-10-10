import { beforeEach, describe, expect, it, vi } from "vitest"
import { storeOversizedPaste } from "../paste-resource"

const createInputTextResource = vi.fn()

vi.mock("@/services/grpc-client", () => ({
    TaskServiceClient: {
        createInputTextResource: (...args: unknown[]) => createInputTextResource(...args),
    },
}))

function pasteOf(lines: number): string {
    return Array.from({ length: lines }, (_, line) => `line ${line}`).join("\n")
}

describe("storeOversizedPaste", () => {
    beforeEach(() => {
        createInputTextResource.mockReset()
    })

    it("keeps a paste inline while it fits the shared inline budget", async () => {
        expect(await storeOversizedPaste(pasteOf(19))).toBeUndefined()
        expect(createInputTextResource).not.toHaveBeenCalled()
    })

    it("hands an oversized paste to the host and reports the stored file", async () => {
        createInputTextResource.mockResolvedValue({
            created: true,
            result: "created",
            absolutePath: "/tasks/t1/tmp/input-resources/input_20260922_ab12cd34.txt",
            displayName: "input_20260922_ab12cd34.txt",
            lineCount: 24,
        })

        const stored = await storeOversizedPaste(pasteOf(24))

        expect(stored?.displayName).toBe("input_20260922_ab12cd34.txt")
        expect(stored?.lineCount).toBe(24)
        expect(createInputTextResource).toHaveBeenCalledTimes(1)
    })

    it("keeps the paste inline when no task owns the input yet", async () => {
        createInputTextResource.mockResolvedValue({ created: false, result: "missing_task" })

        expect(await storeOversizedPaste(pasteOf(24))).toBeUndefined()
    })

    it("keeps the paste inline when the host call fails", async () => {
        createInputTextResource.mockRejectedValue(new Error("transport closed"))

        expect(await storeOversizedPaste(pasteOf(24))).toBeUndefined()
    })
})
