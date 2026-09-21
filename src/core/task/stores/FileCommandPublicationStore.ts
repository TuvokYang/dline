import { mkdir, open, readFile } from "node:fs/promises"
import path from "node:path"
import type { Command } from "../kernel"
import type { CommandPublicationStore } from "./contracts"

interface PublicationRecordV1 {
	readonly version: 1
	readonly effectKey: string
	readonly commandId: string
	readonly originRevision: number
	readonly generation: number
	readonly commandType: Command["type"]
}

export class FileCommandPublicationStore implements CommandPublicationStore {
	private readonly completed = new Set<string>()
	private writeTail: Promise<void> = Promise.resolve()

	private constructor(private readonly filePath: string) {}

	static async open(directory: string): Promise<FileCommandPublicationStore> {
		await mkdir(directory, { recursive: true })
		const store = new FileCommandPublicationStore(path.join(directory, "command-publications.jsonl"))
		await store.load()
		return store
	}

	async has(effectKey: string): Promise<boolean> {
		await this.writeTail
		return this.completed.has(effectKey)
	}

	mark(command: Command, effectKey = command.commandId): Promise<void> {
		const write = this.writeTail.then(async () => {
			if (this.completed.has(effectKey)) return
			const record: PublicationRecordV1 = {
				version: 1,
				effectKey,
				commandId: command.commandId,
				originRevision: command.originRevision,
				generation: command.generation,
				commandType: command.type,
			}
			const handle = await open(this.filePath, "a")
			try {
				await handle.write(`${JSON.stringify(record)}\n`)
				await handle.sync()
			} finally {
				await handle.close()
			}
			this.completed.add(effectKey)
		})
		this.writeTail = write.catch(() => undefined)
		return write
	}

	private async load(): Promise<void> {
		let content: string
		try {
			content = await readFile(this.filePath, "utf8")
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return
			throw error
		}
		for (const line of content.split("\n")) {
			if (!line) continue
			const record = JSON.parse(line) as Partial<PublicationRecordV1>
			if (record.version !== 1 || typeof record.effectKey !== "string") throw new Error("InvalidCommandPublicationRecord")
			this.completed.add(record.effectKey)
		}
	}
}
