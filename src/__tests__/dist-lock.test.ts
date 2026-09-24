import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

/**
 * Behavior of the cross-process guard over the shared `dist/` build output.
 *
 * The lock module resolves its paths from its own file location, so it always
 * targets the real repository `dist/`. Driving it through child processes keeps
 * these tests away from that directory's live state and exercises the property
 * that actually matters: two operating-system processes reaching the same
 * conclusion about who owns the build output.
 */

const execFileAsync = promisify(execFile)

const PROJECT_ROOT = process.cwd()
const RUNNER_PATH = path.join(PROJECT_ROOT, "scripts", "with-dist-lock.mjs")
const LOCK_MODULE_PATH = path.join(PROJECT_ROOT, "scripts", "dist-lock.mjs")
const DIST_LOCK_ROOT = path.join(PROJECT_ROOT, "dist", ".e2e-lock")
const WRITER_ENTRY_PATH = path.join(DIST_LOCK_ROOT, "writer.json")
const READERS_DIR = path.join(DIST_LOCK_ROOT, "readers")

interface CommandResult {
	exitCode: number
	stdout: string
	stderr: string
}

/**
 * Run a command and capture its outcome instead of throwing on failure.
 *
 * Refusal is the behavior under test, so a non-zero exit is an expected result
 * rather than an error.
 */
async function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<CommandResult> {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, {
			cwd: PROJECT_ROOT,
			env: { ...process.env, ...env },
		})
		return { exitCode: 0, stdout, stderr }
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string }
		return { exitCode: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" }
	}
}

/** Run the lock runner with a trivial child command. */
async function runWithLock(mode: "--exclusive" | "--shared", runId: string): Promise<CommandResult> {
	return run(process.execPath, [RUNNER_PATH, mode, "--", process.execPath, "--version"], {
		DLINE_E2E_RUN_ID: runId,
	})
}

/**
 * Acquire a lock in-process and report the outcome as JSON.
 *
 * Used to stage a holder whose process has already exited, which is how a
 * crashed run leaves its entry behind.
 */
async function acquireAndExit(mode: "exclusive" | "shared", runId: string, release: boolean): Promise<CommandResult> {
	const moduleUrl = new URL(`file://${LOCK_MODULE_PATH.replaceAll("\\", "/")}`).href
	const source = `
		const { acquireDistLock } = await import(${JSON.stringify(moduleUrl)})
		const release = acquireDistLock(${JSON.stringify(mode)}, "staged holder")
		if (${release}) release()
		console.log("acquired")
	`
	return run(process.execPath, ["--input-type=module", "-e", source], { DLINE_E2E_RUN_ID: runId })
}

async function readEntryNames(directory: string): Promise<string[]> {
	try {
		return await fs.readdir(directory)
	} catch {
		return []
	}
}

async function writeStaleEntry(entryPath: string, contents: string): Promise<void> {
	await fs.mkdir(path.dirname(entryPath), { recursive: true })
	await fs.writeFile(entryPath, contents, "utf8")
}

