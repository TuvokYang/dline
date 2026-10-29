import { describe, expect, it } from "vitest"
import { mistakeLimitPresentation } from "../mistake-limit-presentation"
import { transition } from "../transition"
import type {
    ComposeRoundCommand,
    KernelBlock,
    MistakeLimitReason,
    ProviderTurnBlockPlan,
    ProviderTurnPlan,
    TaskEvent,
    TaskState,
    TransitionResult,
} from "../types"
import { createInitialTaskState } from "../types"

type Accepted = Extract<TransitionResult, { kind: "accepted" }>

/** The mixed-turn warning kind an earlier build wrote into durable turn plans. */
const LEGACY_MIXED_WARNING = "plain_text_outside_tool" as unknown as ProviderTurnPlan["plainTextWarning"]

function accepted(result: TransitionResult): Accepted {
    expect(result.kind).toBe("accepted")
    if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
    return result
}

function plannedBlock(blockId: string, index = 0): ProviderTurnBlockPlan {
    return {
        blockId,
        attempt: `attempt-${blockId}`,
        index,
        lanes: [],
        turnEnding: false,
        invocationRef: `invocation:${blockId}`,
        approval: { kind: "none" },
    }
}

/** A live provider command two effective mistakes into the default limit of three. */
function liveProvider(flow: Partial<TaskState["flow"]> = {}): TaskState {
    return {
        ...createInitialTaskState("task-1"),
        revision: 4,
        flow: {
            phase: "running",
            provider: { commandId: "provider:1", originRevision: 4, status: "running", turnId: "turn-1" },
            plainTextWarningCount: 0,
            plainTextWarningMistakes: 0,
            toolMistakeCount: 2,
            consecutiveMistakeCount: 2,
            ...flow,
        },
    }
}

/** A live provider command whose next plain-text warning promotes the mistake that reaches the limit. */
function oneWarningShortOfLimit(flow: Partial<TaskState["flow"]> = {}): TaskState {
    return liveProvider({ plainTextWarningCount: 4, plainTextWarningMistakes: 2, toolMistakeCount: 0, ...flow })
}

function turnReady(
    state: TaskState,
    blocks: readonly ProviderTurnBlockPlan[],
    plainTextWarning?: ProviderTurnPlan["plainTextWarning"],
): TaskEvent {
    const provider = state.flow.provider
    if (!provider) throw new Error("expected a live provider command")
    return {
        type: "provider.turn_ready",
        generation: state.generation,
        commandId: provider.commandId,
        originRevision: provider.originRevision,
        turnId: provider.turnId ?? "turn-1",
        finalPayloadRef: `final:${state.revision}`,
        journalWatermark: { seq: state.revision + 1 },
        turnPlan: {
            mode: blocks.length > 1 ? "parallel" : "serial",
            blocks,
            ...(plainTextWarning === undefined ? {} : { plainTextWarning }),
        },
    }
}

function toolEvent(
    state: TaskState,
    type: "tool.started" | "tool.completed" | "tool.failed" | "tool.cancelled",
    blockId: string,
    outcome: { readonly successful?: boolean; readonly mistakeCount?: number } = {},
): TaskEvent {
    return {
        type,
        generation: state.generation,
        turnId: state.turn.turnId ?? "turn-1",
        blockId,
        attempt: `attempt-${blockId}`,
        ...(type === "tool.started" ? {} : { mistakeCount: 0, mistakeLimit: 3, ...outcome }),
    } as TaskEvent
}

/** Plan a turn with calls and start every call it planned. */
function runningTurn(
    state: TaskState,
    blockIds: readonly string[] = ["b1"],
    plainTextWarning?: ProviderTurnPlan["plainTextWarning"],
): Accepted {
    let result = accepted(
        transition(
            state,
            turnReady(
                state,
                blockIds.map((blockId, index) => plannedBlock(blockId, index)),
                plainTextWarning,
            ),
        ),
    )
    for (const blockId of blockIds) result = accepted(transition(result.state, toolEvent(result.state, "tool.started", blockId)))
    return result
}

function expectRecoveryPrepared(result: Accepted, reason: MistakeLimitReason): void {
    expect(result.state.flow.phase).toBe("waiting")
    expect(result.state.dialog.primary).toMatchObject({
        kind: "mistake_limit",
        status: "planned",
        presentationRef: mistakeLimitPresentation(reason),
    })
    expect(result.commands).toEqual([
        expect.objectContaining({
            type: "dialog.prepare",
            kind: "mistake_limit",
            interactionId: result.state.dialog.primary?.interactionId,
        }),
    ])
}

function composeOf(result: Accepted): ComposeRoundCommand {
    const compose = result.commands.find((command): command is ComposeRoundCommand => command.type === "compose.round")
    if (!compose) throw new Error("expected compose.round")
    return compose
}

describe("prose written beside tool calls", () => {
    it("runs the calls without counting a warning, even under a mixed warning an earlier build recorded", () => {
        const state = oneWarningShortOfLimit()
        const planned = accepted(transition(state, turnReady(state, [plannedBlock("b1")], LEGACY_MIXED_WARNING)))

        expect(planned.state.dialog.primary).toBeUndefined()
        expect(planned.state.flow.plainTextWarningCount).toBe(4)
        expect(planned.state.flow.consecutiveMistakeCount).toBe(2)
        expect(planned.commands.map((command) => command.type)).toEqual(["tool.run"])
    })

    it("continues after the calls settle without sending the model a warning", () => {
        const running = runningTurn(oneWarningShortOfLimit(), ["b1"], LEGACY_MIXED_WARNING)
        const settled = accepted(
            transition(running.state, toolEvent(running.state, "tool.completed", "b1", { successful: true })),
        )

        expect(settled.state.dialog.primary).toBeUndefined()
        expect(settled.state.flow.consecutiveMistakeCount).toBe(0)
        expect(composeOf(settled).continuation).toBeUndefined()
    })
})

