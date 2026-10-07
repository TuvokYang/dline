import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Logger } from "@/shared/services/Logger"

const MAX_TOTAL_SIZE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_FILE_AGE_MS = 50 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const TEMP_FILE_STEM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ATTACHMENTS_DIRECTORY = "attachments"
/** Characters that are invalid in a file name on at least one supported platform. */
const UNSAFE_FILE_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g

interface TempFileInfo {
	readonly path: string
	readonly size: number
	readonly mtime: number
}

interface CleanupResult {
	readonly deletedCount: number
	readonly freedBytes: number
}

/** Owns Dline temporary log paths, staged attachments, and their retention lifecycle. */
class DlineRuntimeFileManagerImpl {
	private readonly tempDir = path.join(os.tmpdir(), "dline")
	private readonly attachmentsDir = path.join(this.tempDir, ATTACHMENTS_DIRECTORY)
	private readonly legacyTempDir = path.join(os.tmpdir(), "cline")
	private cleanupIntervalId: NodeJS.Timeout | null = null
	private initialized = false

	getTempDir(): string {
		return this.tempDir
	}

	/** Create the managed temp directory before command execution enters latency-sensitive paths. */
	initialize(): void {
		if (this.initialized) return
		this.ensureTempDirExists()
	}

	/** Return whether a path is owned by Dline's system-temp directory. */
	isManagedPath(filePath: string): boolean {
		if (!filePath) {
			return false
		}

		const relativePath = path.relative(path.resolve(this.tempDir), path.resolve(filePath))
		return (
			relativePath === "" ||
			(!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))
		)
	}

	/**
	 * Resolve a deterministic log path from a stable domain identity.
	 * The caller owns uniqueness; this service never replaces the supplied identity.
	 */
	createTempFilePath(stableStem: string): string {
		if (!TEMP_FILE_STEM_PATTERN.test(stableStem)) {
			throw new Error(`Invalid Dline temp file stem: ${stableStem}`)
		}

		this.initialize()
		return path.join(this.tempDir, `${stableStem}.log`)
	}

	/**
	 * Reserve a unique path for a user attachment that arrived as bytes without a host path.
	 * Each attachment gets its own directory so the file keeps its original base name, which is
	 * what the model sees. Staged attachments follow the same age-based retention as logs.
	 */
	async createAttachmentPath(fileName: string): Promise<string> {
		const safeName = path.basename(fileName).replace(UNSAFE_FILE_NAME_CHARACTERS, "_").trim() || "attachment"
		const directory = path.join(this.attachmentsDir, randomUUID())
		await fs.promises.mkdir(directory, { recursive: true })
		return path.join(directory, safeName)
	}

	async cleanup(): Promise<CleanupResult> {
		try {
			this.ensureTempDirExists()
			const current = await this.cleanupDirectory(this.tempDir)
			const legacy = await this.cleanupDirectory(this.legacyTempDir)
			const attachments = await this.cleanupAttachmentDirectories()
			const result = {
				deletedCount: current.deletedCount + legacy.deletedCount + attachments.deletedCount,
				freedBytes: current.freedBytes + legacy.freedBytes + attachments.freedBytes,
			}

			if (result.deletedCount > 0) {
				Logger.info(
					`Dline temp cleanup: deleted ${result.deletedCount} files, freed ${Math.round(result.freedBytes / 1024 / 1024)}MB`,
				)
			}
			return result
		} catch (error) {
			Logger.error("Error during Dline temp cleanup", error)
			return { deletedCount: 0, freedBytes: 0 }
		}
	}

	async deleteFile(filePath: string): Promise<void> {
		try {
			await fs.promises.unlink(filePath)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				Logger.error(`Failed to delete temp file: ${filePath}`, error)
			}
		}
	}

	startPeriodicCleanup(): void {
		if (this.cleanupIntervalId) {
			return
		}

		void this.cleanup()
		this.cleanupIntervalId = setInterval(() => {
			void this.cleanup()
		}, CLEANUP_INTERVAL_MS)
		this.cleanupIntervalId.unref()
	}

	stopPeriodicCleanup(): void {
		if (!this.cleanupIntervalId) {
			return
		}

		clearInterval(this.cleanupIntervalId)
		this.cleanupIntervalId = null
	}

	private ensureTempDirExists(): void {
		try {
			fs.mkdirSync(this.tempDir, { recursive: true })
			this.initialized = true
		} catch (error) {
			throw new Error(`Failed to create Dline temp directory: ${this.tempDir}`, { cause: error })
		}
	}

	private async cleanupDirectory(directory: string): Promise<CleanupResult> {
		let files: string[]
		try {
			files = await fs.promises.readdir(directory)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { deletedCount: 0, freedBytes: 0 }
			}
			throw error
		}

		const fileInfos = await this.readFileInfos(directory, files)
		const now = Date.now()
		const remainingFiles: TempFileInfo[] = []
		let deletedCount = 0
		let freedBytes = 0

		for (const fileInfo of fileInfos) {
			if (now - fileInfo.mtime <= MAX_FILE_AGE_MS) {
				remainingFiles.push(fileInfo)
				continue
			}

			if (await this.tryDelete(fileInfo.path)) {
				deletedCount++
				freedBytes += fileInfo.size
			}
		}

		let totalSize = remainingFiles.reduce((sum, file) => sum + file.size, 0)
		if (totalSize > MAX_TOTAL_SIZE_BYTES) {
			remainingFiles.sort((left, right) => left.mtime - right.mtime)
			for (const fileInfo of remainingFiles) {
				if (totalSize <= MAX_TOTAL_SIZE_BYTES) {
					break
				}
				if (await this.tryDelete(fileInfo.path)) {
					totalSize -= fileInfo.size
					deletedCount++
					freedBytes += fileInfo.size
				}
			}
		}

		return { deletedCount, freedBytes }
	}

	/** Remove staged attachment directories whose contents are older than the retention window. */
	private async cleanupAttachmentDirectories(): Promise<CleanupResult> {
		let entries: fs.Dirent[]
		try {
			entries = await fs.promises.readdir(this.attachmentsDir, { withFileTypes: true })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { deletedCount: 0, freedBytes: 0 }
			}
			throw error
		}

		const now = Date.now()
		let deletedCount = 0
		let freedBytes = 0
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue
			}
			const directory = path.join(this.attachmentsDir, entry.name)
			const files = await this.readFileInfos(directory, await fs.promises.readdir(directory).catch(() => []))
			const newest = files.reduce((latest, file) => Math.max(latest, file.mtime), 0)
			if (files.length > 0 && now - newest <= MAX_FILE_AGE_MS) {
				continue
			}
			try {
				await fs.promises.rm(directory, { recursive: true, force: true })
				deletedCount += files.length
				freedBytes += files.reduce((sum, file) => sum + file.size, 0)
			} catch {
				// Best effort: a file may still be open by a pending send.
			}
		}
		return { deletedCount, freedBytes }
	}

	private async readFileInfos(directory: string, files: readonly string[]): Promise<TempFileInfo[]> {
		const fileInfos: TempFileInfo[] = []
		for (const file of files) {
			const filePath = path.join(directory, file)
			try {
				const stats = await fs.promises.stat(filePath)
				if (stats.isFile()) {
					fileInfos.push({ path: filePath, size: stats.size, mtime: stats.mtimeMs })
				}
			} catch {
				// Another process may have removed the file after directory enumeration.
			}
		}
		return fileInfos
	}

	private async tryDelete(filePath: string): Promise<boolean> {
		try {
			await fs.promises.unlink(filePath)
			return true
		} catch {
			// Cleanup is best effort because another process may own or remove the file.
			return false
		}
	}
}

export const DlineRuntimeFileManager = new DlineRuntimeFileManagerImpl()
