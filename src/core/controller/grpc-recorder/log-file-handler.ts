import { writeJsonAtomic } from "@shared/storage/atomic-file"
import * as path from "path"
import { GrpcSessionLog } from "@/core/controller/grpc-recorder/types"

const LOG_FILE_PREFIX = "grpc_recorded_session"
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 300] as const
const WINDOWS_UNKNOWN_RETRY_DELAYS_MS = [15, 35, 75, 150] as const

function isTransientWindowsUnknownError(error: unknown): boolean {
    if (process.platform !== "win32") return false
    return (error as NodeJS.ErrnoException | undefined)?.code === "UNKNOWN"
}

export class LogFileHandlerNoops implements ILogFileHandler {
    async initialize(_initialData: GrpcSessionLog): Promise<void> {}
    async write(_sessionLog: GrpcSessionLog): Promise<void> {}
}

export interface ILogFileHandler {
    initialize(initialData: GrpcSessionLog): Promise<void>
    write(sessionLog: GrpcSessionLog): Promise<void>
}

/**
 * Default implementation of `ILogFileHandler` that persists logs to disk.
 *
 * - Creates a log file inside the workspace `tests/specs` folder.
 * - Uses a timestamped filename by default, unless overridden by an env var.
 * - Saves logs in JSON format.
 */
export class LogFileHandler implements ILogFileHandler {
    private logFilePath: string

    constructor() {
        const fileName = this.getFileName()
        const workspaceFolder = process.env.DEV_WORKSPACE_FOLDER ?? process.cwd()
        const folderPath = path.join(workspaceFolder, "tests", "specs")
        this.logFilePath = path.join(folderPath, fileName)
    }

    public getFilePath(): string {
        return this.logFilePath
    }

    public getFileName(): string {
        const envFileName = path.basename(process.env.GRPC_RECORDER_FILE_NAME || "").replace(/[^a-zA-Z0-9-_]/g, "_")
        if (envFileName && envFileName.trim().length > 0) {
            return `${LOG_FILE_PREFIX}_${envFileName}.json`
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
        return `${LOG_FILE_PREFIX}_${timestamp}.json`
    }

    public async initialize(initialData: GrpcSessionLog): Promise<void> {
        await this.writeAtomically(initialData)
    }

    public async write(sessionLog: GrpcSessionLog): Promise<void> {
        await this.writeAtomically(sessionLog)
    }

    private async writeAtomically(sessionLog: GrpcSessionLog): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            try {
                await writeJsonAtomic(this.logFilePath, sessionLog, {
                    renameRetryDelaysMs: RENAME_RETRY_DELAYS_MS,
                })
                return
            } catch (error) {
                if (!isTransientWindowsUnknownError(error) || attempt >= WINDOWS_UNKNOWN_RETRY_DELAYS_MS.length) {
                    throw error
                }
                await new Promise<void>((resolve) => setTimeout(resolve, WINDOWS_UNKNOWN_RETRY_DELAYS_MS[attempt]))
            }
        }
    }
}
