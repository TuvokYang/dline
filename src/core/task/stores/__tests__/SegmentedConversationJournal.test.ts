import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { SegmentedConversationJournal } from "../SegmentedConversationJournal"

const directories: string[] = []

async function journal() {
	const directory = await mkdtemp(join(tmpdir(), "dline-journal-"))
	directories.push(directory)
	return { directory, journal: await SegmentedConversationJournal.open({ directory, taskId: "task-1" }) }
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("SegmentedConversationJournal", () => {
	it("durably reopens idempotent operations", async () => {
		const { directory, journal: opened } = await journal()
		const first = await opened.append({ operationId: "provider.final:1", payloadRef: "answer:1", source: "provider" })
		const duplicate = await opened.append({ operationId: "provider.final:1", payloadRef: "answer:1", source: "provider" })
		expect(duplicate).toEqual({ watermark: first.watermark, disposition: "existing" })

		const reopened = await SegmentedConversationJournal.open({ directory, taskId: "task-1" })
		expect(await reopened.findByOperation("provider.final:1")).toMatchObject({ payloadRef: "answer:1" })
		await expect(
			reopened.append({ operationId: "provider.final:1", payloadRef: "different", source: "provider" }),
		).rejects.toThrow("operation conflict")
	})

	it("preserves a torn segment and continues in a rebased epoch", async () => {
		const { directory, journal: opened } = await journal()
		await opened.append({ operationId: "message:1", payloadRef: "one", source: "system" })
		await appendFile(join(directory, "epoch-000000.jsonl"), '{"partial":')

		const recovered = await SegmentedConversationJournal.open({ directory, taskId: "task-1" })
		const appended = await recovered.append({ operationId: "message:2", payloadRef: "two", source: "system" })
		expect(appended.watermark).toEqual({ epoch: 1, seq: 2 })
		expect((await recovered.read()).map((entry) => entry.kind)).toEqual(["message", "rebase", "message"])
	})

	it("durably reopens a supersede replacement and keeps it idempotent", async () => {
		const { directory, journal: opened } = await journal()
		await opened.append({ operationId: "message:1", payloadRef: "task", source: "intake" })
		const answered = await opened.append({ operationId: "message:2", payloadRef: "answered", source: "provider" })
		await opened.append({ operationId: "message:3", payloadRef: "pending", source: "tool" })
		const replacement = {
			operationId: "compaction.supersede:1",
			from: answered.watermark,
			to: answered.watermark,
			replacementRef: "summary:1",
		}
		await opened.supersedeRange(replacement)

		const reopened = await SegmentedConversationJournal.open({ directory, taskId: "task-1" })
		expect((await reopened.project()).visibleMessages.map((entry) => entry.payloadRef)).toEqual([
			"task",
			"summary:1",
			"pending",
		])
		// A retried landing replays the same record instead of writing a second one.
		expect(await reopened.supersedeRange(replacement)).toMatchObject({ disposition: "existing" })
		await expect(reopened.supersedeRange({ ...replacement, replacementRef: "summary:other" })).rejects.toThrow(
			"operation conflict",
		)
	})

	it("rejects a malformed complete record instead of skipping it", async () => {
		const directory = await mkdtemp(join(tmpdir(), "dline-journal-"))
		directories.push(directory)
		await writeFile(join(directory, "epoch-000000.jsonl"), '{"broken":true}\n')
		await expect(SegmentedConversationJournal.open({ directory, taskId: "task-1" })).rejects.toThrow("InvalidJournalRecord")
	})
})
