import { describe, expect, it } from "vitest"
import type { Command } from "../../../kernel"
import { normalizeCommand, normalizeLegacyEffect } from "../LegacyTaskEffectOracle"
import { transitionalExecutors } from "../TransitionalCommandExecutor"

const LEGACY_TYPES = [
	"POST_TASK_VIEW",
	"PERSIST_SNAPSHOT",
	"CANCEL_RUNTIME",
	"PREPARE_RESUME",
	"START_API",
	"EXECUTE_TOOL",
	"APPEND_SAY",
	"APPEND_ASK",
	"START_NEW_TASK",
	"START_SUCCESSOR_TASK",
] as const

const COMMANDS: Command[] = [
	{ commandId: "1", originRevision: 1, generation: 0, type: "provider.start", draftRef: "d" },
	{ commandId: "2", originRevision: 1, generation: 0, type: "tool.run", turnId: "t", blockIds: ["b"] },
	{ commandId: "3", originRevision: 1, generation: 0, type: "dialog.prepare", interactionId: "i", kind: "q" },
	{ commandId: "4", originRevision: 1, generation: 0, type: "dialog.reveal", interactionId: "i", journalRef: "j" },
	{ commandId: "5", originRevision: 1, generation: 0, type: "compose.round", admittedEntryIds: [] },
	{
		commandId: "6",
		originRevision: 1,
		generation: 0,
		type: "compaction.run",
		compactionId: "c",
		attempt: "a",
		contextRef: "ctx",
	},
	{
		commandId: "7",
		originRevision: 1,
		generation: 0,
		type: "approval.evaluate",
		interactionId: "i",
		blockId: "b",
		policyRevision: 1,
		riskFacts: {},
	},
	{ commandId: "8", originRevision: 1, generation: 0, type: "halt.stop", haltId: "h", participantIds: [], reason: "cancel" },
	{ commandId: "9", originRevision: 1, generation: 0, type: "task.spawn", spawnAttempt: "a", handoffRef: "h" },
]

describe("transitional executor oracle", () => {
	it("classifies all ten legacy effect ports", () => {
		expect(LEGACY_TYPES.map((type) => normalizeLegacyEffect({ type }).kind)).toEqual([
			"post_view",
			"persist_snapshot",
			"halt",
			"prepare_resume",
			"provider",
			"tool",
			"dialog_say",
			"dialog_ask",
			"spawn_new",
			"spawn_successor",
		])
	})

	it("classifies all eight command families", () => {
		expect(COMMANDS.map((command) => normalizeCommand(command).kind)).toEqual([
			"provider",
			"tool",
			"dialog_prepare",
			"dialog_reveal",
			"compose",
			"compaction",
			"policy",
			"halt",
			"spawn",
		])
	})

	it("creates independent domain adapters without owning routing policy", async () => {
		const seen: string[] = []
		const executors = transitionalExecutors({
			provider: async (command) => void seen.push(command.commandId),
			tool: async (command) => void seen.push(command.commandId),
		})
		await executors.find((executor) => executor.domain === "provider")?.execute(COMMANDS[0])
		await executors.find((executor) => executor.domain === "tool")?.execute(COMMANDS[1])
		expect(seen).toEqual(["1", "2"])
	})
})
