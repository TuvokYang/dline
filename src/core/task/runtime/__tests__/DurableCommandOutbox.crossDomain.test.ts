import { describe, expect, it, vi } from "vitest"
import type { Command } from "../../kernel"
import type { CommandPublicationStore } from "../../stores/contracts"
import { CommandRouter } from "../CommandRouter"
import type { CommandExecutor } from "../contracts"
import { DurableCommandOutbox } from "../DurableCommandOutbox"
import { deferred } from "../deferred"

/**
 * A turn-ending tool waits for the dialog it opened, so the dialog's reveal has
 * to reach its executor while that tool is still running. Publishing strictly in
 * queue order makes the two wait on each other: the tool cannot finish until the
 * question is answerable, and the question cannot be revealed until the tool
 * finishes.
 */

function commandBase(originRevision: number) {
    return {
        commandId: `task-1:${originRevision}:0`,
        originRevision,
        sequence: 0,
        generation: 0,
    }
}

/** The turn-ending tool call that stays running until its dialog is answered. */
function toolRun(originRevision: number): Command {
    return {
        ...commandBase(originRevision),
        type: "tool.run",
        turnId: "turn-1",
        mode: "serial",
        blocks: [
            {
                blockId: "block-1",
                attempt: "attempt-1",
                index: 0,
                lanes: ["user-interaction"],
                turnEnding: true,
                invocationRef: "invocation-1",
            },
        ],
    } as Command
}

/** The reveal that makes the question answerable. */
function dialogReveal(originRevision: number): Command {
    return {
        ...commandBase(originRevision),
        type: "dialog.reveal",
        interactionId: "block-1",
        turnId: "turn-1",
        kind: "qna_response",
        presentationRef: "presentation-1",
        actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
        prepareKey: "dialog.prepare:block-1",
        journalRef: "journal:4",
        receiverGeneration: 0,
        revealKey: "dialog.reveal:block-1:0",
    } as Command
}

function publications(): CommandPublicationStore {
    const marked = new Set<string>()
    return {
        has: async (effectKey: string) => marked.has(effectKey),
        mark: async (_command: Command, effectKey?: string) => {
            if (effectKey) marked.add(effectKey)
        },
    }
}

/** An executor whose command completes only when the test releases it. */
function blockingExecutor(domain: CommandExecutor["domain"]): CommandExecutor & { release: () => void } {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    return {
        domain,
        execute: () => gate,
        release,
    }
}

describe("DurableCommandOutbox cross-domain publication", () => {
    it("reveals a dialog while the turn-ending tool that awaits it is still running", async () => {
        const tool = blockingExecutor("tool")
        const revealed = vi.fn(async () => undefined)
        const router = new CommandRouter([tool, { domain: "dialog", execute: revealed }])
        const outbox = new DurableCommandOutbox(router, publications())

        outbox.enqueue([toolRun(4)], { revision: 4, durable: Promise.resolve() })
        outbox.enqueue([dialogReveal(7)], { revision: 7, durable: Promise.resolve() })

        // The reveal belongs to a different executor domain, so it must not wait
        // behind the tool. Waiting here is the deadlock: the tool only returns
        // once the revealed question has been answered.
        await vi.waitFor(() => expect(revealed).toHaveBeenCalledOnce())

        tool.release()
        await outbox.whenIdle()
    })

    it("drains a command published after the queue ran dry but before its drain settled", async () => {
        const executed: number[] = []
        let outbox!: DurableCommandOutbox
        let published = false
        const router = new CommandRouter([
            {
                domain: "tool",
                execute: async (command: Command) => {
                    executed.push(command.originRevision)
                    if (published) return
                    published = true
                    // Land the next command in the window between the loop emptying
                    // the queue and the drain's settlement, where a wake-up was lost.
                    void Promise.resolve()
                        .then(() => undefined)
                        .then(() => undefined)
                        .then(() => outbox.enqueue([toolRun(5)], { revision: 5, durable: Promise.resolve() }))
                },
            },
        ])
        outbox = new DurableCommandOutbox(router, publications())

        outbox.enqueue([toolRun(4)], { revision: 4, durable: Promise.resolve() })
        await vi.waitFor(() => expect(executed).toEqual([4, 5]))
        await outbox.whenIdle()

        expect(outbox.pendingCount).toBe(0)
    })

    it("admits the next command in one domain before the previous effect completes", async () => {
        const firstCompletion = deferred<void>()
        const admissions: number[] = []
        const router = new CommandRouter([
            {
                domain: "tool",
                execute: (command: Command) => {
                    admissions.push(command.originRevision)
                    return command.originRevision === 4 ? firstCompletion.promise : Promise.resolve()
                },
            },
        ])
        const outbox = new DurableCommandOutbox(router, publications())

        outbox.enqueue([toolRun(4)], { revision: 4, durable: Promise.resolve() })
        outbox.enqueue([toolRun(5)], { revision: 5, durable: Promise.resolve() })

        await vi.waitFor(() => expect(admissions).toEqual([4, 5]))
        firstCompletion.resolve()
        await outbox.whenIdle()
    })

    it("waits for the requested command revision without joining older stuck effects", async () => {
        const older = deferred<void>()
        const router = new CommandRouter([
            {
                domain: "tool",
                execute: (command) => (command.originRevision === 4 ? older.promise : Promise.resolve()),
            },
        ])
        router.dispatch(toolRun(4))
        router.dispatch(toolRun(5))

        await expect(router.waitForRevision(5)).resolves.toBeUndefined()
        expect(router.inFlightCount).toBe(1)
        older.resolve()
        await router.waitForQuiescence()
    })

    it("keeps an admitted command durable until its effect is published", async () => {
        const completion = deferred<void>()
        const router = new CommandRouter([{ domain: "tool", execute: () => completion.promise }])
        const outbox = new DurableCommandOutbox(router, publications())
        const admitted = toolRun(4)

        outbox.enqueue([admitted], { revision: 4, durable: Promise.resolve() })
        await vi.waitFor(() => expect(outbox.pendingCount).toBe(1))
        expect(outbox.persistableAfter([])).toEqual([admitted])

        completion.resolve()
        await outbox.whenIdle()
        expect(outbox.persistableAfter([])).toEqual([])
    })

    it("keeps one domain's admissions in their original order", async () => {
        const order: number[] = []
        const router = new CommandRouter([
            {
                domain: "tool",
                execute: async (command: Command) => {
                    order.push(command.originRevision)
                },
            },
        ])
        const outbox = new DurableCommandOutbox(router, publications())

        outbox.enqueue([toolRun(4)], { revision: 4, durable: Promise.resolve() })
        outbox.enqueue([toolRun(5)], { revision: 5, durable: Promise.resolve() })
        await outbox.whenIdle()

        expect(order).toEqual([4, 5])
    })
})
