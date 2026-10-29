import { describe, expect, it } from "vitest"
import { transition } from "../transition"
import type {
    Command,
    ProviderPlainTextWarningKind,
    ProviderTurnBlockPlan,
    TaskEvent,
    TaskState,
    TransitionResult,
} from "../types"
import { createInitialTaskState } from "../types"

function accepted(result: TransitionResult): Extract<TransitionResult, { kind: "accepted" }> {
    expect(result.kind).toBe("accepted")
    if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
    return result
}

function toolBlock(blockId: string): ProviderTurnBlockPlan {
    return {
        blockId,
        attempt: `attempt-${blockId}`,
        index: 0,
        lanes: [],
        turnEnding: false,
        invocationRef: `invocation:${blockId}`,
        approval: { kind: "none" },
    }
}

/** A task whose provider command is live, which is what `provider.turn_ready` answers. */
function awaitingProvider(streak?: number): TaskState {
    const base = createInitialTaskState("task-1")
    return {
        ...base,
        revision: 4,
        flow: {
            phase: "running",
            ...(streak === undefined ? {} : { textOnlyTurnStreak: streak }),
            provider: { commandId: "provider:1", originRevision: 4, status: "running", turnId: "turn-1" },
        },
    }
}

function turnReady(blocks: readonly ProviderTurnBlockPlan[]) {
    return {
        type: "provider.turn_ready" as const,
        generation: 0,
        commandId: "provider:1",
        originRevision: 4,
        turnId: "turn-1",
        finalPayloadRef: "final:1",
        journalWatermark: { seq: 3 },
        turnPlan: { mode: "serial" as const, blocks },
    }
}

function providerReady(
    state: TaskState,
    blocks: readonly ProviderTurnBlockPlan[],
    plainTextWarning?: ProviderPlainTextWarningKind,
): Extract<TaskEvent, { type: "provider.turn_ready" }> {
    const provider = state.flow.provider
    if (!provider) throw new Error("expected live provider")
    return {
        type: "provider.turn_ready",
        generation: state.generation,
        commandId: provider.commandId,
        originRevision: provider.originRevision,
        turnId: provider.turnId ?? "turn-1",
        finalPayloadRef: `final:${state.revision}`,
        journalWatermark: { seq: state.revision + 1 },
        turnPlan: {
            mode: "serial",
            blocks,
            ...(plainTextWarning === undefined ? {} : { plainTextWarning }),
        },
    }
}

function awaitingNextProvider(state: TaskState): TaskState {
    return {
        ...state,
        flow: {
            ...state.flow,
            phase: "running",
            compose: undefined,
            provider: {
                commandId: `provider:${state.revision}`,
                originRevision: state.revision,
                status: "running",
                turnId: `turn:${state.revision}`,
            },
        },
    }
}

function withWarningBudget(state: TaskState, count: number, mistakes: number): TaskState {
    return {
        ...state,
        flow: {
            ...state.flow,
            plainTextWarningCount: count,
            plainTextWarningMistakes: mistakes,
            toolMistakeCount: 0,
            consecutiveMistakeCount: mistakes,
        },
    }
}

function executingTool(state: TaskState): TaskState {
    const planned = accepted(transition(state, providerReady(state, [toolBlock("b1")]))).state
    return accepted(
        transition(planned, {
            type: "tool.started",
            generation: planned.generation,
            turnId: planned.turn.turnId ?? "turn-1",
            blockId: "b1",
            attempt: "attempt-b1",
        }),
    ).state
}

function composeRounds(commands: readonly Command[]) {
    return commands.filter((command) => command.type === "compose.round")
}

