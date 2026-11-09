import { describe, expect, it } from "vitest"
import { projectRoundUsage } from "./roundUsageProjection"

const point = (overrides: Record<string, unknown> = {}) => ({
    roundId: "round-1",
    ...overrides,
})

/**
 * The header states a round only when the round can support a figure.
 *
 * A round that reported no usage at all would otherwise reach the fold step as an
 * empty entry: the block would then claim a cost line whose text is empty, which
 * reads as "this block cost nothing" instead of "nothing was reported".
 */
describe("projectRoundUsage", () => {
    it("keeps a round that states a generation time", () => {
        const [usage] = projectRoundUsage([point({ providerDurationMs: 4_000, outputTokens: 600 })] as never)

        expect(usage?.roundId).toBe("round-1")
        expect(usage?.providerDurationMs).toBe(4_000)
        expect(usage?.averageTokensPerSecond).toBeUndefined()
    })

    it("drops a round that reported no usage at all", () => {
        expect(projectRoundUsage([point()] as never)).toEqual([])
    })

    it("drops a round that only admits it could not measure itself", () => {
        // `usageQuality: none` with no figures is the shape a round has before the
        // provider reports anything, so it must not become a header entry.
        const [onlyNone] = projectRoundUsage([point({ usageQuality: 0 })] as never)
        expect(onlyNone).toBeUndefined()
    })

    it("drops a time bucket that is not one provider send", () => {
        // A minute aggregate has no roundId, so attributing it to a block would
        // hand that block another round's duration.
        expect(projectRoundUsage([{ providerDurationMs: 9_000, outputTokens: 900 }] as never)).toEqual([])
    })

    it("keeps a round that only reported tokens", () => {
        const [usage] = projectRoundUsage([point({ inputTokens: 100, outputTokens: 20 })] as never)

        expect(usage?.inputTokens).toBe(100)
        expect(usage?.outputTokens).toBe(20)
        expect(usage?.providerDurationMs).toBeUndefined()
    })
})
