import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it, vi } from "vitest"
import { WINDOWS_POWERSHELL_LEGACY_PATH } from "@/utils/shell"

const execSyncMock = vi.hoisted(() => vi.fn(() => "Active code page: 65001"))

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("child_process")>()),
	execSync: execSyncMock,
}))

import { StandaloneTerminal } from "./StandaloneTerminal"
import { StandaloneTerminalProcess } from "./StandaloneTerminalProcess"

afterEach(() => {
	vi.useRealTimers()
})

describe("StandaloneTerminalProcess output streams", () => {
	it("detects the Windows code page only once per extension process", () => {
		const originalPlatform = process.platform
		try {
			Object.defineProperty(process, "platform", { value: "win32" })
			execSyncMock.mockClear()

			new StandaloneTerminalProcess()
			new StandaloneTerminalProcess()

			assert.equal(execSyncMock.mock.calls.length, 1)
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform })
		}
	})

	it("preserves UTF-8 characters split across output chunks", () => {
		const terminalProcess = new StandaloneTerminalProcess()
		const decodeBuffer = (
			terminalProcess as unknown as {
				decodeBuffer(data: Buffer, stream: "stdout" | "stderr"): string
			}
		).decodeBuffer.bind(terminalProcess)
		const expected = "output 中文 🚀 complete"
		const encoded = Buffer.from(expected, "utf8")
		const chineseStart = Buffer.byteLength("output ", "utf8")
		const emojiStart = Buffer.byteLength("output 中文 ", "utf8")
		const chunks = [
			encoded.subarray(0, chineseStart + 1),
			encoded.subarray(chineseStart + 1, emojiStart + 2),
			encoded.subarray(emojiStart + 2),
		]

		const actual = chunks.map((chunk) => decodeBuffer(chunk, "stdout")).join("")

		assert.equal(actual, expected)
	})

	it("preserves an intentional Unicode replacement character", () => {
		const terminalProcess = new StandaloneTerminalProcess()
		const decodeBuffer = (
			terminalProcess as unknown as {
				decodeBuffer(data: Buffer, stream: "stdout" | "stderr"): string
			}
		).decodeBuffer.bind(terminalProcess)

		assert.equal(decodeBuffer(Buffer.from("before � after", "utf8"), "stderr"), "before � after")
	})

	it("keeps partial stdout and stderr lines in independent buffers", () => {
		vi.useFakeTimers()
		const process = new StandaloneTerminalProcess()
		const emitted: Array<{ line: string; stream: string }> = []
		;(process.on as (...args: unknown[]) => typeof process)("line", (line: string, stream: string) => {
			emitted.push({ line, stream })
		})
		const internals = process as unknown as {
			handleOutput(data: string, stream: "stdout" | "stderr"): void
		}

		internals.handleOutput("stdout partial", "stdout")
		internals.handleOutput("stderr line\n", "stderr")
		internals.handleOutput(" complete\n", "stdout")

		assert.deepEqual(emitted, [
			{ line: "stderr line", stream: "stderr" },
			{ line: "stdout partial complete", stream: "stdout" },
		])
	})

	it("pauses and resumes both child output streams once", () => {
		const terminalProcess = new StandaloneTerminalProcess()
		const stdout = { pause: vi.fn(), resume: vi.fn() }
		const stderr = { pause: vi.fn(), resume: vi.fn() }
		;(terminalProcess as unknown as { childProcess: unknown }).childProcess = { stdout, stderr }

		terminalProcess.pauseOutput()
		terminalProcess.pauseOutput()
		assert.equal(stdout.pause.mock.calls.length, 1)
		assert.equal(stderr.pause.mock.calls.length, 1)

		terminalProcess.resumeOutput()
		terminalProcess.resumeOutput()
		assert.equal(stdout.resume.mock.calls.length, 1)
		assert.equal(stderr.resume.mock.calls.length, 1)
	})

	it("uses Windows PowerShell for the default background shell", () => {
		const originalPlatform = process.platform
		try {
			Object.defineProperty(process, "platform", { value: "win32" })
			const terminalProcess = new StandaloneTerminalProcess()
			const internals = terminalProcess as unknown as {
				getDefaultShell(): string
				getShellArgs(shell: string, command: string): string[]
			}

			const args = internals.getShellArgs(internals.getDefaultShell(), "Get-Location")

			assert.equal(internals.getDefaultShell(), WINDOWS_POWERSHELL_LEGACY_PATH)
			assert.equal(args[0], "-Command")
			assert.ok(args[1].endsWith("Get-Location"))
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform })
		}
	})

	it("uses shell-specific arguments for Windows terminal profiles", () => {
		const originalPlatform = process.platform
		try {
			Object.defineProperty(process, "platform", { value: "win32" })
			const terminalProcess = new StandaloneTerminalProcess()
			const getShellArgs = (
				terminalProcess as unknown as { getShellArgs(shell: string, command: string): string[] }
			).getShellArgs.bind(terminalProcess)

			const cmdArgs = getShellArgs("C:\\Windows\\System32\\cmd.exe", "echo ready")
			assert.equal(cmdArgs[0], "/c")
			assert.ok(cmdArgs[1].endsWith("echo ready"))
			assert.deepEqual(getShellArgs("D:\\Git\\bin\\bash.exe", "echo ready"), ["-l", "-c", "echo ready"])
			assert.deepEqual(getShellArgs("C:\\Windows\\System32\\wsl.exe", "echo ready"), [
				"--exec",
				"bash",
				"-lc",
				"echo ready",
			])
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform })
		}
	})

	it.runIf(process.platform === "win32")(
		"terminates a PowerShell child Node process before its delayed marker write",
		async () => {
			let childPid: number | undefined
			const terminalProcess = new StandaloneTerminalProcess({
				getProcessList: async (rootPid) => {
					if (childPid === undefined) throw new Error("child PID was not observed")
					return [
						{ pid: rootPid, ppid: 0, name: "powershell.exe" },
						{ pid: childPid, ppid: rootPid, name: "node.exe" },
					]
				},
			})
			const markerPath = path.join(os.tmpdir(), `dline-powershell-child-${process.pid}-${Date.now()}.txt`)
			const terminal = new StandaloneTerminal({
				cwd: process.cwd(),
				shellPath: WINDOWS_POWERSHELL_LEGACY_PATH,
			})
			let completed = false
			terminalProcess.once("completed", () => {
				completed = true
			})
			const childPidObserved = new Promise<number>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("timed out waiting for child PID")), 10_000)
				terminalProcess.on("line", (line) => {
					const match = line.match(/^DLINE_CHILD_PID=(\d+)$/)
					if (!match) return
					clearTimeout(timeout)
					resolve(Number(match[1]))
				})
			})

			try {
				const escapedMarkerPath = markerPath.replaceAll("\\", "\\\\").replaceAll("'", "\\'")
				await terminalProcess.run(
					terminal,
					`node -e "const fs=require('fs'); console.log('DLINE_CHILD_PID='+process.pid); setTimeout(()=>fs.writeFileSync('${escapedMarkerPath}','unexpected'),2000); setInterval(()=>{},1000)"`,
				)
				childPid = await childPidObserved
				assert.equal(completed, false)

				await terminalProcess.terminate()
				await new Promise((resolve) => setTimeout(resolve, 2_500))

				assert.equal(completed, true)
				assert.equal(existsSync(markerPath), false)
			} finally {
				await terminalProcess.terminate().catch(() => undefined)
				await rm(markerPath, { force: true })
			}
		},
	)
})
