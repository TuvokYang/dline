import { createHash } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { atomicWriteTaskFile } from "./AtomicTaskFile"

export interface TaskPayloadStore {
	put(payload: Uint8Array): Promise<string>
	read(payloadRef: string): Promise<Uint8Array>
}

export class FileTaskPayloadStore implements TaskPayloadStore {
	constructor(private readonly directory: string) {}

	async put(payload: Uint8Array): Promise<string> {
		const digest = createHash("sha256").update(payload).digest("hex")
		const payloadRef = `sha256:${digest}`
		await mkdir(this.directory, { recursive: true })
		await atomicWriteTaskFile(this.pathFor(payloadRef), payload)
		return payloadRef
	}

	async read(payloadRef: string): Promise<Uint8Array> {
		if (!/^sha256:[a-f0-9]{64}$/.test(payloadRef)) throw new Error("InvalidTaskPayloadRef")
		return new Uint8Array(await readFile(this.pathFor(payloadRef)))
	}

	private pathFor(payloadRef: string): string {
		return path.join(this.directory, `${payloadRef.slice("sha256:".length)}.bin`)
	}
}
