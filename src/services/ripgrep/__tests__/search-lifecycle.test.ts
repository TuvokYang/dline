import * as childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"
import type { IgnoreController } from "@core/ignore/IgnoreController"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { activeRipgrepProcesses, resetRipgrepSlotsForTesting } from "../cpu-budget"
import { RIPGREP_SEARCH_TIMEOUT_MS, RipgrepSearchTimeoutError, regexSearchFiles } from "../index"

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>()
	return { ...actual, spawn: spawnMock }
})

vi.mock("@/utils/fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/utils/fs")>()
	return { ...actual, getBinaryLocation: async () => "rg" }
})

interface RipgrepStub {
	readonly process: childProcess.ChildProcess
	readonly stdout: Readable
	readonly stderr: Readable
	readonly kill: ReturnType<typeof vi.fn>
	close(code?: number | null): void
}

function createRipgrepStub(): RipgrepStub {
	const stdout = new Readable({ read() {} })
	const stderr = new Readable({ read() {} })
	const process = Object.assign(new EventEmitter(), {
		stdout,
		stderr,
		kill: vi.fn(() => true),
	}) as unknown as childProcess.ChildProcess

	return {
		process,
		stdout,
		stderr,
		kill: process.kill as ReturnType<typeof vi.fn>,
		close(code = 0) {
			stdout.push(null)
			stderr.push(null)
			process.emit("close", code, null)
		},
	}
}

function scanController(): IgnoreController {
	return {
		describeScanExclusion: () => undefined,
		getIgnoreContent: () => ".memory-bank/\n/.wt/\nnode_modules/\n",
		validateAccess: () => true,
	} as unknown as IgnoreController
}

async function flushAsyncWork(): Promise<void> {
	for (let index = 0; index < 8; index++) {
		await Promise.resolve()
	}
}

describe("ripgrep search lifecycle", () => {
	beforeEach(() => {
		spawnMock.mockReset()
		resetRipgrepSlotsForTesting()
	})

	afterEach(() => {
		vi.useRealTimers()
		resetRipgrepSlotsForTesting()
		vi.restoreAllMocks()
	})

	it.each([
		undefined,
		"*",
		"**",
		"**/*",
	])("treats catch-all pattern %s as no file filter so ignore pruning remains authoritative", async (filePattern) => {
		const stub = createRipgrepStub()
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => stub.close())
			return stub.process
		})

		await regexSearchFiles("/workspace", "/workspace", "BUGFIX-073", filePattern, scanController())

		const args = spawnMock.mock.calls[0]?.[1] as string[]
		expect(args).not.toContain("--hidden")
		expect(args).not.toContain("--glob")
		expect(args).toContain("--ignore-file")
	})

	it("keeps a restrictive file pattern as a ripgrep pre-filter", async () => {
		const stub = createRipgrepStub()
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => stub.close())
			return stub.process
		})

		await regexSearchFiles("/workspace", "/workspace", "needle", "*.ts", scanController())

		const args = spawnMock.mock.calls[0]?.[1] as string[]
		const globIndex = args.indexOf("--glob")
		expect(globIndex).toBeGreaterThanOrEqual(0)
		expect(args[globIndex + 1]).toBe("*.ts")
	})

	it("aborts and kills a search after the ten-minute deadline", async () => {
		vi.useFakeTimers()
		const stub = createRipgrepStub()
		spawnMock.mockReturnValue(stub.process)

		const pending = regexSearchFiles("/workspace", "/workspace", "BUGFIX-073", "*")
		const outcomePromise = pending.catch((error: unknown) => error)
		await flushAsyncWork()
		expect(spawnMock).toHaveBeenCalledOnce()

		await vi.advanceTimersByTimeAsync(RIPGREP_SEARCH_TIMEOUT_MS)
		const outcome = await outcomePromise

		expect(stub.kill).toHaveBeenCalledWith("SIGKILL")
		expect(outcome).toBeInstanceOf(RipgrepSearchTimeoutError)
		expect((outcome as Error).message).toContain("10 minutes")
		expect(activeRipgrepProcesses()).toBe(0)
	})
})
