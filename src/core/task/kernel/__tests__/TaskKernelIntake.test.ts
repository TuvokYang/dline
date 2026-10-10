import { describe, expect, it } from "vitest"
import { hydrate } from "../hydrate"
import { transition } from "../transition"
import { type ComposeRoundCommand, createInitialTaskState, type IntakeEntry, type ProviderStartCommand } from "../types"

function accepted(result: ReturnType<typeof transition>) {
    if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
    return result
}

describe("task kernel intake", () => {
    it("advances accepted entries through reserve, include and committed consumption", () => {
        const initial = { ...createInitialTaskState("task-1"), flow: { phase: "running" as const } }
        const submitted = accepted(
            transition(initial, {
                type: "user.submit",
                generation: 0,
                entryId: "entry-1",
                payloadRef: "input:1",
                mode: "steering",
            }),
        )
        const compose = submitted.commands.find((command): command is ComposeRoundCommand => command.type === "compose.round")
        if (!compose) throw new Error("missing compose command")
        expect(submitted.state.intake.queued[0]).toMatchObject({ mode: "steering", source: "user", state: "reserved" })

        const composed = accepted(
            transition(submitted.state, {
                type: "compose.completed",
                generation: 0,
                commandId: compose.commandId,
                originRevision: compose.originRevision,
                draftRef: "draft:1",
            }),
        )
        expect(composed.state.intake.queued[0].state).toBe("included")
        const provider = composed.commands.find((command): command is ProviderStartCommand => command.type === "provider.start")
        if (!provider) throw new Error("missing provider command")

        const ready = accepted(
            transition(composed.state, {
                type: "provider.turn_ready",
                generation: 0,
                commandId: provider.commandId,
                originRevision: provider.originRevision,
                turnId: "turn-1",
                finalPayloadRef: "answer:1",
                journalWatermark: { seq: 4 },
                turnPlan: { mode: "serial", blocks: [] },
            }),
        )
        expect(ready.state.intake.queued[0]).toMatchObject({ state: "consumed", journalWatermark: { seq: 4 } })
        expect(ready.state.journalWatermark).toEqual({ seq: 4 })
    })

    it("releases admitted entries when compose fails and rejects capacity overflow without mutation", () => {
        const initial = { ...createInitialTaskState("task-1"), flow: { phase: "running" as const } }
        const submitted = accepted(
            transition(initial, { type: "user.submit", generation: 0, entryId: "entry-1", payloadRef: "input:1" }),
        )
        const compose = submitted.commands[0] as ComposeRoundCommand
        const failed = accepted(
            transition(submitted.state, {
                type: "compose.failed",
                generation: 0,
                commandId: compose.commandId,
                originRevision: compose.originRevision,
                message: "failed",
            }),
        )
        expect(failed.state.intake.queued[0].state).toBe("released")

        const entries: IntakeEntry[] = Array.from({ length: 32 }, (_, index) => ({
            entryId: `entry-${index}`,
            payloadRef: `payload-${index}`,
            source: "user",
            mode: "queued",
            sequence: index + 1,
            state: "accepted",
        }))
        const full = { ...initial, intake: { ...initial.intake, queued: entries } }
        const rejected = transition(full, { type: "user.submit", generation: 0, entryId: "overflow", payloadRef: "overflow" })
        expect(rejected).toMatchObject({ kind: "rejected", reason: "capacity_exceeded", state: full })
    })

    it("turns idle background arrivals into a prepared wakeup proposal", () => {
        const result = accepted(
            transition(createInitialTaskState("task-1"), {
                type: "background.ready",
                generation: 0,
                entryId: "background-1",
                payloadRef: "result:1",
            }),
        )
        expect(result.state.intake.background[0]).toMatchObject({ source: "background", state: "accepted" })
        expect(result.state.dialog.primary).toMatchObject({ kind: "background_wakeup", status: "planned" })
        expect(result.commands).toEqual([expect.objectContaining({ type: "dialog.prepare", prepareKey: expect.any(String) })])
    })

    it("keeps a background arrival for the user's answer while a dialog is open", () => {
        const opened = accepted(
            transition(createInitialTaskState("task-1"), {
                type: "background.ready",
                generation: 0,
                entryId: "background-1",
                payloadRef: "result:1",
            }),
        ).state
        // The dialog waits for the user, so the arrival must not open a round
        // that would consume the reply the user is about to send.
        const waiting = { ...opened, flow: { phase: "waiting" as const } }
        const result = accepted(
            transition(waiting, { type: "background.ready", generation: 0, entryId: "background-2", payloadRef: "result:2" }),
        )
        expect(result.commands).toEqual([])
        expect(result.state.intake.background.map((entry) => entry.state)).toEqual(["accepted", "accepted"])
    })

    it("lets running tools carry a background arrival into their own continuation", () => {
        const base = createInitialTaskState("task-1")
        const running = {
            ...base,
            flow: { phase: "running" as const },
            turn: {
                ...base.turn,
                turnId: "turn-1",
                blocks: [{ blockId: "kill-1", phase: "executing" }] as unknown as typeof base.turn.blocks,
            },
        }
        const result = accepted(
            transition(running, { type: "background.ready", generation: 0, entryId: "background-1", payloadRef: "result:1" }),
        )
        expect(result.commands).toEqual([])
        expect(result.state.intake.background[0]).toMatchObject({ state: "accepted" })
    })

    it("lets a paused task complete the round its resumption opened", () => {
        const paused = { ...createInitialTaskState("task-1"), flow: { phase: "paused" as const } }
        const submitted = accepted(
            transition(paused, { type: "user.submit", generation: 0, entryId: "resume-1", payloadRef: "input:resume" }),
        )
        const compose = submitted.commands.find((command): command is ComposeRoundCommand => command.type === "compose.round")
        if (!compose) throw new Error("missing compose command")

        // Staying paused made the round unfinishable: compose feedback is refused
        // after a halt, so answering Resume produced no reply at all.
        const composed = accepted(
            transition(submitted.state, {
                type: "compose.completed",
                generation: 0,
                commandId: compose.commandId,
                originRevision: compose.originRevision,
                draftRef: "draft:resume",
            }),
        )

        expect(composed.state.flow.phase).not.toBe("paused")
        expect(composed.commands).toEqual([expect.objectContaining({ type: "provider.start", draftRef: "draft:resume" })])
    })

    it("loads legacy snapshots without intake and resolves uncertain entries against the committed watermark", () => {
        const snapshot = {
            ...createInitialTaskState("task-1"),
            flow: { phase: "paused" as const },
            journalWatermark: { seq: 5 },
            intake: {
                queued: [
                    {
                        entryId: "entry-1",
                        payloadRef: "input:1",
                        source: "user" as const,
                        mode: "queued" as const,
                        sequence: 1,
                        state: "uncertain" as const,
                        journalWatermark: { seq: 4 },
                    },
                ],
                background: [],
                coTask: [],
            },
        }
        const restored = hydrate({ taskId: "task-1", snapshot, journalTail: { seq: 5 }, openReason: "crash_recovery" })
        expect(restored.kind).toBe("ready")
        if (restored.kind === "ready") expect(restored.state.intake.queued[0].state).toBe("consumed")

        const legacy = { ...snapshot, intake: undefined } as unknown as typeof snapshot
        const legacyResult = hydrate({
            taskId: "task-1",
            snapshot: legacy,
            journalTail: { seq: 5 },
            openReason: "resume",
        })
        expect(legacyResult.kind).toBe("ready")
        if (legacyResult.kind === "ready") expect(legacyResult.state.intake).toEqual({ queued: [], background: [], coTask: [] })
    })
})
