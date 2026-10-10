import { describe, expect, it } from "vitest"
import { hydrate, requiredPayloadRefs } from "../hydrate"
import type { DialogInteraction, HydrateResult, TaskState } from "../types"
import { createInitialTaskState } from "../types"

function prepared(kind: string): DialogInteraction {
    return {
        interactionId: `${kind}:1`,
        turnId: "turn-1",
        kind,
        status: "prepared",
        createdRevision: 1,
        presentationRef: `${kind}:presentation`,
        actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
        journalRef: "journal:2",
        receiverGeneration: 0,
    }
}

function base(): TaskState {
    return {
        ...createInitialTaskState("task-1"),
        revision: 4,
        flow: { phase: "running" },
        turn: {
            turnId: "turn-1",
            mode: "serial",
            blocks: [],
            manualApprovalBlockIds: [],
            automaticApprovalBlockIds: [],
            executingBlockIds: [],
        },
    }
}

function ready(snapshot: TaskState) {
    const result = hydrate({ taskId: "task-1", snapshot, journalTail: { seq: 10 }, openReason: "crash_recovery" })
    expect(result).toMatchObject({ kind: "ready", rebuilt: false })
    return result
}

/** A task rebuilt from the journal: interrupted, resumable, and carrying why. */
function expectRebuilt(result: HydrateResult, code: string) {
    expect(result).toMatchObject({ kind: "ready", form: "interrupted", rebuilt: true })
    expect(result.state.flow).toEqual({ phase: "paused" })
    expect(result.state.dialog.primary).toMatchObject({ kind: "resume", status: "planned" })
    expect(result.initialCommands.map((command) => command.type)).toEqual(["dialog.prepare"])
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code)
}

