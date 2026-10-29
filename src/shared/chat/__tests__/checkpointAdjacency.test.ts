import { describe, expect, it } from "vitest"
import type { CheckpointSource, UiMessage } from "../../ExtensionMessage"
import { dropSupersededAdjacentCheckpoints } from "../checkpointAdjacency"

function checkpoint(
    ts: number,
    input: {
        hashes?: string[]
        roots?: string[]
        source?: CheckpointSource
        checkedOut?: boolean
        partial?: boolean
    } = {},
): UiMessage {
    return {
        ts,
        type: "say",
        say: "checkpoint_created",
        checkpointSource: input.source ?? { kind: "round_start", turnId: `turn-${ts}` },
        ...(input.hashes ? { lastCheckpointHash: input.hashes } : {}),
        ...(input.roots ? { checkpointWorkspaceRoots: input.roots } : {}),
        ...(input.checkedOut ? { isCheckpointCheckedOut: true } : {}),
        ...(input.partial ? { partial: true } : {}),
    }
}

const tool = (ts: number): UiMessage => ({
    ts,
    type: "say",
    say: "tool",
    text: JSON.stringify({ tool: "readFile", path: "a.ts" }),
})

const timestamps = (messages: readonly UiMessage[]) => messages.map((message) => message.ts)

describe("dropSupersededAdjacentCheckpoints", () => {
    it("keeps the later of two adjacent round checkpoints with the same legacy references", () => {
        expect(
            timestamps(
                dropSupersededAdjacentCheckpoints([checkpoint(1, { hashes: ["same"] }), checkpoint(2, { hashes: ["same"] })]),
            ),
        ).toEqual([2])
    })

    it("matches multi-root references by root identity rather than array order", () => {
        expect(
            timestamps(
                dropSupersededAdjacentCheckpoints([
                    checkpoint(1, { hashes: ["hash-a", "hash-b"], roots: ["C:/a", "C:/b"] }),
                    checkpoint(2, { hashes: ["hash-b", "hash-a"], roots: ["C:/b", "C:/a"] }),
                ]),
            ),
        ).toEqual([2])
    })

    it("compares partially successful multi-root references without treating them as chat-only", () => {
        const partial = { hashes: ["hash-a", ""], roots: ["C:/a", "C:/b"] }

        expect(timestamps(dropSupersededAdjacentCheckpoints([checkpoint(1, partial), checkpoint(2, partial)]))).toEqual([2])
        expect(
            timestamps(
                dropSupersededAdjacentCheckpoints([
                    checkpoint(1, partial),
                    checkpoint(2, { hashes: ["hash-b", ""], roots: ["C:/a", "C:/b"] }),
                ]),
            ),
        ).toEqual([1, 2])
        expect(
            timestamps(
                dropSupersededAdjacentCheckpoints([
                    checkpoint(1, { hashes: ["hash-a", ""], roots: ["C:/a"] }),
                    checkpoint(2, partial),
                ]),
            ),
        ).toEqual([1, 2])
    })

    it.each([
        {
            name: "different hashes",
            earlier: checkpoint(1, { hashes: ["old"] }),
            later: checkpoint(2, { hashes: ["new"] }),
        },
        {
            name: "different roots",
            earlier: checkpoint(1, { hashes: ["same"], roots: ["C:/a"] }),
            later: checkpoint(2, { hashes: ["same"], roots: ["C:/b"] }),
        },
        {
            name: "mixed legacy and rooted references",
            earlier: checkpoint(1, { hashes: ["same"] }),
            later: checkpoint(2, { hashes: ["same"], roots: ["C:/a"] }),
        },
        {
            name: "ambiguous duplicate roots",
            earlier: checkpoint(1, { hashes: ["same", "same"], roots: ["C:/a", "C:/a"] }),
            later: checkpoint(2, { hashes: ["same", "same"], roots: ["C:/a", "C:/a"] }),
        },
    ])("keeps adjacent checkpoints with $name", ({ earlier, later }) => {
        expect(timestamps(dropSupersededAdjacentCheckpoints([earlier, later]))).toEqual([1, 2])
    })

    it("keeps equal checkpoints when a drawn row separates them", () => {
        const same = { hashes: ["same"], roots: ["C:/workspace"] }
        expect(timestamps(dropSupersededAdjacentCheckpoints([checkpoint(1, same), tool(2), checkpoint(3, same)]))).toEqual([
            1, 2, 3,
        ])
    })

    it("keeps the checkpoint the user restored to", () => {
        const same = { hashes: ["same"], roots: ["C:/workspace"] }
        expect(
            timestamps(dropSupersededAdjacentCheckpoints([checkpoint(1, { ...same, checkedOut: true }), checkpoint(2, same)])),
        ).toEqual([1, 2])
    })

    it("keeps named restore boundaries and pending later rows", () => {
        const same = { hashes: ["same"], roots: ["C:/workspace"] }
        expect(
            timestamps(
                dropSupersededAdjacentCheckpoints([
                    checkpoint(1, { ...same, source: { kind: "pre_compaction" } }),
                    checkpoint(2, same),
                ]),
            ),
        ).toEqual([1, 2])
        expect(
            timestamps(dropSupersededAdjacentCheckpoints([checkpoint(1, same), checkpoint(2, { ...same, partial: true })])),
        ).toEqual([1, 2])
    })

    it("re-evaluates adjacency after removing a chat-only row", () => {
        const same = { hashes: ["same"], roots: ["C:/workspace"] }

        expect(timestamps(dropSupersededAdjacentCheckpoints([checkpoint(1, same), checkpoint(2), checkpoint(3, same)]))).toEqual([
            3,
        ])
    })

    it("preserves the existing chat-only supersession direction", () => {
        expect(
            timestamps(
                dropSupersededAdjacentCheckpoints([checkpoint(1), checkpoint(2, { hashes: ["files"], roots: ["C:/workspace"] })]),
            ),
        ).toEqual([2])
        expect(
            timestamps(
                dropSupersededAdjacentCheckpoints([checkpoint(1, { hashes: ["files"], roots: ["C:/workspace"] }), checkpoint(2)]),
            ),
        ).toEqual([1, 2])
    })
})
