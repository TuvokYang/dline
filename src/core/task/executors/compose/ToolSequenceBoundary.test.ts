import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import type { ToolTerminalManifestEntry } from "../../kernel"
import { DefaultToolHandlerState } from "../../tools/state/ToolHandlerState"
import type { ComposePort, ComposeRoundInput } from "./ComposeCommandExecutor"
import { roundInterruptsToolSequence, ToolSequenceBoundaryCompose } from "./ToolSequenceBoundary"

const signal = new AbortController().signal

function round(overrides: Partial<ComposeRoundInput> = {}): ComposeRoundInput {
    return { turnId: "turn-next", admittedEntryIds: [], signal, ...overrides }
}

function terminals(...phases: ToolTerminalManifestEntry["phase"][]): ComposeRoundInput["toolTerminals"] {
    return {
        turnId: "turn-previous",
        blocks: phases.map((phase, index) => ({ blockId: `b${index}`, phase, invocationRef: `invocation-${index}` })),
    }
}

function innerPort(): Required<ComposePort> {
    return {
        compose: vi.fn(async () => ({ draftRef: "draft-1" })),
        preparePresentation: vi.fn(async () => undefined),
        rollbackRetainedQueue: vi.fn(async () => "released" as const),
    }
}

/** A tool state that just ran working_respond, so its guard would refuse another one. */
function stateAfterWorkingRespond(): DefaultToolHandlerState {
    const state = new DefaultToolHandlerState()
    state.lastToolName = DlineDefaultTool.WORKING_RESPOND
    state.lastToolParams = '{"response":"Reading the config next."}'
    state.consecutiveIdenticalToolCount = 2
    return state
}

describe("roundInterruptsToolSequence", () => {
    it.each([
        ["user input admitted to the round", round({ admittedEntryIds: ["entry-1"] })],
        [
            "a queued message delivered at a tool round",
            round({ queueDelivery: { deliveryId: "d1", point: "tool_round", ownerId: "owner", generation: 1 } }),
        ],
        ["a queued reply to a dialog", round({ respondedQueue: { deliveryId: "d2", mode: "queued", entries: [] } })],
        ["a refused call", round({ toolTerminals: terminals("completed", "rejected") })],
        ["a failed call", round({ toolTerminals: terminals("failed") })],
        ["a cancelled call", round({ toolTerminals: terminals("cancelled") })],
        ["a skipped call", round({ toolTerminals: terminals("completed", "skipped") })],
    ])("interrupts for %s", (_name, input) => {
        expect(roundInterruptsToolSequence(input)).toBe(true)
    })

    it.each([
        ["only completed tool results", round({ toolTerminals: terminals("completed", "completed") })],
        ["a toolless continuation", round({ continuation: "no_tool_use" as never })],
        ["an empty round", round()],
    ])("keeps the sequence for %s", (_name, input) => {
        expect(roundInterruptsToolSequence(input)).toBe(false)
    })
})

describe("ToolSequenceBoundaryCompose", () => {
    it("clears the previous call before composing a round that carries user input", async () => {
        const state = stateAfterWorkingRespond()
        const inner = innerPort()
        let lastToolNameSeenByCompose: string | undefined
        vi.mocked(inner.compose).mockImplementation(async () => {
            lastToolNameSeenByCompose = state.lastToolName
            return { draftRef: "draft-1" }
        })
        const port = new ToolSequenceBoundaryCompose(inner, { interrupt: () => state.interruptToolSequence() })

        await expect(port.compose(round({ admittedEntryIds: ["entry-1"] }))).resolves.toEqual({ draftRef: "draft-1" })

        expect(lastToolNameSeenByCompose).toBe("")
        expect(state.lastToolName).toBe("")
        expect(state.lastToolParams).toBe("")
        expect(state.consecutiveIdenticalToolCount).toBe(0)
    })

    it("clears the previous call when the user refused a call in the previous round", async () => {
        const state = stateAfterWorkingRespond()
        const port = new ToolSequenceBoundaryCompose(innerPort(), { interrupt: () => state.interruptToolSequence() })

        await port.compose(round({ toolTerminals: terminals("rejected") }))

        expect(state.lastToolName).toBe("")
    })

    it("keeps the previous call when the round only returns completed tool results", async () => {
        const state = stateAfterWorkingRespond()
        const port = new ToolSequenceBoundaryCompose(innerPort(), { interrupt: () => state.interruptToolSequence() })

        await port.compose(round({ toolTerminals: terminals("completed") }))

        expect(state.lastToolName).toBe(DlineDefaultTool.WORKING_RESPOND)
        expect(state.consecutiveIdenticalToolCount).toBe(2)
    })

    it("delegates presentation and queue rollback without touching the sequence", async () => {
        const inner = innerPort()
        const interrupt = vi.fn()
        const port = new ToolSequenceBoundaryCompose(inner, { interrupt })
        const input = round({ admittedEntryIds: ["entry-1"] })

        await port.preparePresentation(input)
        await expect(port.rollbackRetainedQueue(input)).resolves.toBe("released")

        expect(inner.preparePresentation).toHaveBeenCalledWith(input)
        expect(inner.rollbackRetainedQueue).toHaveBeenCalledWith(input)
        expect(interrupt).not.toHaveBeenCalled()
    })
})
