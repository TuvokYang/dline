import { describe, expect, it, vi } from "vitest"
import type { Command } from "../../kernel"
import type { CommandPublicationStore } from "../../stores/contracts"
import { CommandRouter } from "../CommandRouter"
import type { CommandExecutor } from "../contracts"
import { DurableCommandOutbox } from "../DurableCommandOutbox"

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
		journalRef: "journal:0:4",
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

	it("keeps one domain's commands in their original order", async () => {
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
