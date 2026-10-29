import { describe, expect, it, vi } from "vitest"
import type { Command, TaskEvent, ToolRunCommand } from "../../../kernel"
import { CommandRouter } from "../../../runtime/CommandRouter"
import { DurableCommandOutbox } from "../../../runtime/DurableCommandOutbox"
import type { CommandPublicationStore } from "../../../stores/contracts"
import { ToolCommandExecutor } from "../ToolCommandExecutor"
import { createDeniedSurface } from "../ToolDomainSurface"
import type { ToolRunCommand as DomainToolRunCommand, ToolDomainRunner, ToolDomainRunResult } from "../ToolExecutionDomain"
import { TurnToolScheduler } from "../TurnToolScheduler"

function command(): ToolRunCommand {
    return {
        commandId: "tool-command-1",
        originRevision: 1,
        generation: 0,
        type: "tool.run",
        turnId: "turn-1",
        mode: "parallel",
        blocks: [
            { blockId: "b1", attempt: "a1", invocationRef: "invocation:b1", index: 0, lanes: ["fs"], turnEnding: false },
            { blockId: "b2", attempt: "a2", invocationRef: "invocation:b2", index: 1, lanes: ["net"], turnEnding: false },
        ],
    }
}

function harness(limit = 32) {
    const settlers = new Map<string, { resolve(result?: ToolDomainRunResult): void; reject(error: Error): void }>()
    const runner: ToolDomainRunner = {
        runBlock: vi.fn(
            (input: DomainToolRunCommand) =>
                new Promise<ToolDomainRunResult | undefined>((resolve, reject) =>
                    settlers.set(input.dlineTid, { resolve, reject }),
                ),
        ),
        release: vi.fn(async () => undefined),
    }
    const events: TaskEvent[] = []
    const scheduler = new TurnToolScheduler({ readConfiguredLimit: () => limit })
    const operationCancellation = { cancel: vi.fn(), reset: vi.fn() }
    const executor = new ToolCommandExecutor(
        { runner, surface: createDeniedSurface("detached_domain"), scheduler, operationCancellation },
        {
            submit: async (event) => {
                events.push(event)
                return { kind: "accepted" as const }
            },
        },
    )
    return { executor, runner, settlers, events, scheduler, operationCancellation }
}

function startedBlocks(events: TaskEvent[]): string[] {
    return events.flatMap((event) => (event.type === "tool.started" ? [event.blockId] : []))
}

function cancelledBlocks(events: TaskEvent[]): string[] {
    return events.flatMap((event) => (event.type === "tool.cancelled" ? [event.blockId] : []))
}

function publications(): CommandPublicationStore {
    const marked = new Set<string>()
    return {
        has: async (effectKey) => marked.has(effectKey),
        mark: async (_command: Command, effectKey) => {
            if (effectKey) marked.add(effectKey)
        },
    }
}