describe("dist build lock", () => {
	it("releases the lock after the wrapped command exits", async () => {
		const first = await runWithLock("--exclusive", "dist-lock-sequential-a")
		expect(first.exitCode, first.stderr).toBe(0)

		// A lock that outlived its command would make every later build fail.
		const second = await runWithLock("--exclusive", "dist-lock-sequential-b")
		expect(second.exitCode, second.stderr).toBe(0)

		expect(await readEntryNames(READERS_DIR)).toEqual([])
	})

	it("allows several test runs to share one prepared build", async () => {
		const results = await Promise.all([
			runWithLock("--shared", "dist-lock-shared-a"),
			runWithLock("--shared", "dist-lock-shared-b"),
			runWithLock("--shared", "dist-lock-shared-c"),
		])

		for (const result of results) {
			expect(result.exitCode, result.stderr).toBe(0)
		}
	})

	it("keeps the lock directories while another reader is between directory setup and its claim", async () => {
		const moduleUrl = new URL(`file://${LOCK_MODULE_PATH.replaceAll("\\", "/")}`).href
		const source = `
			import fs from "node:fs"
			const { acquireSharedDistLock } = await import(${JSON.stringify(moduleUrl)})
			const releaseFirst = acquireSharedDistLock("first reader")
			const originalMkdir = fs.mkdirSync
			fs.mkdirSync = (...args) => {
				const result = originalMkdir(...args)
				if (args[0] === ${JSON.stringify(READERS_DIR)}) {
					fs.mkdirSync = originalMkdir
					releaseFirst()
				}
				return result
			}
			try {
				const releaseSecond = acquireSharedDistLock("second reader")
				releaseSecond()
				console.log("second reader acquired")
			} finally {
				fs.mkdirSync = originalMkdir
				releaseFirst()
			}
		`
		const result = await run(process.execPath, ["--input-type=module", "-e", source], {
			DLINE_E2E_RUN_ID: "dist-lock-directory-race",
		})
		expect(result.exitCode, result.stderr).toBe(0)
		expect(result.stdout).toContain("second reader acquired")
	})

	it("refuses a build while another build owns dist", async () => {
		await acquireAndExit("exclusive", "dist-lock-live-writer", false)
		// The staged process exited, so revive the entry with a live PID: this
		// process is alive for the duration of the assertion below.
		await writeStaleEntry(
			WRITER_ENTRY_PATH,
			`${JSON.stringify({
				pid: process.pid,
				runId: "dist-lock-live-writer",
				command: "staged build",
				startedAt: new Date().toISOString(),
			})}\n`,
		)

		try {
			const blocked = await runWithLock("--exclusive", "dist-lock-blocked-build")
			expect(blocked.exitCode).toBe(1)
			expect(blocked.stderr).toContain("Another build owns dist/")
			expect(blocked.stderr).toContain("dist-lock-live-writer")
		} finally {
			await fs.rm(WRITER_ENTRY_PATH, { force: true })
		}
	})

	it("refuses a test run while a build owns dist", async () => {
		await writeStaleEntry(
			WRITER_ENTRY_PATH,
			`${JSON.stringify({
				pid: process.pid,
				runId: "dist-lock-live-build",
				command: "staged build",
				startedAt: new Date().toISOString(),
			})}\n`,
		)

		try {
			const blocked = await runWithLock("--shared", "dist-lock-blocked-run")
			expect(blocked.exitCode).toBe(1)
			expect(blocked.stderr).toContain("A build currently owns dist/")
		} finally {
			await fs.rm(WRITER_ENTRY_PATH, { force: true })
		}
	})

	it("refuses a build while a test run is still reading dist", async () => {
		const readerEntryPath = path.join(READERS_DIR, "dist-lock-live-reader.json")
		await writeStaleEntry(
			readerEntryPath,
			`${JSON.stringify({
				pid: process.pid,
				runId: "dist-lock-live-reader",
				command: "staged run",
				startedAt: new Date().toISOString(),
			})}\n`,
		)

		try {
			const blocked = await runWithLock("--exclusive", "dist-lock-blocked-by-reader")
			expect(blocked.exitCode).toBe(1)
			expect(blocked.stderr).toContain("still reading dist/")
			expect(blocked.stderr).toContain("dist-lock-live-reader")

			// A refused build must not leave its own claim behind, or the next
			// build would report a phantom holder.
			await expect(fs.access(WRITER_ENTRY_PATH)).rejects.toThrow()
		} finally {
			await fs.rm(readerEntryPath, { force: true })
		}
	})

	it("recovers from entries left behind by a crashed run", async () => {
		// Staging a holder that acquires without releasing and then exits leaves a
		// writer entry owned by a PID that is genuinely gone. A hard-coded PID
		// cannot express that: PID 1 exists on Linux, and an unprivileged
		// `kill(1, 0)` reports EPERM, which the lock correctly reads as alive.
		// A corrupt entry is what a process killed mid-write leaves behind.
		await acquireAndExit("exclusive", "crashed", false)
		await writeStaleEntry(path.join(READERS_DIR, "crashed-reader.json"), "{ truncated")

		const recovered = await runWithLock("--exclusive", "dist-lock-after-crash")
		expect(recovered.exitCode, recovered.stderr).toBe(0)
		expect(await readEntryNames(READERS_DIR)).toEqual([])
	})

	it("reports current holders without acquiring the lock", async () => {
		const idle = await run(process.execPath, [RUNNER_PATH, "--status"])
		expect(idle.exitCode, idle.stderr).toBe(0)
		expect(idle.stdout).toContain("dist/ is idle")

		// Inspecting must not take the lock, or status would block a real build.
		const build = await runWithLock("--exclusive", "dist-lock-after-status")
		expect(build.exitCode, build.stderr).toBe(0)
	})

	it("rejects an invocation without a mode or command", async () => {
		const missingMode = await run(process.execPath, [RUNNER_PATH, "--", process.execPath, "--version"])
		expect(missingMode.exitCode).toBe(1)
		expect(missingMode.stderr).toContain("Specify --exclusive or --shared")

		const missingCommand = await run(process.execPath, [RUNNER_PATH, "--exclusive"])
		expect(missingCommand.exitCode).toBe(1)
		expect(missingCommand.stderr).toContain("Provide a command after '--'")
	})

	it("passes arguments containing spaces through to the wrapped command", async () => {
		// Playwright project selectors such as --project="work smoke" contain
		// spaces. The wrapper runs through a shell so Windows `.cmd` launchers
		// resolve, so arguments must survive that shell intact.
		// The inner `--` stops Node from claiming `--project=...` as its own option.
		const printArgs = "console.log(JSON.stringify(process.argv.slice(1)))"
		const result = await run(
			process.execPath,
			[RUNNER_PATH, "--shared", "--", process.execPath, "-e", printArgs, "--", "--project=work smoke", "a&b"],
			{ DLINE_E2E_RUN_ID: "dist-lock-arguments" },
		)

		expect(result.exitCode, result.stderr).toBe(0)
		expect(JSON.parse(result.stdout.trim())).toEqual(["--project=work smoke", "a&b"])
	})

	it("propagates the wrapped command's failure", async () => {
		const failed = await run(
			process.execPath,
			[RUNNER_PATH, "--shared", "--", process.execPath, "-e", "process.exit(42)"],
			{ DLINE_E2E_RUN_ID: "dist-lock-failure" },
		)
		expect(failed.exitCode).toBe(42)

		// The lock must be released even when the command fails.
		const next = await runWithLock("--exclusive", "dist-lock-after-failure")
		expect(next.exitCode, next.stderr).toBe(0)
	})
})
