import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createInitialTaskState, hydrate } from "../kernel"
import {
	type DurableTaskSnapshot,
	FileTaskStateVault,
	InMemoryStateVault,
	InMemoryTaskPayloadStore,
	type StateVault,
} from "../stores"
import { decodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import {
	FileLegacyInputQueueSource,
	LegacyInputQueueCleanupPendingError,
	LegacyInputQueueIntegrityError,
	type LegacyInputQueueSource,
	migrateLegacyInputQueue,
} from "./LegacyInputQueueMigration"

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "dline-legacy-input-queue-"))
	temporaryDirectories.push(directory)
	return directory
}

function semanticInput(): SemanticInputDocument {
	return {
		schemaVersion: 1,
		parserVersion: "test-parser-v1",
		catalogRevision: "test-catalog-v1",
		documentId: "document-1",
		rawText: "expanded input",
		nodes: [{ kind: "text", text: "expanded input" }],
		resources: [],
	}
}

async function payloadsOf(vault: InMemoryStateVault, payloads: InMemoryTaskPayloadStore): Promise<UserInputEnvelope[]> {
	const snapshot = await vault.load("task-1")
	if (!snapshot) throw new Error("expected migrated snapshot")
	return Promise.all(
		snapshot.state.intake.queued.map(async (entry) =>
			decodeTaskPayload<UserInputEnvelope>(await payloads.read(entry.payloadRef)),
		),
	)
}

class ControlledSource implements LegacyInputQueueSource {
	readonly removeInputQueue = vi.fn(async (_expectedFingerprint: string) => undefined)

	constructor(public current: { readonly fingerprint: string; readonly entries: readonly unknown[] } | undefined) {}

	async read() {
		return this.current
	}
}

class FailingVault implements StateVault {
	readonly save = vi.fn(async (_snapshot: DurableTaskSnapshot) => {
		throw new Error("state save failed")
	})

	async load(): Promise<DurableTaskSnapshot | undefined> {
		return undefined
	}
}