describe("a mistake limit reached while a turn still has calls to run", () => {
    it.each([
        ["a failed result", "tool.completed", { successful: false, mistakeCount: 3 }],
        ["a failed execution", "tool.failed", { mistakeCount: 3 }],
    ] as const)("hands the task back once its call settles with %s", (_label, type, outcome) => {
        const running = runningTurn(liveProvider())
        const settled = accepted(transition(running.state, toolEvent(running.state, type, "b1", outcome)))

        expectRecoveryPrepared(settled, "tool_mistakes")
    })

    it("waits for the last of several parallel calls before handing the task back", () => {
        const running = runningTurn(liveProvider(), ["b1", "b2"])
        const first = accepted(transition(running.state, toolEvent(running.state, "tool.failed", "b1", { mistakeCount: 3 })))
        expect(first.state.dialog.primary).toBeUndefined()
        expect(first.commands.some((command) => command.type === "dialog.prepare" || command.type === "compose.round")).toBe(
            false,
        )

        const last = accepted(transition(first.state, toolEvent(first.state, "tool.failed", "b2", { mistakeCount: 4 })))
        expectRecoveryPrepared(last, "tool_mistakes")
    })

    it("names rule violations when promoted plain-text warnings helped reach the limit", () => {
        const running = runningTurn(liveProvider({ plainTextWarningMistakes: 2, toolMistakeCount: 0 }))
        const settled = accepted(transition(running.state, toolEvent(running.state, "tool.failed", "b1", { mistakeCount: 1 })))

        expectRecoveryPrepared(settled, "rule_violations")
    })

    it("hands the task back when the user refuses the turn's last open call", () => {
        const awaiting: KernelBlock = {
            blockId: "b1",
            index: 0,
            phase: "awaiting_approval",
            attempt: "attempt-b1",
            invocationRef: "invocation:b1",
            lanes: [],
            turnEnding: false,
        }
        const state: TaskState = {
            ...createInitialTaskState("task-1"),
            flow: { phase: "running", consecutiveMistakeCount: 3, plainTextWarningMistakes: 0, toolMistakeCount: 3 },
            turn: {
                turnId: "turn-1",
                mode: "serial",
                blocks: [awaiting],
                manualApprovalBlockIds: ["b1"],
                automaticApprovalBlockIds: [],
                executingBlockIds: [],
            },
            dialog: {
                approvalsByBlock: {
                    b1: {
                        interactionId: "approval:b1",
                        turnId: "turn-1",
                        kind: "tool_approval",
                        status: "resolving",
                        createdRevision: 0,
                        presentationRef: "approval:b1",
                        actionRules: [
                            { actionId: "approve", payloadPolicy: "draft" },
                            { actionId: "reject", payloadPolicy: "draft" },
                        ],
                        acceptedResponse: { actionId: "reject", stateRevision: 0, receiverGeneration: 0 },
                        blockId: "b1",
                        receiverGeneration: 0,
                    },
                },
            },
        }
        const refused = accepted(
            transition(state, {
                type: "approval.responded",
                generation: 0,
                turnId: "turn-1",
                blockId: "b1",
                interactionId: "approval:b1",
                approved: false,
            } as TaskEvent),
        )

        expectRecoveryPrepared(refused, "tool_mistakes")
    })

    it("leaves a question the turn already handed to the user in place", () => {
        const running = runningTurn(liveProvider())
        const asking: TaskState = {
            ...running.state,
            dialog: {
                ...running.state.dialog,
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
        const settled = accepted(transition(asking, toolEvent(asking, "tool.failed", "b1", { mistakeCount: 3 })))

        expect(settled.state.dialog.primary?.interactionId).toBe("ask-1")
        expect(settled.commands.some((command) => command.type === "dialog.prepare")).toBe(false)
    })

    it("lets Process Anyway clear the limit and report the settled calls", () => {
        const running = runningTurn(liveProvider())
        const limited = accepted(transition(running.state, toolEvent(running.state, "tool.failed", "b1", { mistakeCount: 3 })))
        const submitted = accepted(
            transition(limited.state, { type: "user.submit", generation: 0, entryId: "entry-1", payloadRef: "input:1" }),
        )

        expect(submitted.state.flow.consecutiveMistakeCount).toBe(0)
        expect(composeOf(submitted).toolTerminals?.turnId).toBe("turn-1")
    })
})

describe("mistake-limit recovery reached without calls", () => {
    it("explains a plain-text limit as repeated rule violations", () => {
        const state = oneWarningShortOfLimit()
        expectRecoveryPrepared(accepted(transition(state, turnReady(state, [], "text_only"))), "rule_violations")
    })

    it("explains the strict streak of responses without any usable call", () => {
        const state = liveProvider({ toolMistakeCount: 0, consecutiveMistakeCount: 0, textOnlyTurnStreak: 2 })
        expectRecoveryPrepared(accepted(transition(state, turnReady(state, []))), "no_tool_turns")
    })

    it("keeps a tool mistake count restored from a snapshot written before the counts were split", () => {
        const restored = liveProvider({
            plainTextWarningCount: undefined,
            plainTextWarningMistakes: undefined,
            toolMistakeCount: undefined,
            consecutiveMistakeCount: 2,
        })
        const planned = accepted(transition(restored, turnReady(restored, [plannedBlock("b1")])))

        expect(planned.state.flow.consecutiveMistakeCount).toBe(2)
        expect(planned.state.flow.toolMistakeCount).toBe(2)
    })
})
