import { StringRequest } from "@shared/proto/dline/common"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../.."
import { copyToClipboard } from "../copyToClipboard"

const { writeTextToClipboard } = vi.hoisted(() => ({ writeTextToClipboard: vi.fn() }))

vi.mock("@/utils/env", () => ({ writeTextToClipboard }))

describe("copyToClipboard", () => {
    afterEach(() => {
        vi.restoreAllMocks()
        writeTextToClipboard.mockReset()
    })

    it("propagates a clipboard write failure instead of reporting success", async () => {
        const failure = new Error("clipboard unavailable")
        writeTextToClipboard.mockRejectedValueOnce(failure)
        vi.spyOn(Logger, "error").mockImplementation(() => undefined)

        await expect(
            copyToClipboard({} as Controller, StringRequest.create({ value: "task runtime error details" })),
        ).rejects.toBe(failure)
        expect(writeTextToClipboard).toHaveBeenCalledWith("task runtime error details")
    })
})
