import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect } from "chai"
import { afterEach, beforeAll, describe, it } from "vitest"
import { LogFileHandler } from "@/core/controller/grpc-recorder/log-file-handler"

describe("log-file-handler", () => {
    let logHandler: LogFileHandler
    const tempDirs: string[] = []

    beforeAll(async () => {
        logHandler = new LogFileHandler()
        expect(logHandler.getFilePath()).not.empty
    })

    afterEach(async () => {
        delete process.env.DEV_WORKSPACE_FOLDER
        delete process.env.GRPC_RECORDER_FILE_NAME
        for (const dir of tempDirs.splice(0)) {
            await fs.rm(dir, { recursive: true, force: true })
        }
    })

    describe("LogFileHandler", () => {
        it("returns file name with timestamp when env var not set", () => {
            const result = logHandler.getFileName()
            expect(result).to.contains("grpc_recorded_session")
        })

        it("atomically initializes and updates the recorded session log without leaving temp files", async () => {
            const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "dline-grpc-log-"))
            tempDirs.push(tempWorkspace)
            process.env.DEV_WORKSPACE_FOLDER = tempWorkspace
            process.env.GRPC_RECORDER_FILE_NAME = "atomic_test"

            const handler = new LogFileHandler()
            await handler.initialize({ startTime: "2026-11-27T00:00:00.000Z", entries: [] })
            await handler.write({
                startTime: "2026-11-27T00:00:00.000Z",
                entries: [
                    {
                        requestId: "req-1",
                        service: "dline.TaskService",
                        method: "getTaskRateMetrics",
                        isStreaming: false,
                        request: { message: {} },
                        status: "completed",
                    },
                ],
            })

            const written = JSON.parse(await fs.readFile(handler.getFilePath(), "utf8"))
            expect(written.entries).to.have.lengthOf(1)
            expect(written.entries[0].method).to.equal("getTaskRateMetrics")

            const dirEntries = await fs.readdir(path.dirname(handler.getFilePath()))
            expect(dirEntries).to.deep.equal(["grpc_recorded_session_atomic_test.json"])
        })
    })
})
