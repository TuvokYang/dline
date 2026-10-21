import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { USAGE_HISTOGRAM_BUCKETS, type UsageBodyWire, validateUsageBody } from "../../contracts/usageBody"

/**
 * The review package publishes three sample bodies. They are checked against the
 * real validator so a documented sample cannot drift away from the wire contract
 * it claims to demonstrate.
 */
const SAMPLES = resolve(__dirname, "../../../../../../tmp/usage-v3-samples.md")

/** Every fenced JSON block of the sample document, in document order. */
function sampleBodies(): UsageBodyWire[] {
    const markdown = readFileSync(SAMPLES, "utf8")
    const blocks = [...markdown.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]))
    return blocks as UsageBodyWire[]
}

describe("documented review samples", () => {
    const samples = sampleBodies()

    it("publishes exactly the three samples the review asks for", () => {
        expect(samples).toHaveLength(3)
        for (const sample of samples) expect(sample.schema_version).toBe(3)
    })

    it("passes the same validator every sent body passes", () => {
        for (const [index, sample] of samples.entries()) {
            expect(validateUsageBody(sample), `sample ${index + 1}`).toEqual([])
        }
    })

    it("keeps the identity distinction each sample is meant to demonstrate", () => {
        const [singleModel, crossRole, customPair] = samples

        // A: one role, one model, one custom flag.
        expect(new Set(singleModel.facts.map((fact) => `${fact.role}/${fact.model}/${fact.custom}`)).size).toBe(1)

        // B: the same model under two roles stays two facts, not one.
        expect(crossRole.facts).toHaveLength(2)
        expect(new Set(crossRole.facts.map((fact) => fact.model)).size).toBe(1)
        expect(new Set(crossRole.facts.map((fact) => fact.role)).size).toBe(2)

        // C: the same model under the same role differs only by `custom`.
        expect(customPair.facts).toHaveLength(2)
        expect(new Set(customPair.facts.map((fact) => fact.model)).size).toBe(1)
        expect(new Set(customPair.facts.map((fact) => fact.custom))).toEqual(new Set([true, false]))
    })

    it("carries the full histogram width, so a sample cannot show a short bucket array", () => {
        for (const sample of samples) {
            for (const fact of sample.facts) {
                expect(fact.duration_ms.buckets).toHaveLength(USAGE_HISTOGRAM_BUCKETS)
            }
        }
    })
})