describe("ToolCommandExecutor", () => {
    it("reuses the tool domain while preserving per-block identity under out-of-order completion", async () => {
        const { executor, runner, settlers, events } = harness()
        const completion = executor.execute(command())
        await vi.waitFor(() => expect(runner.runBlock).toHaveBeenCalledTimes(2))
        settlers.get("b2")?.resolve()
        await vi.waitFor(() =>
            expect(events.some((event) => event.type === "tool.completed" && event.blockId === "b2")).toBe(true),
        )
        settlers.get("b1")?.resolve()
        await completion

        type KernelToolEvent = Extract<TaskEvent, { type: "tool.started" | "tool.completed" | "tool.failed" | "tool.cancelled" }>
        const toolEvents = events.filter((event): event is KernelToolEvent => event.type.startsWith("tool."))
        expect(toolEvents.filter((event) => event.type === "tool.started").map((event) => event.blockId)).toEqual(["b1", "b2"])
        expect(toolEvents.filter((event) => event.type === "tool.completed").map((event) => event.blockId)).toEqual(["b2", "b1"])
        expect(runner.runBlock).toHaveBeenCalledWith(
            expect.objectContaining({ dlineTid: "b1", invocationRef: "invocation:b1", mode: "parallel" }),
        )
    })

    it("projects a model-facing failed result as completed but not successful", async () => {
        const { executor, runner, settlers, events } = harness()
        const execution = executor.execute({ ...command(), blocks: [command().blocks[0]] })
        await vi.waitFor(() => expect(runner.runBlock).toHaveBeenCalledOnce())

        settlers.get("b1")?.resolve({ failed: true })
        await execution

        expect(events).toContainEqual(expect.objectContaining({ type: "tool.completed", blockId: "b1", successful: false }))
    })

    it("retires only the named turn and releases its terminal scheduling state", async () => {
        const scheduler = new TurnToolScheduler({ readConfiguredLimit: () => 4 })
        await scheduler.schedule({
            turnId: "turn-1",
            mode: "parallel",
            block: { blockId: "ending", attempt: "a1", invocationRef: "ending", index: 0, lanes: [], turnEnding: true },
            run: async () => undefined,
        })

        scheduler.retireTurn("turn-stale")
        const skippedRun = vi.fn(async () => undefined)
        const skipped = await scheduler.schedule({
            turnId: "turn-1",
            mode: "parallel",
            block: { blockId: "stale", attempt: "a2", invocationRef: "stale", index: 1, lanes: [], turnEnding: false },
            run: skippedRun,
        })
        expect(skipped.skipped).toBe(true)
        expect(skippedRun).not.toHaveBeenCalled()

        scheduler.retireTurn("turn-1")
        const freshRun = vi.fn(async () => undefined)
        await scheduler.schedule({
            turnId: "turn-1",
            mode: "parallel",
            block: { blockId: "fresh", attempt: "a3", invocationRef: "fresh", index: 1, lanes: [], turnEnding: false },
            run: freshRun,
        })
        expect(freshRun).toHaveBeenCalledOnce()
    })

    it("keeps the halt fence until explicit rearm and converts pre-halt work to cancellation", async () => {
        const { executor, runner, settlers, events, operationCancellation } = harness()
        const execution = executor.execute({ ...command(), blocks: [command().blocks[0]] })
        await vi.waitFor(() => expect(runner.runBlock).toHaveBeenCalledTimes(1))
        const order = { haltId: "halt-1", generation: 0, reason: "cancel" as const }
        executor.fence(order)
        const stopping = executor.stop(order)
        settlers.get("b1")?.resolve()
        await stopping
        await executor.drain(order)
        await execution

        expect(events.some((event) => event.type === "tool.cancelled" && event.blockId === "b1")).toBe(true)
        expect(events.some((event) => event.type === "tool.completed" && event.blockId === "b1")).toBe(false)
        expect(runner.release).toHaveBeenCalledTimes(1)
        expect(operationCancellation.cancel).toHaveBeenCalledWith("cancel")
        executor.rearm("halt-older")
        expect(operationCancellation.reset).not.toHaveBeenCalled()
        await executor.execute({ ...command(), commandId: "fenced", blocks: [] })
        executor.rearm("halt-1")
        expect(operationCancellation.reset).toHaveBeenCalledOnce()
    })

    it("holds parallel blocks behind the configured ceiling and starts them only as slots free", async () => {
        const { executor, runner, settlers, events } = harness(1)
        const completion = executor.execute(command())
        await vi.waitFor(() => expect(runner.runBlock).toHaveBeenCalledTimes(1))
        expect(startedBlocks(events)).toEqual(["b1"])

        settlers.get("b1")?.resolve()
        await vi.waitFor(() => expect(runner.runBlock).toHaveBeenCalledTimes(2))
        expect(startedBlocks(events)).toEqual(["b1", "b2"])
        settlers.get("b2")?.resolve()
        await completion
    })

    it("never overlaps two blocks that need the same lane", async () => {
        const { executor, runner, settlers } = harness()
        const base = command()
        const completion = executor.execute({
            ...base,
            blocks: [
                { ...base.blocks[0], lanes: ["diff-editor"] },
                { ...base.blocks[1], lanes: ["diff-editor"] },
            ],
        })
        await vi.waitFor(() => expect(runner.runBlock).toHaveBeenCalledTimes(1))
        await new Promise((resolve) => setTimeout(resolve, 5))
        expect(runner.runBlock).toHaveBeenCalledTimes(1)

        settlers.get("b1")?.resolve()
        await vi.waitFor(() => expect(runner.runBlock).toHaveBeenCalledTimes(2))
        settlers.get("b2")?.resolve()
        await completion
    })

    it("keeps a turn-ending block waiting for an earlier sibling released by a later command", async () => {
        const { executor, runner, settlers, events } = harness()
        const base = command()
        const ending = executor.execute({
            ...base,
            commandId: "ready-first",
            blocks: [{ blockId: "done", attempt: "a3", invocationRef: "invocation:done", index: 1, lanes: [], turnEnding: true }],
        })
        await new Promise((resolve) => setTimeout(resolve, 5))
        // Index 0 has not been released yet, so the turn-ending block must not start.
        expect(runner.runBlock).not.toHaveBeenCalled()

        const approved = executor.execute({ ...base, commandId: "approved-later", blocks: [base.blocks[0]] })
        await vi.waitFor(() => expect(runner.runBlock).toHaveBeenCalledTimes(1))
        expect(startedBlocks(events)).toEqual(["b1"])

        settlers.get("b1")?.resolve()
        await approved
        await vi.waitFor(() => expect(startedBlocks(events)).toEqual(["b1", "done"]))
        settlers.get("done")?.resolve()
        await ending
    })

    it("admits an approved sibling through the outbox while a turn-ending sibling is waiting", async () => {
        const { executor, runner, settlers, events } = harness()
        const base = command()
        const router = new CommandRouter([executor])
        const outbox = new DurableCommandOutbox(router, publications())
        const ending: ToolRunCommand = {
            ...base,
            commandId: "ready-first",
            originRevision: 4,
            blocks: [{ blockId: "done", attempt: "a3", invocationRef: "invocation:done", index: 1, lanes: [], turnEnding: true }],
        }
        const approved: ToolRunCommand = { ...base, commandId: "approved-later", originRevision: 5, blocks: [base.blocks[0]] }

        outbox.enqueue([ending], { revision: 4, durable: Promise.resolve() })
        await new Promise((resolve) => setTimeout(resolve, 5))
        expect(runner.runBlock).not.toHaveBeenCalled()

        outbox.enqueue([approved], { revision: 5, durable: Promise.resolve() })
        await vi.waitFor(() => expect(startedBlocks(events)).toEqual(["b1"]))
        settlers.get("b1")?.resolve()
        await vi.waitFor(() => expect(startedBlocks(events)).toEqual(["b1", "done"]))
        settlers.get("done")?.resolve()
        await outbox.whenIdle()
    })

    it("reports a queued block as cancelled without starting it when the turn is fenced", async () => {
        const { executor, runner, settlers, events } = harness(1)
        const completion = executor.execute(command())
        await vi.waitFor(() => expect(runner.runBlock).toHaveBeenCalledTimes(1))

        const order = { haltId: "halt-2", generation: 0, reason: "cancel" as const }
        executor.fence(order)
        const stopping = executor.stop(order)
        settlers.get("b1")?.resolve()
        await stopping
        await executor.drain(order)
        await completion

        expect(runner.runBlock).toHaveBeenCalledTimes(1)
        expect(startedBlocks(events)).toEqual(["b1"])
        expect(cancelledBlocks(events)).toEqual(expect.arrayContaining(["b1", "b2"]))
    })
})
