import type { ToolUse } from "@core/assistant-message"
import type { UiMessage } from "@shared/ExtensionMessage"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import type { IToolHandler } from "../ToolExecutorCoordinator"
import { presentToolDenial } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"

const CARD_TS = 1_700_000_000_000

function refusedCall(): ToolUse {
    return { type: "tool_use", name: DlineDefaultTool.FILE_NEW, params: {}, partial: false, ts: CARD_TS } as ToolUse
}

function card(partial: boolean): UiMessage {
    return { ts: CARD_TS, type: "say", say: "tool", text: "{}", partial } as UiMessage
}

function harness(rows: UiMessage[]) {
    const removeMessagesByTs = vi.fn(async (_ts: readonly number[]) => {})
    const config = { messageState: { clineMessages: rows, removeMessagesByTs } } as unknown as TaskConfig
    return { config, removeMessagesByTs }
}

const plainHandler: IToolHandler = {
    name: DlineDefaultTool.FILE_NEW,
    getDescription: () => "[write_to_file]",
    execute: async () => "done",
}

describe("presentToolDenial", () => {
    // The generic denial row reports the refusal, and the call never runs, so
    // nothing else would ever settle the card the stream drew.
    it("withdraws the card a refused call left streaming", async () => {
        const { config, removeMessagesByTs } = harness([card(true)])

        await presentToolDenial(plainHandler, config, refusedCall())

        expect(removeMessagesByTs).toHaveBeenCalledWith([CARD_TS])
    })

    it("keeps a card that is already settled", async () => {
        const { config, removeMessagesByTs } = harness([card(false)])

        await presentToolDenial(plainHandler, config, refusedCall())

        expect(removeMessagesByTs).not.toHaveBeenCalled()
    })

    it("does nothing when the call drew no card", async () => {
        const { config, removeMessagesByTs } = harness([])

        await presentToolDenial(undefined, config, refusedCall())

        expect(removeMessagesByTs).not.toHaveBeenCalled()
    })

    // A handler with its own refusal presentation moves its row to a terminal
    // state; withdrawing the row as well would erase what it just drew.
    it("leaves the row to a handler that presents its own refusal", async () => {
        const { config, removeMessagesByTs } = harness([card(true)])
        const presentDenial = vi.fn(async () => {})

        await presentToolDenial({ ...plainHandler, presentDenial } as IToolHandler, config, refusedCall())

        expect(presentDenial).toHaveBeenCalledOnce()
        expect(removeMessagesByTs).not.toHaveBeenCalled()
    })
})
