import { describe, expect, it } from "vitest"
import {
    boundStructuredPayload,
    MAX_SERIALIZED_PAYLOAD_CHARS,
    stringifyBoundedPayload,
} from "../../scripts/vitest-ui/lib/bounded-payload.mjs"

describe("bounded Vitest payload", () => {
    it("bounds the complete serialized tool result before it reaches the API context", () => {
        const payload = {
            summary: { total: 1, fail: 1 },
            failures: Array.from({ length: 100 }, (_, index) => ({ index, error: "x".repeat(4_000) })),
        }

        const bounded = boundStructuredPayload(payload)
        const serialized = stringifyBoundedPayload(payload)

        expect(bounded).toMatchObject({ truncated: true, summary: payload.summary })
        expect(serialized.length).toBeLessThanOrEqual(MAX_SERIALIZED_PAYLOAD_CHARS + 1_000)
    })

    it("preserves small structured results", () => {
        const payload = { summary: { total: 1 }, failures: [] }
        expect(boundStructuredPayload(payload)).toBe(payload)
    })
})
