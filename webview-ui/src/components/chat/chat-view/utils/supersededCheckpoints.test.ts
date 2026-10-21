import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { dropSupersededChatOnlyCheckpoints } from "./supersededCheckpoints"

function checkpoint(ts: number, hash?: string, extra: Partial<UiMessage> = {}): UiMessage {
    return {
        ts,
        type: "say",
        say: "checkpoint_created",
        checkpointSource: { kind: "round_start", turnId: `turn-${ts}` },
        ...(hash ? { lastCheckpointHash: [hash] } : {}),
        ...extra,
    } as UiMessage
}

function tool(ts: number): UiMessage {
    return { ts, type: "say", say: "tool", text: JSON.stringify({ tool: "readFile", path: "a.ts" }) } as UiMessage
}

const timestamps = (messages: UiMessage[]) => messages.map((message) => message.ts)

describe("dropSupersededChatOnlyCheckpoints", () => {
    it("leaves out a chat-only checkpoint drawn right before another checkpoint", () => {
        expect(timestamps(dropSupersededChatOnlyCheckpoints([tool(1), checkpoint(2), checkpoint(3, "abc"), tool(4)]))).toEqual([
            1, 3, 4,
        ])
    })

    it("keeps a chat-only checkpoint when a drawn row separates it from the next one", () => {
        expect(timestamps(dropSupersededChatOnlyCheckpoints([checkpoint(1), tool(2), checkpoint(3, "abc")]))).toEqual([1, 2, 3])
    })

    it("keeps the checkpoint the user restored to", () => {
        const restored = checkpoint(1, undefined, { isCheckpointCheckedOut: true })
        expect(timestamps(dropSupersededChatOnlyCheckpoints([restored, checkpoint(2, "abc")]))).toEqual([1, 2])
    })

    it("leaves out the earlier adjacent checkpoint when both restore the same files", () => {
        const roots = { checkpointWorkspaceRoots: ["C:/workspace"] }

        expect(timestamps(dropSupersededChatOnlyCheckpoints([checkpoint(1, "abc", roots), checkpoint(2, "abc", roots)]))).toEqual(
            [2],
        )
    })

    it("keeps adjacent checkpoints that restore different files", () => {
        expect(timestamps(dropSupersededChatOnlyCheckpoints([checkpoint(1, "abc"), checkpoint(2, "def")]))).toEqual([1, 2])
    })
})