describe("kernel continuation after a turn that used no tool", () => {
    it("opens the next round and names why, so a plain answer does not end the task", () => {
        const result = accepted(transition(awaitingProvider(), turnReady([])))
        expect(composeRounds(result.commands)).toEqual([
            expect.objectContaining({ type: "compose.round", admittedEntryIds: [], continuation: "no_tools_used" }),
        ])
        expect(result.state.flow.compose?.status).toBe("running")
        expect(result.state.flow.textOnlyTurnStreak).toBe(1)
    })

    it("does not continue a turn that planned a tool, because the block will settle it", () => {
        const result = accepted(transition(awaitingProvider(), turnReady([toolBlock("b1")])))
        expect(composeRounds(result.commands)).toEqual([])
        expect(result.commands).toEqual([expect.objectContaining({ type: "tool.run", turnId: "turn-1" })])
        expect(result.state.flow.textOnlyTurnStreak).toBe(0)
    })

    it("promotes each fifth plain-text warning without growing the strict no-tool streak", () => {
        let state = awaitingProvider()
        for (let warning = 1; warning <= 10; warning += 1) {
            const result = accepted(transition(state, providerReady(state, [], "text_only")))
            expect(result.state.flow.plainTextWarningCount).toBe(warning % 5)
            expect(result.state.flow.plainTextWarningMistakes).toBe(Math.floor(warning / 5))
            expect(result.state.flow.toolMistakeCount).toBe(0)
            expect(result.state.flow.consecutiveMistakeCount).toBe(Math.floor(warning / 5))
            expect(result.state.flow.textOnlyTurnStreak).toBe(0)
            state = awaitingNextProvider(result.state)
        }
    })

    it("opens mistake-limit recovery only when a warning promotion reaches the configured limit", () => {
        const state = withWarningBudget(awaitingProvider(), 4, 2)
        const result = accepted(transition(state, providerReady(state, [], "text_only")))

        expect(result.state.flow.plainTextWarningCount).toBe(0)
        expect(result.state.flow.plainTextWarningMistakes).toBe(3)
        expect(result.state.flow.consecutiveMistakeCount).toBe(3)
        expect(result.state.flow.textOnlyTurnStreak).toBe(0)
        expect(result.state.flow.phase).toBe("waiting")
        expect(result.state.dialog.primary?.kind).toBe("mistake_limit")
        expect(composeRounds(result.commands)).toEqual([])
    })

    it("clears warning count and promoted mistakes after a successful tool result", () => {
        const running = executingTool(withWarningBudget(awaitingProvider(), 4, 2))
        const result = accepted(
            transition(running, {
                type: "tool.completed",
                generation: running.generation,
                turnId: running.turn.turnId ?? "turn-1",
                blockId: "b1",
                attempt: "attempt-b1",
                successful: true,
                mistakeCount: 0,
            }),
        )

        expect(result.state.flow.plainTextWarningCount).toBe(0)
        expect(result.state.flow.plainTextWarningMistakes).toBe(0)
        expect(result.state.flow.toolMistakeCount).toBe(0)
        expect(result.state.flow.consecutiveMistakeCount).toBe(0)
    })

    it.each([
        ["completed failed result", "tool.completed", false],
        ["failed execution", "tool.failed", undefined],
        ["cancelled execution", "tool.cancelled", undefined],
    ] as const)("does not clear warning promotion after a %s", (_label, type, successful) => {
        const running = executingTool(withWarningBudget(awaitingProvider(), 3, 2))
        const result = accepted(
            transition(running, {
                type,
                generation: running.generation,
                turnId: running.turn.turnId ?? "turn-1",
                blockId: "b1",
                attempt: "attempt-b1",
                ...(successful === undefined ? {} : { successful }),
                mistakeCount: 0,
            }),
        )

        expect(result.state.flow.plainTextWarningCount).toBe(3)
        expect(result.state.flow.plainTextWarningMistakes).toBe(2)
        expect(result.state.flow.consecutiveMistakeCount).toBe(2)
    })

    it("hands the task back once the streak reaches its bound, instead of looping forever", () => {
        // Each round is answered by a fresh provider command, so the streak is the
        // only thing that grows; the third answer is where continuing stops, which
        // is the default consecutive-mistake limit of the previous runtime.
        let state = awaitingProvider()
        for (let turn = 1; turn <= 3; turn++) {
            const result = accepted(transition(state, turnReady([])))
            expect(result.state.flow.textOnlyTurnStreak).toBe(turn)
            expect(composeRounds(result.commands)).toHaveLength(turn < 3 ? 1 : 0)
            state = { ...awaitingProvider(result.state.flow.textOnlyTurnStreak), revision: result.state.revision }
        }
    })

    it("offers the mistake-limit recovery when the bound is reached, so the task does not stop silently", () => {
        const result = accepted(transition(awaitingProvider(LAST_CONTINUED_STREAK), turnReady([])))

        expect(result.state.flow.phase).toBe("waiting")
        expect(result.state.dialog.primary).toMatchObject({
            kind: "mistake_limit",
            status: "planned",
            turnId: "turn-1",
            actionRules: [
                { actionId: "process_anyway", payloadPolicy: "draft" },
                { actionId: "start_new_task", payloadPolicy: "draft" },
            ],
        })
        expect(result.commands).toEqual([
            expect.objectContaining({
                type: "dialog.prepare",
                kind: "mistake_limit",
                interactionId: result.state.dialog.primary?.interactionId,
            }),
        ])
    })

    it("does not offer the recovery while a question already awaits the user", () => {
        const waiting: TaskState = {
            ...awaitingProvider(LAST_CONTINUED_STREAK),
            dialog: {
                approvalsByBlock: {},
                primary: {
                    interactionId: "ask-1",
                    turnId: "turn-1",
                    kind: "followup",
                    status: "awaiting",
                    createdRevision: 3,
                    presentationRef: "presentation:ask-1",
                    actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
                },
            },
        }
        const result = accepted(transition(waiting, turnReady([])))
        expect(result.state.dialog.primary?.interactionId).toBe("ask-1")
        expect(result.commands).toEqual([])
    })

    it("lets Process Anyway continue: the answer is a submission, which resets the streak and opens a round", () => {
        const limited = accepted(transition(awaitingProvider(LAST_CONTINUED_STREAK), turnReady([])))
        const submitted = accepted(
            transition(limited.state, { type: "user.submit", generation: 0, entryId: "entry-1", payloadRef: "input:1" }),
        )
        expect(submitted.state.flow.textOnlyTurnStreak).toBe(0)
        expect(submitted.state.flow.plainTextWarningCount).toBe(0)
        expect(submitted.state.flow.plainTextWarningMistakes).toBe(0)
        expect(submitted.state.flow.toolMistakeCount).toBe(0)
        expect(submitted.state.flow.consecutiveMistakeCount).toBe(0)
        expect(composeRounds(submitted.commands)).toEqual([
            expect.objectContaining({ type: "compose.round", admittedEntryIds: ["entry-1"] }),
        ])
    })

    it("stays silent while a question is awaiting the user, whose turn it is to speak", () => {
        const waiting: TaskState = {
            ...awaitingProvider(),
            dialog: {
                approvalsByBlock: {},
                primary: {
                    interactionId: "ask-1",
                    turnId: "turn-1",
                    kind: "followup",
                    status: "awaiting",
                    createdRevision: 3,
                    presentationRef: "presentation:ask-1",
                    actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
                },
            },
        }
        expect(composeRounds(accepted(transition(waiting, turnReady([]))).commands)).toEqual([])
    })

    it("resets the streak when the user submits, since the reason for the bound is gone", () => {
        const continued = accepted(transition(awaitingProvider(3), turnReady([])))
        expect(continued.state.flow.textOnlyTurnStreak).toBe(4)
        const submitted = accepted(
            transition(continued.state, { type: "user.submit", generation: 0, entryId: "entry-1", payloadRef: "input:1" }),
        )
        expect(submitted.state.flow.textOnlyTurnStreak).toBe(0)
    })

    it("carries an entry that arrived mid-turn into the round it opens", () => {
        // A submission during a live round is accepted but cannot open one, so the
        // round opened when that round ends is its only way to reach a request.
        const waiting: TaskState = {
            ...awaitingProvider(),
            intake: {
                queued: [
                    { entryId: "entry-2", payloadRef: "input:2", source: "user", mode: "queued", sequence: 1, state: "accepted" },
                ],
                background: [],
                coTask: [],
            },
        }
        expect(composeRounds(accepted(transition(waiting, turnReady([]))).commands)).toEqual([
            expect.objectContaining({ type: "compose.round", admittedEntryIds: ["entry-2"] }),
        ])
    })

    it("carries a result released by compaction mid-round into the next round without user action", () => {
        // Compaction lands while a round is composing and releases a held subagent result as a
        // background arrival. That round's admissions are already fixed, so the result has to
        // ride on the round the kernel opens next, with no user message.
        const released = accepted(
            transition(awaitingProvider(), {
                type: "background.ready",
                generation: 0,
                entryId: "background:subagent-deferred:tid-1:attempt:1",
                payloadRef: "result:held",
            }),
        )
        expect(composeRounds(released.commands)).toEqual([])

        expect(composeRounds(accepted(transition(released.state, turnReady([]))).commands)).toEqual([
            expect.objectContaining({
                type: "compose.round",
                admittedEntryIds: ["background:subagent-deferred:tid-1:attempt:1"],
            }),
        ])
    })

    it("carries a waiting entry even after the text-only budget is spent, because the user spoke", () => {
        const waiting: TaskState = {
            ...awaitingProvider(MAX_TEXT_ONLY_STREAK),
            intake: {
                queued: [
                    { entryId: "entry-2", payloadRef: "input:2", source: "user", mode: "queued", sequence: 1, state: "accepted" },
                ],
                background: [],
                coTask: [],
            },
        }
        const result = accepted(transition(waiting, turnReady([])))
        // The budget alone would have stopped here; the waiting entry is a new
        // request from the user, so it is not what the budget was meant to bound.
        expect(composeRounds(accepted(transition(awaitingProvider(MAX_TEXT_ONLY_STREAK), turnReady([]))).commands)).toEqual([])
        expect(composeRounds(result.commands)).toEqual([
            expect.objectContaining({ type: "compose.round", admittedEntryIds: ["entry-2"] }),
        ])
    })

    it("reserves the entry it admitted, so the next round cannot admit it twice", () => {
        const waiting: TaskState = {
            ...awaitingProvider(),
            intake: {
                queued: [
                    { entryId: "entry-2", payloadRef: "input:2", source: "user", mode: "queued", sequence: 1, state: "accepted" },
                ],
                background: [],
                coTask: [],
            },
        }
        expect(accepted(transition(waiting, turnReady([]))).state.intake.queued[0].state).toBe("reserved")
    })
})

/** The streak value at which the kernel stops continuing on its own. */
const MAX_TEXT_ONLY_STREAK = 4

/** The streak before the answer that reaches the bound; the next text-only answer stops the run. */
const LAST_CONTINUED_STREAK = 2
