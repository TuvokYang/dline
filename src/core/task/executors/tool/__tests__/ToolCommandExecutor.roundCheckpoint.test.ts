import { describe, expect, it, vi } from "vitest"
import type { Command, ToolRunCommand } from "../../../kernel"
import type { HaltOrder } from "../../contracts"
import { ToolCommandExecutor, type ToolRoundCheckpointPort } from "../ToolCommandExecutor"
import { createDeniedSurface } from "../ToolDomainSurface"
import type { ToolRunCommand as DomainToolRunCommand, ToolDomainRunner } from "../ToolExecutionDomain"
import { TurnToolScheduler } from "../TurnToolScheduler"

function run(turnId: string, blockId: string): ToolRunCommand {
    return {
        commandId: `command-${blockId}`,
        originRevision: 1,
        generation: 0,
        type: "tool.run",
        turnId,
        mode: "parallel",
        blocks: [
            { blockId, attempt: `${blockId}-a`, invocationRef: `invocation:${blockId}`, index: 0, lanes: [], turnEnding: false },
        ],
    }
}

function retire(turnId: string): Command {
    return { type: "tool.retire", turnId } as unknown as Command
}

function harness(roundCheckpoint: ToolRoundCheckpointPort, order: string[] = []) {
    const runner: ToolDomainRunner = {
        runBlock: vi.fn(async (input: DomainToolRunCommand) => {
            order.push(`run:${input.dlineTid}`)
        }),
        release: vi.fn(async () => undefined),
    }
    const executor = new ToolCommandExecutor(
        {
            runner,
            surface: createDeniedSurface("detached_domain"),
            scheduler: new TurnToolScheduler({ readConfiguredLimit: () => 8 }),
            roundCheckpoint,
        },
        { submit: async () => ({ kind: "accepted" as const }) },
    )
    return { executor, order, runner }
}

describe("ToolCommandExecutor round checkpoint", () => {
    it("settles the round's restore point when the round retires", async () => {
        const settle = vi.fn(async () => {})
        const { executor } = harness({ settle })

        await executor.execute(run("turn-1", "b1"))
        settle.mockClear()
        await executor.execute(retire("turn-1"))

        await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
    })

    it("settles the previous round before a new round's first tool runs", async () => {
        const order: string[] = []
        let release!: () => void
        const pending = new Promise<void>((resolve) => (release = resolve))
        let calls = 0
        const settle = vi.fn(async () => {
            calls += 1
            // The first call opens turn-1; the second, for turn-2, is held open.
            if (calls === 2) {
                await pending
                order.push("settled")
            }
        })
        const { executor, runner } = harness({ settle }, order)

        await executor.execute(run("turn-1", "b1"))
        const next = executor.execute(run("turn-2", "b2"))
        await Promise.resolve()
        expect(runner.runBlock).toHaveBeenCalledTimes(1)
        release()
        await next

        // A missed retirement must not let the next round's effects leak into the
        // restore point the previous round owed.
        expect(order).toEqual(["run:b1", "settled", "run:b2"])
    })

    it("does not settle again for further blocks of the same round", async () => {
        const settle = vi.fn(async () => {})
        const { executor } = harness({ settle })

        await executor.execute(run("turn-1", "b1"))
        await executor.execute(run("turn-1", "b2"))

        expect(settle).toHaveBeenCalledOnce()
    })

    it("settles what a halted round owes before the halt completes", async () => {
        const settle = vi.fn(async () => {})
        const { executor } = harness({ settle })
        const order = { haltId: "halt-1", reason: "cancel" } as unknown as HaltOrder

        executor.fence(order)
        await executor.drain(order)

        expect(settle).toHaveBeenCalledOnce()
    })

    it("keeps running tools when the restore point cannot be committed", async () => {
        const settle = vi.fn(async () => Promise.reject(new Error("shadow git unavailable")))
        const { executor, runner } = harness({ settle })

        await expect(executor.execute(run("turn-1", "b1"))).resolves.toBeUndefined()
        await expect(executor.execute(retire("turn-1"))).resolves.toBeUndefined()

        expect(runner.runBlock).toHaveBeenCalledOnce()
    })
})
