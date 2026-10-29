import { describe, expect, it } from "vitest"
import { formatStateSizeBreakdown, measureStateFieldSizes } from "../stateSizeProbe"

/**
 * A 12.5 MB state push logs its total size and nothing else, which says the
 * payload is too large but not which field made it so. With several tasks
 * broadcasting concurrently, that attribution is what decides whether a fix
 * targets the right field or the most recently changed one.
 */
describe("state size attribution", () => {
    it("puts the dominant field first", () => {
        const state = {
            small: "x",
            dominant: "y".repeat(10_000),
            medium: "z".repeat(100),
        }

        const breakdown = measureStateFieldSizes(state, 10_200)

        expect(breakdown.fields[0].field).toBe("dominant")
        expect(breakdown.fields[0].bytes).toBeGreaterThan(breakdown.fields[1].bytes)
    })

    it("measures each field against its own serialized size", () => {
        const payload = { items: [1, 2, 3] }
        const state = { payload }

        const breakdown = measureStateFieldSizes(state, 999)

        expect(breakdown.fields[0].bytes).toBe(Buffer.byteLength(JSON.stringify(payload), "utf8"))
    })

    it("reports the total it was given rather than recomputing it", () => {
        // The caller already serialized the whole state; recomputing would both
        // cost twice and risk disagreeing with the size that triggered the probe.
        const breakdown = measureStateFieldSizes({ a: "value" }, 123_456)

        expect(breakdown.totalBytes).toBe(123_456)
    })

    /**
     * A field that cannot be serialized must not take the rest of the
     * breakdown down with it. The whole-state serialization already succeeded
     * before the probe ran, so an individual failure here is that field's own
     * problem — and withholding every other measurement would defeat the probe.
     */
    it("keeps measuring other fields when one cannot be serialized", () => {
        const cyclic: Record<string, unknown> = {}
        cyclic.self = cyclic
        const state = { cyclic, healthy: "a".repeat(500) }

        const breakdown = measureStateFieldSizes(state, 600)

        const healthy = breakdown.fields.find((entry) => entry.field === "healthy")
        expect(healthy?.bytes).toBeGreaterThan(0)
        expect(breakdown.fields.find((entry) => entry.field === "cyclic")?.bytes).toBe(0)
    })

    it("omits absent fields rather than reporting them as empty", () => {
        const breakdown = measureStateFieldSizes({ present: 1, absent: undefined }, 10)

        expect(breakdown.fields.map((entry) => entry.field)).toEqual(["present"])
    })
})

describe("state size breakdown rendering", () => {
    it("names the largest fields and their sizes", () => {
        const line = formatStateSizeBreakdown({
            totalBytes: 5000,
            fields: [
                { field: "focusChainHistory", bytes: 4000 },
                { field: "clineMessages", bytes: 900 },
            ],
        })

        expect(line).toContain("totalBytes=5000")
        expect(line).toContain("focusChainHistory=4000")
        expect(line).toContain("clineMessages=900")
    })

    /**
     * Once the dominant field is an order of magnitude ahead, the tail is noise.
     * A line naming every field would be unreadable in the log it clarifies, so
     * the remainder is summed instead of dropped.
     */
    it("collapses the tail into a single remainder", () => {
        const fields = Array.from({ length: 8 }, (_, index) => ({
            field: `field${index}`,
            bytes: 100 - index * 10,
        }))

        const line = formatStateSizeBreakdown({ totalBytes: 520, fields }, 5)

        expect(line).toContain("field0=100")
        expect(line).not.toContain("field5=")
        // 50 + 40 + 30 for the three fields beyond the top five.
        expect(line).toContain("other=120")
    })

    it("omits the remainder when nothing was collapsed", () => {
        const line = formatStateSizeBreakdown({ totalBytes: 100, fields: [{ field: "only", bytes: 100 }] }, 5)

        expect(line).not.toContain("other=")
    })
})
