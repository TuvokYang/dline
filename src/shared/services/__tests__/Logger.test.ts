import { afterEach, describe, expect, it, vi } from "vitest"
import { Logger } from "../Logger"

describe("Logger sensitive value redaction", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("redacts Authorization values nested in error objects", () => {
        const output = vi
            .spyOn(Logger as unknown as { output: (message: string) => void }, "output")
            .mockImplementation(() => undefined)
        const error = {
            name: "AxiosError",
            message: "Request failed with status code 404",
            config: {
                headers: {
                    Authorization: "Bearer openrouter-secret",
                    Accept: "application/json",
                },
            },
            response: { status: 404 },
        }

        Logger.error("OpenRouter generation request failed", error)

        expect(output).toHaveBeenCalledTimes(1)
        const message = output.mock.calls[0][0]
        expect(message).not.toContain("openrouter-secret")
        expect(message).toContain("[REDACTED]")
        expect(message).toContain("404")
    })

    it("redacts Bearer tokens embedded in string diagnostics", () => {
        const output = vi
            .spyOn(Logger as unknown as { output: (message: string) => void }, "output")
            .mockImplementation(() => undefined)

        Logger.error("Request failed: Authorization: Bearer openrouter-secret")

        const message = output.mock.calls[0][0]
        expect(message).not.toContain("openrouter-secret")
        expect(message).toContain("Bearer [REDACTED]")
    })
})
