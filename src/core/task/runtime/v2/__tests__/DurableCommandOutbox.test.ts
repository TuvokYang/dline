import { describe, expect, it } from "vitest"
import type { Command } from "../../../kernel"
import { InMemoryCommandPublicationStore } from "../../../stores"
import { CommandRouter } from "../CommandRouter"
import type { CommitReceipt } from "../contracts"
import { DurableCommandOutbox } from "../DurableCommandOutbox"
import { deferred } from "../deferred"
import { RecordingDiagnostics, RecordingExecutor, tick } from "./support"

function receipt(revision: number) {
	const durable = deferred<void>()
	return { gate: durable, receipt: { revision, durable: durable.promise } satisfies CommitReceipt }
}

function command(type: Command["type"], revision: number): Command {
	const base = { commandId: `${type}:${revision}`, originRevision: revision, generation: 0 }
	switch (type) {
		case "provider.start":
			return { ...base, type, draftRef: "draft" }
		case "dialog.prepare":
			return { ...base, type, interactionId: "i-1", kind: "question" }
		case "dialog.reveal":
			return { ...base, type, interactionId: "i-1", journalRef: "j-1" }
		case "halt.stop":
			return { ...base, type, haltId: "h-1", participantIds: ["provider"], reason: "cancel" }
		case "tool.run":
			return { ...base, type, turnId: "turn-1", blockIds: ["b-1"] }
		case "compose.round":
			return { ...base, type, admittedEntryIds: ["e-1"] }
		case "compaction.run":
			return { ...base, type, compactionId: "c-1", attempt: "a-1", contextRef: "ctx-1" }
		case "approval.evaluate":
			return { ...base, type, interactionId: "i-1", blockId: "b-1", policyRevision: 1, riskFacts: {} }
		case "task.spawn":
			return { ...base, type, spawnAttempt: "a-1", handoffRef: "handoff-1" }
		default:
			throw new Error(`Unsupported test command: ${type}`)
	}
}

describe("DurableCommandOutbox", () => {
	it.each([
		["provider.start", "provider"],
		["tool.run", "tool"],
		["dialog.reveal", "dialog"],
		["compose.round", "compose"],
		["compaction.run", "compaction"],
		["approval.evaluate", "policy"],
		["task.spawn", "spawn"],
	] as const)("publishes durable command %s only after its receipt", async (type, domain) => {
		const executor = new RecordingExecutor(domain)
		const outbox = new DurableCommandOutbox(new CommandRouter([executor]), new InMemoryCommandPublicationStore())
		const pending = receipt(1)
		outbox.enqueue([command(type, 1)], pending.receipt)
		await tick()
		expect(executor.commands).toEqual([])
		pending.gate.resolve()
		await outbox.whenPublishedThrough(1)
		expect(executor.commands).toEqual([expect.objectContaining({ type })])
	})

	it("routes prepare immediately and reveal only after durability", async () => {
		const dialog = new RecordingExecutor("dialog")
		const outbox = new DurableCommandOutbox(new CommandRouter([dialog]), new InMemoryCommandPublicationStore())
		const pending = receipt(1)
		outbox.enqueue([command("dialog.prepare", 1), command("dialog.reveal", 1)], pending.receipt)
		await tick()
		expect(dialog.commands.map((item) => item.type)).toEqual(["dialog.prepare"])
		pending.gate.resolve()
		await outbox.whenIdle()
		expect(dialog.commands.map((item) => item.type)).toEqual(["dialog.prepare", "dialog.reveal"])
	})

	it("routes halt immediately and fences older locked commands", async () => {
		const provider = new RecordingExecutor("provider")
		const halt = new RecordingExecutor("halt")
		const outbox = new DurableCommandOutbox(new CommandRouter([provider, halt]), new InMemoryCommandPublicationStore())
		const providerReceipt = receipt(1)
		outbox.enqueue([command("provider.start", 1)], providerReceipt.receipt)
		outbox.enqueue([command("halt.stop", 2)], { revision: 2, durable: Promise.resolve() })
		await tick()
		expect(halt.commands).toHaveLength(1)
		providerReceipt.gate.resolve()
		await outbox.whenIdle()
		expect(provider.commands).toEqual([])
	})

	it("does not publish when durability fails and skips already published recovery entries", async () => {
		const provider = new RecordingExecutor("provider")
		const diagnostics = new RecordingDiagnostics()
		const publications = new InMemoryCommandPublicationStore()
		const outbox = new DurableCommandOutbox(new CommandRouter([provider]), publications, diagnostics)
		const failed = receipt(1)
		outbox.enqueue([command("provider.start", 1)], failed.receipt)
		failed.gate.reject(new Error("vault failed"))
		await outbox.whenIdle()
		expect(provider.commands).toEqual([])
		expect(diagnostics.diagnostics).toEqual([expect.objectContaining({ source: "outbox", code: "durable_publish_failed" })])

		const restored = command("provider.start", 2)
		await publications.mark(restored)
		outbox.restore([restored])
		await outbox.whenIdle()
		expect(provider.commands).toEqual([])
	})
})
