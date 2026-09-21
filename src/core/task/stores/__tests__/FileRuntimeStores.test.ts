import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type Command, createInitialTaskState } from "../../kernel"
import { FileCommandPublicationStore } from "../FileCommandPublicationStore"
import { FileTaskPayloadStore } from "../FileTaskPayloadStore"
import { FileTaskStateVault } from "../FileTaskStateVault"

const directories: string[] = []

async function directory(): Promise<string> {
	const created = await mkdtemp(path.join(tmpdir(), "dline-runtime-v2-"))
	directories.push(created)
	return created
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

describe("file runtime stores", () => {
	it("atomically restores state and outbox together", async () => {
		const root = await directory()
		const vault = new FileTaskStateVault(root)
		const command: Command = {
			type: "compose.round",
			commandId: "command-1",
			originRevision: 1,
			generation: 0,
			admittedEntryIds: ["entry-1"],
		}
		await vault.save({ state: { ...createInitialTaskState("task-1"), revision: 1 }, outbox: [command] })
		await expect(new FileTaskStateVault(root).load("task-1")).resolves.toMatchObject({
			state: { taskId: "task-1", revision: 1 },
			outbox: [command],
		})
	})

	it("restores publication effect keys and payloads across reopen", async () => {
		const root = await directory()
		const command: Command = {
			type: "dialog.prepare",
			commandId: "prepare-1",
			originRevision: 1,
			generation: 0,
			interactionId: "interaction-1",
			turnId: "turn-1",
			kind: "question",
			presentationRef: "question:1",
			actionRules: [],
			prepareKey: "dialog.prepare:interaction-1",
		}
		const publications = await FileCommandPublicationStore.open(root)
		await publications.mark(command, command.prepareKey)
		expect(await (await FileCommandPublicationStore.open(root)).has(command.prepareKey)).toBe(true)

		const payloads = new FileTaskPayloadStore(path.join(root, "payloads"))
		const payloadRef = await payloads.put(new TextEncoder().encode("hello"))
		expect(new TextDecoder().decode(await new FileTaskPayloadStore(path.join(root, "payloads")).read(payloadRef))).toBe(
			"hello",
		)
	})
})