describe("task kernel hydrate forms", () => {
    it("creates an inert resume interaction for interrupted work", () => {
        const result = ready(base())
        expect(result.form).toBe("interrupted")
        expect(result.state).toMatchObject({ generation: 1, revision: 5, flow: { phase: "paused" } })
        expect(result.state.dialog.primary).toMatchObject({ kind: "resume", status: "planned" })
        expect(result.initialCommands.map((command) => command.type)).toEqual(["dialog.prepare"])
    })

    it("preserves a terminal automatic-compaction failure as a recovery fact", () => {
        const snapshot: TaskState = {
            ...base(),
            flow: {
                phase: "terminated",
                error: "automatic_compaction_failed",
                compaction: {
                    compactionId: "compaction-1",
                    attempt: "compaction-1:1",
                    contextRef: "context:1",
                    status: "failed",
                    message: "provider refused",
                },
            },
            dialog: {
                primary: {
                    ...prepared("error_retry"),
                    interactionId: "error:compose.failed:5",
                    actionRules: [
                        { actionId: "retry", payloadPolicy: "draft" },
                        { actionId: "start_new_task", payloadPolicy: "draft" },
                    ],
                },
                approvalsByBlock: {},
            },
        }

        const result = ready(snapshot)

        expect(result.state.flow).toMatchObject({
            phase: "paused",
            error: "automatic_compaction_failed",
            compaction: { compactionId: "compaction-1", status: "failed" },
        })
    })

    it("restores a pending manual tool approval instead of replacing it with Resume", () => {
        const interactionId = "approval:dline_tid_01"
        const result = ready({
            ...base(),
            turn: {
                ...base().turn,
                blocks: [
                    {
                        blockId: "block-1",
                        index: 0,
                        phase: "awaiting_approval",
                        attempt: "attempt-1",
                        lanes: [],
                        turnEnding: false,
                        invocationRef: "invocation:1",
                    },
                ],
                manualApprovalBlockIds: ["block-1"],
            },
            dialog: {
                approvalsByBlock: {
                    "block-1": {
                        interactionId,
                        turnId: "turn-1",
                        kind: "tool_approval",
                        status: "awaiting",
                        createdRevision: 3,
                        presentationRef: interactionId,
                        actionRules: [
                            { actionId: "approve", payloadPolicy: "draft" },
                            { actionId: "reject", payloadPolicy: "draft" },
                        ],
                        blockId: "block-1",
                        receiverGeneration: 0,
                    },
                },
            },
        })

        expect(result.state.flow).toEqual({ phase: "waiting" })
        expect(result.state.dialog.primary).toBeUndefined()
        expect(result.state.dialog.approvalsByBlock["block-1"]).toMatchObject({
            interactionId,
            kind: "tool_approval",
            status: "awaiting",
            receiverGeneration: 1,
            actionRules: [
                { actionId: "approve", payloadPolicy: "draft" },
                { actionId: "reject", payloadPolicy: "draft" },
            ],
        })
        expect(result.initialCommands).toEqual([])
    })

    it.each([
        ["prepared", "journal:7", "dialog.reveal"],
        ["planned", undefined, "dialog.prepare"],
    ] as const)("restores an approval whose anchor row was torn as %s so it is revealed again", (status, journalRef, command) => {
        const interactionId = "approval:dline_tid_torn"
        const awaiting = {
            interactionId,
            turnId: "turn-1",
            kind: "tool_approval",
            status: "awaiting",
            createdRevision: 3,
            presentationRef: interactionId,
            actionRules: [{ actionId: "approve", payloadPolicy: "draft" }],
            blockId: "block-1",
            receiverGeneration: 0,
            ...(journalRef ? { journalRef } : {}),
        } satisfies DialogInteraction
        const snapshot: TaskState = {
            ...base(),
            turn: {
                ...base().turn,
                blocks: [
                    {
                        blockId: "block-1",
                        index: 0,
                        phase: "awaiting_approval",
                        attempt: "attempt-1",
                        lanes: [],
                        turnEnding: false,
                        invocationRef: "invocation:1",
                    },
                ],
                manualApprovalBlockIds: ["block-1"],
            },
            dialog: { approvalsByBlock: { "block-1": awaiting } },
        }

        const result = hydrate({
            taskId: "task-1",
            snapshot,
            journalTail: { seq: 10 },
            openReason: "crash_recovery",
            unanchoredInteractionIds: new Set([interactionId]),
        })

        expect(result.state.dialog.approvalsByBlock["block-1"]).toMatchObject({ interactionId, status })
        expect(result.initialCommands).toEqual([expect.objectContaining({ type: command, interactionId })])
        // The same snapshot with its row intact is answered where it stands.
        expect(ready(snapshot).state.dialog.approvalsByBlock["block-1"]).toMatchObject({ status: "awaiting" })
    })

    it.each([
        ["completed", { phase: "completed", completionId: "completion-1" }, "completion"],
        ["error", { phase: "error", error: "provider failed" }, "error_retry"],
    ] as const)("normalizes %s without automatic execution", (form, flow, kind) => {
        const result = ready({ ...base(), flow, dialog: { primary: prepared(kind), approvalsByBlock: {} } })
        expect(result.form).toBe(form)
        expect(result.state.flow).toEqual(flow)
        expect(result.initialCommands.map((command) => command.type)).toEqual(["dialog.reveal"])
    })

    it("makes a consumed task inert", () => {
        const result = ready({
            ...base(),
            flow: { phase: "terminated", terminalReason: "consumed", consumedRef: "handoff:1" },
            dialog: { primary: prepared("completion"), approvalsByBlock: {} },
        })
        expect(result.form).toBe("consumed")
        expect(result.state.dialog.primary).toBeUndefined()
        expect(result.initialCommands).toEqual([])
    })

    it.each([
        [
            "prepared without journal",
            { ...base(), dialog: { primary: { ...prepared("resume"), journalRef: undefined }, approvalsByBlock: {} } },
            "missing_journal_ref",
        ],
        [
            "journal ahead of tail",
            { ...base(), dialog: { primary: { ...prepared("resume"), journalRef: "journal:11" }, approvalsByBlock: {} } },
            "journal_ahead_of_tail",
        ],
        [
            // Runtime journals were never released with epochs, so this form is not read.
            "an epoch-qualified journal ref",
            { ...base(), dialog: { primary: { ...prepared("resume"), journalRef: "journal:0:3" }, approvalsByBlock: {} } },
            "invalid_journal_ref",
        ],
        ["a snapshot ahead of the journal", { ...base(), journalWatermark: { seq: 11 } }, "journal_ahead_of_tail"],
        ["a snapshot of another task", { ...base(), taskId: "task-other" }, "task_identity_mismatch"],
    ] as const)("rebuilds %s as interrupted instead of refusing it", (_name, snapshot, code) => {
        const result = hydrate({ taskId: "task-1", snapshot, journalTail: { seq: 10 }, openReason: "resume" })

        expectRebuilt(result, code)
        // The rebuilt state is positioned at the journal it was rebuilt from.
        expect(result.state.journalWatermark).toEqual({ seq: 10 })
    })

    // A task written before runtime snapshots existed, or one whose snapshot write
    // never landed, still has its conversation in the journal.
    it.each([
        ["journal content", { seq: 7 }],
        ["no history at all", { seq: 0 }],
    ] as const)("recovers a snapshotless task with %s", (_name, journalTail) => {
        const result = hydrate({ taskId: "task-1", journalTail, openReason: "resume" })

        expectRebuilt(result, "snapshot_missing")
    })

    it("rebuilds a snapshot whose structure is not a task state", () => {
        const snapshot = { ...base(), turn: undefined } as unknown as TaskState

        const result = hydrate({ taskId: "task-1", snapshot, journalTail: { seq: 10 }, openReason: "crash_recovery" })

        expectRebuilt(result, "malformed_snapshot")
    })

    it("rebuilds a snapshot whose required payloads are gone", () => {
        const snapshot: TaskState = {
            ...base(),
            turn: {
                ...base().turn,
                blocks: [
                    {
                        blockId: "block-1",
                        index: 0,
                        phase: "ready",
                        attempt: "attempt-1",
                        lanes: [],
                        turnEnding: false,
                        invocationRef: "invocation:1",
                    },
                ],
            },
        }

        const result = hydrate({
            taskId: "task-1",
            snapshot,
            journalTail: { seq: 10 },
            openReason: "crash_recovery",
            unavailablePayloads: new Set(["invocation:1"]),
        })

        expectRebuilt(result, "payload_missing")
    })

    it("keeps a snapshot whose missing payloads nothing will read again", () => {
        const snapshot: TaskState = {
            ...base(),
            turn: {
                ...base().turn,
                blocks: [
                    {
                        blockId: "block-1",
                        index: 0,
                        phase: "completed",
                        attempt: "attempt-1",
                        lanes: [],
                        turnEnding: false,
                        invocationRef: "invocation:1",
                    },
                ],
            },
        }

        const result = hydrate({
            taskId: "task-1",
            snapshot,
            journalTail: { seq: 10 },
            openReason: "crash_recovery",
            unavailablePayloads: new Set(["invocation:1"]),
        })

        expect(result).toMatchObject({ form: "interrupted", rebuilt: false })
    })

    // Command identities derive from revision and generation, and a published
    // identity is never dispatched again. Restarting a rebuild from zero could
    // reuse one, leaving the resume dialog planned but never prepared.
    it("continues revision and generation from the discarded snapshot", () => {
        const snapshot = { ...base(), revision: 40, generation: 6, halt: { status: "idle", generation: 2 } } as TaskState

        const result = hydrate({ taskId: "task-1", snapshot, journalTail: { seq: 10 }, openReason: "resume" })

        expectRebuilt(result, "invalid_generation")
        expect(result.state).toMatchObject({ revision: 41, generation: 7, halt: { generation: 7 } })
    })
})

