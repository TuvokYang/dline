import { describe, expect, it } from "vitest"
import { truncateContent } from "./content-limits"

describe("content limits", () => {
    it("enforces the complete UTF-8 byte limit including the truncation marker", () => {
        const maxBytes = 1_024
        const result = truncateContent("😀".repeat(2_000), maxBytes)

        expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(maxBytes)
        expect(result).toContain("[FILE TRUNCATED:")
        expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result)
    })
})