describe("legacy input queue migration", () => {
	afterEach(async () => {
		vi.restoreAllMocks()
		await Promise.all(
			temporaryDirectories.splice(0).map(async (directory) => {
				const { rm } = await import("node:fs/promises")
				await rm(directory, { recursive: true, force: true })
			}),
		)
	})

	it("imports a real snapshot once, preserves user order and payload metadata, clears editing, and skips delivering entries", async () => {
		const directory = await temporaryDirectory()
		const snapshotPath = path.join(directory, "snapshot.json")
		await writeFile(
			snapshotPath,
			JSON.stringify({
				interaction: { interactionId: "keep-me" },
				inputQueue: [
					{
						id: "moved-first",
						text: "first after reorder",
						images: ["image-a"],
						files: ["file-a"],
						activeQuote: "quoted",
						semanticInput: semanticInput(),
						mode: "steering",
						editing: true,
						sequence: 0,
					},
					{
						id: "moved-second",
						text: "second after reorder",
						images: [],
						files: [],
						mode: "queued",
						sequence: 1,
					},
					{
						id: "possibly-sent",
						text: "must not be sent twice",
						images: [],
						files: [],
						mode: "queued",
						delivering: true,
						sequence: 2,
					},
				],
			}),
		)
		const vault = new InMemoryStateVault()
		const payloads = new InMemoryTaskPayloadStore()

		await expect(
			migrateLegacyInputQueue({
				taskId: "task-1",
				source: new FileLegacyInputQueueSource(snapshotPath),
				vault,
				payloads,
			}),
		).resolves.toMatchObject({ kind: "imported", importedEntries: 2, skippedDeliveringEntries: 1 })

		const stored = await vault.load("task-1")
		expect(stored?.state.intake.queued).toEqual([
			{
				entryId: "moved-first",
				payloadRef: expect.stringMatching(/^sha256:/),
				source: "user",
				mode: "steering",
				sequence: 0,
				queue: { editing: false },
				state: "accepted",
			},
			{
				entryId: "moved-second",
				payloadRef: expect.stringMatching(/^sha256:/),
				source: "user",
				mode: "queued",
				sequence: 1,
				queue: { editing: false },
				state: "accepted",
			},
		])
		expect(stored?.state.legacyInputQueueV1).toMatchObject({ importedEntryCount: 2, skippedDeliveringCount: 1 })
		expect(await payloadsOf(vault, payloads)).toEqual([
			{
				kind: "user_input",
				text: "first after reorder",
				images: ["image-a"],
				files: ["file-a"],
				activeQuote: "quoted",
				semanticInput: semanticInput(),
			},
			{ kind: "user_input", text: "second after reorder", images: [], files: [] },
		])
		expect(JSON.parse(await readFile(snapshotPath, "utf8"))).toEqual({
			interaction: { interactionId: "keep-me" },
		})
	})

	it("survives a real state-file reload and kernel hydrate with the migration marker and order intact", async () => {
		const directory = await temporaryDirectory()
		const vault = new FileTaskStateVault(path.join(directory, "state.json"))
		const payloads = new InMemoryTaskPayloadStore()
		const source = new ControlledSource({
			fingerprint: "sha256:reload-source",
			entries: [
				{
					id: "second-before-reorder",
					text: "now first",
					images: [],
					files: [],
					mode: "steering",
					editing: true,
					sequence: 0,
				},
				{ id: "first-before-reorder", text: "now second", images: [], files: [], mode: "queued", sequence: 1 },
			],
		})

		await migrateLegacyInputQueue({ taskId: "task-1", source, vault, payloads })

		const reloaded = await new FileTaskStateVault(path.join(directory, "state.json")).load("task-1")
		if (!reloaded) throw new Error("expected reloaded canonical state")
		const restored = hydrate({
			taskId: "task-1",
			snapshot: reloaded.state,
			journalTail: { seq: 0 },
			openReason: "resume",
		})
		expect(restored.state.legacyInputQueueV1).toMatchObject({
			sourceFingerprint: "sha256:reload-source",
			importedEntryCount: 2,
		})
		expect(restored.state.intake.queued.map((entry) => [entry.entryId, entry.sequence, entry.queue?.editing])).toEqual([
			["second-before-reorder", 0, false],
			["first-before-reorder", 1, false],
		])
	})

	it("saves canonical state before cleanup and retries only cleanup after a failed source rewrite", async () => {
		const source = new ControlledSource({
			fingerprint: "sha256:source-a",
			entries: [{ id: "legacy-1", text: "retained", images: [], files: [], mode: "queued", sequence: 0 }],
		})
		source.removeInputQueue.mockRejectedValueOnce(new Error("source rewrite failed"))
		const vault = new InMemoryStateVault()
		const save = vi.spyOn(vault, "save")
		const payloads = new InMemoryTaskPayloadStore()
		const put = vi.spyOn(payloads, "put")

		await expect(migrateLegacyInputQueue({ taskId: "task-1", source, vault, payloads })).rejects.toBeInstanceOf(
			LegacyInputQueueCleanupPendingError,
		)
		expect((await vault.load("task-1"))?.state.intake.queued).toHaveLength(1)
		expect(save).toHaveBeenCalledOnce()
		expect(put).toHaveBeenCalledOnce()

		await expect(migrateLegacyInputQueue({ taskId: "task-1", source, vault, payloads })).resolves.toMatchObject({
			kind: "cleaned",
			importedEntries: 1,
		})
		expect(save).toHaveBeenCalledOnce()
		expect(put).toHaveBeenCalledOnce()
		expect(source.removeInputQueue).toHaveBeenCalledTimes(2)
	})

	it("fails closed when the retained legacy source changes after canonical state was saved", async () => {
		const source = new ControlledSource({
			fingerprint: "sha256:source-a",
			entries: [{ id: "legacy-1", text: "A", images: [], files: [], mode: "queued", sequence: 0 }],
		})
		source.removeInputQueue.mockRejectedValueOnce(new Error("source rewrite failed"))
		const vault = new InMemoryStateVault()
		const payloads = new InMemoryTaskPayloadStore()
		await expect(migrateLegacyInputQueue({ taskId: "task-1", source, vault, payloads })).rejects.toBeInstanceOf(
			LegacyInputQueueCleanupPendingError,
		)

		source.current = {
			fingerprint: "sha256:source-b",
			entries: [{ id: "legacy-1", text: "B", images: [], files: [], mode: "queued", sequence: 0 }],
		}
		await expect(migrateLegacyInputQueue({ taskId: "task-1", source, vault, payloads })).rejects.toBeInstanceOf(
			LegacyInputQueueIntegrityError,
		)
		expect((await payloadsOf(vault, payloads))[0]?.text).toBe("A")
		expect(source.removeInputQueue).toHaveBeenCalledOnce()
	})

	it("does not clear the legacy source when the canonical snapshot cannot be saved", async () => {
		const source = new ControlledSource({
			fingerprint: "sha256:source-a",
			entries: [{ id: "legacy-1", text: "retained", images: [], files: [], mode: "queued", sequence: 0 }],
		})
		const vault = new FailingVault()

		await expect(
			migrateLegacyInputQueue({ taskId: "task-1", source, vault, payloads: new InMemoryTaskPayloadStore() }),
		).rejects.toThrow("state save failed")
		expect(source.removeInputQueue).not.toHaveBeenCalled()
	})

	it("preserves an existing canonical snapshot and its outbox while appending the legacy retained queue", async () => {
		const vault = new InMemoryStateVault()
		const original = createInitialTaskState("task-1")
		await vault.save({
			state: { ...original, revision: 7, intake: { ...original.intake, background: [] } },
			outbox: [{ type: "provider.start", commandId: "command-1", originRevision: 7, generation: 0, draftRef: "draft:1" }],
		})
		const source = new ControlledSource({
			fingerprint: "sha256:source-a",
			entries: [{ id: "legacy-1", text: "retained", images: [], files: [], mode: "queued", sequence: 0 }],
		})

		await migrateLegacyInputQueue({ taskId: "task-1", source, vault, payloads: new InMemoryTaskPayloadStore() })

		const migrated = await vault.load("task-1")
		expect(migrated?.state.revision).toBe(7)
		expect(migrated?.state.intake.queued.map((entry) => entry.entryId)).toEqual(["legacy-1"])
		expect(migrated?.outbox).toEqual([
			{ type: "provider.start", commandId: "command-1", originRevision: 7, generation: 0, draftRef: "draft:1" },
		])
	})
})
