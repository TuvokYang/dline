import { describe, expect, it } from "vitest"
import { hydrate } from "../hydrate"
import type { TaskState } from "../types"

/**
 * A task reopened from history after its turn was terminated.
 *
 * The shape is taken verbatim from a recorded runtime snapshot: the turn ended
 * through a turn-ending tool, so the flow is terminated, the block is cancelled
 * and no dialog survived. Reopening it is the only way back in, so hydrate owes
 * this state a recovery dialog and the command that reveals it.
 */
function terminatedHistorySnapshot(): TaskState {
    return {
        taskId: "1790149560953",
        revision: 58,
        generation: 3,
        flow: { phase: "terminated" },
        turn: {
            turnId: "bace3412-27a9-4b1e-b0bd-0c70c6b12446",
            mode: "serial",
            blocks: [
                {
                    blockId: "dline_tid_01M36KNBW9MF06HVSK8NFCH8TG",
                    index: 0,
                    phase: "cancelled",
                    attempt: "d76ac317-bf26-44a4-8b85-691c1aaab9c1",
                    lanes: ["user-interaction"],
                    turnEnding: true,
                    invocationRef: "sha256:b3fbf789ea93e11586cf6214d6e9829edd85632d21c09f3b6a0657f497f43c54",
                },
            ],
            manualApprovalBlockIds: [],
            automaticApprovalBlockIds: [],
            executingBlockIds: [],
        },
        dialog: { approvalsByBlock: {} },
        intake: {
            queued: [
                {
                    entryId: "1790149560953:input:be6a5964-d282-49f6-9975-dde323407314",
                    payloadRef: "sha256:491a98ef802d416107c53c7c80c8634c5ee41d6cca736ada665827673c70ffcd",
                    source: "user",
                    mode: "queued",
                    sequence: 0,
                    state: "consumed",
                    journalWatermark: { seq: 3 },
                },
            ],
            background: [],
            coTask: [],
        },
        halt: { status: "idle", generation: 3 },
        journalWatermark: { seq: 16 },
    } as TaskState
}

describe("hydrate of a terminated task reopened from history", () => {
    it("offers a recovery dialog so the user can send again", () => {
        const result = hydrate({
            taskId: "1790149560953",
            snapshot: terminatedHistorySnapshot(),
            journalTail: { seq: 17 },
            openReason: "resume",
        })

        expect(result.kind).toBe("ready")
        if (result.kind !== "ready") return
        expect(result.form).toBe("interrupted")
        expect(result.state.flow.phase).toBe("paused")
        expect(result.state.dialog.primary).toMatchObject({ kind: "resume", status: "planned" })
    })

    it("emits the prepare command that makes that dialog answerable", () => {
        const result = hydrate({
            taskId: "1790149560953",
            snapshot: terminatedHistorySnapshot(),
            journalTail: { seq: 17 },
            openReason: "resume",
        })

        expect(result.kind).toBe("ready")
        if (result.kind !== "ready") return
        expect(result.initialCommands.map((command) => command.type)).toEqual(["dialog.prepare"])
        // The runtime only replays commands of the hydrated generation, so a
        // mismatch here would drop the dialog without any failure to observe.
        expect(result.initialCommands[0].generation).toBe(result.state.generation)
    })
})
