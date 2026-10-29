import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import {
    createCompactionSourceSnapshot,
    estimateCompactionSourceRangeTokens,
    materializeCompactionSourceRange,
} from "../compaction-source-snapshot"

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8WQAAAAASUVORK5CYII="

function message(role: "user" | "assistant", text: string): ClineStorageMessage {
    return { role, content: [{ type: "text", text }] }
}

describe("CompactionSourceSnapshot", () => {
    it("captures one detached source with aligned canonical ranges and message token prefix sums", () => {
        const history = [message("user", "alpha"), message("assistant", "beta"), message("user", "gamma")]
        const snapshot = createCompactionSourceSnapshot(history, [
            [0, 0],
            [1, 1],
            [2, 2],
        ])

        expect(snapshot.messages).toEqual(history)
        expect(snapshot.messages).not.toBe(history)
        expect(snapshot.messageTokenPrefixSums).toHaveLength(history.length + 1)
        expect(snapshot.messageTokenPrefixSums[0]).toBe(0)
        expect(snapshot.messageTokenPrefixSums[3]).toBeGreaterThan(snapshot.messageTokenPrefixSums[2])
        expect(snapshot.sourceHistoryHash).toMatch(/^sha256:/)
    })

    it("answers inclusive range token costs from prefix sums without materializing messages", () => {
        const snapshot = createCompactionSourceSnapshot([
            message("user", "a".repeat(16)),
            message("assistant", "b".repeat(32)),
            message("user", "c".repeat(64)),
        ])

        const firstTwo = estimateCompactionSourceRangeTokens(snapshot, 0, 1)
        const last = estimateCompactionSourceRangeTokens(snapshot, 2, 2)

        expect(firstTwo).toBe(snapshot.messageTokenPrefixSums[2] - snapshot.messageTokenPrefixSums[0])
        expect(last).toBe(snapshot.messageTokenPrefixSums[3] - snapshot.messageTokenPrefixSums[2])
        expect(materializeCompactionSourceRange(snapshot, 0, 1)).toEqual(snapshot.messages.slice(0, 2))
    })

    it("does not charge a padded base64 image payload as text in source prefix sums", () => {
        const snapshot = createCompactionSourceSnapshot(
            [
                {
                    role: "user",
                    content: [
                        {
                            type: "image",
                            source: { type: "base64", media_type: "image/png", data: `${ONE_PIXEL_PNG}${"A".repeat(400_000)}` },
                        },
                    ],
                },
            ],
            [],
            { providerId: "openai", modelId: "gpt-5.6-sol" },
        )

        expect(estimateCompactionSourceRangeTokens(snapshot, 0, 0)).toBeLessThan(10_000)
    })

    it("rejects an out-of-bounds token range", () => {
        const snapshot = createCompactionSourceSnapshot([message("user", "alpha")])

        expect(() => estimateCompactionSourceRangeTokens(snapshot, -1, 0)).toThrow("out of bounds")
        expect(() => estimateCompactionSourceRangeTokens(snapshot, 0, 1)).toThrow("out of bounds")
    })
})