describe("requiredPayloadRefs", () => {
    it("lists what unfinished work will read again and nothing it will not", () => {
        const accepted: DialogInteraction = {
            ...prepared("question"),
            acceptedResponse: { actionId: "reply", stateRevision: 3, receiverGeneration: 0, draftRef: "draft:1" },
        }
        const state: TaskState = {
            ...base(),
            turn: {
                ...base().turn,
                blocks: [
                    {
                        blockId: "done",
                        index: 0,
                        phase: "completed",
                        attempt: "a",
                        lanes: [],
                        turnEnding: false,
                        invocationRef: "invocation:done",
                    },
                    {
                        blockId: "open",
                        index: 1,
                        phase: "awaiting_approval",
                        attempt: "a",
                        lanes: [],
                        turnEnding: false,
                        invocationRef: "invocation:open",
                    },
                ],
            },
            dialog: { primary: accepted, approvalsByBlock: {} },
            intake: {
                queued: [
                    {
                        entryId: "e1",
                        payloadRef: "input:consumed",
                        source: "user",
                        mode: "queued",
                        sequence: 0,
                        state: "consumed",
                    },
                    {
                        entryId: "e2",
                        payloadRef: "input:pending",
                        source: "user",
                        mode: "queued",
                        sequence: 1,
                        state: "accepted",
                    },
                ],
                background: [],
                coTask: [],
            },
        }

        expect([...requiredPayloadRefs(state)].sort()).toEqual(["draft:1", "input:pending", "invocation:open"])
    })
})
