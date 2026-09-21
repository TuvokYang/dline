import { randomUUID } from "node:crypto"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"])
const RETRY_DELAYS_MS = [10, 25, 50, 100] as const

async function renameWithRetry(sourcePath: string, destinationPath: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(sourcePath, destinationPath)
			return
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code
			if (!code || !RETRYABLE_RENAME_CODES.has(code) || attempt >= RETRY_DELAYS_MS.length) throw error
			await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
		}
	}
}

export async function atomicWriteTaskFile(filePath: string, data: string | Uint8Array): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true })
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
	try {
		await writeFile(temporaryPath, data, { flag: "wx" })
		await renameWithRetry(temporaryPath, filePath)
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined)
		throw error
	}
}
