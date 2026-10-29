import { describe, expect, it, vi } from "vitest"
import { PromptStateCompactionLanding } from "./CompactionSummaryLanding"

describe("PromptStateCompactionLanding", () => {
    it("refreshes the frozen prompt and resets prompt-cache health after a successful landing", async () => {
        const requestRefresh = vi.fn()
        const recordCompactionResult = vi.fn()
        const landing = new PromptStateCompactionLanding({ requestRefresh }, { recordCompactionResult })

        await landing.land({
            compactionId: "compaction:1",
            attempt: "compaction:1:1",
            summary: "summary",
        })

        expect(requestRefresh).toHaveBeenCalledWith("post_compaction")
        expect(recordCompactionResult).toHaveBeenCalledWith(true)
    })
})
