#!/usr/bin/env node

/**
 * Run one command while holding a side of the `dist/` build lock.
 *
 * `dist/` is the single piece of E2E state that is not run-scoped, so two
 * concurrent E2E commands corrupt each other's bundle or VSIX. Wrapping the
 * npm scripts here keeps that coordination in one place instead of asking every
 * caller to remember the ordering rule.
 *
 * Usage:
 *   node scripts/with-dist-lock.mjs --exclusive -- <command> [args...]
 *   node scripts/with-dist-lock.mjs --shared -- <command> [args...]
 *   node scripts/with-dist-lock.mjs --status
 *
 * Use `--exclusive` for anything that writes `dist/` and `--shared` for a test
 * run that only reads it. The lock is held until the child exits, and it is
 * released on normal exit, failure, SIGINT, and SIGTERM alike.
 */

import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { acquireDistLock, DistLockUnavailableError, EXCLUSIVE_MODE, inspectDistLock, SHARED_MODE } from "./dist-lock.mjs"

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

const USAGE = `Usage:
  node scripts/with-dist-lock.mjs --exclusive -- <command> [args...]
  node scripts/with-dist-lock.mjs --shared -- <command> [args...]
  node scripts/with-dist-lock.mjs --status`

/**
 * @param {string} reason
 * @returns {never}
 */
function fail(reason) {
	console.error(`[dist-lock] ${reason}`)
	process.exit(1)
}

/**
 * Split the wrapper's own flags from the command that follows `--`.
 *
 * @param {string[]} argv
 * @returns {{ mode: "exclusive" | "shared" | null, status: boolean, command: string[] }}
 */
function parseArguments(argv) {
	/** @type {"exclusive" | "shared" | null} */
	let mode = null
	let status = false
	const separatorIndex = argv.indexOf("--")
	const flags = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex)
	const command = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1)

	for (const flag of flags) {
		switch (flag) {
			case "--exclusive":
				mode = EXCLUSIVE_MODE
				break
			case "--shared":
				mode = SHARED_MODE
				break
			case "--status":
				status = true
				break
			case "--help":
			case "-h":
				console.log(USAGE)
				process.exit(0)
				break
			default:
				fail(`Unknown argument '${flag}'.\n${USAGE}`)
		}
	}

	return { mode, status, command }
}

function reportStatus() {
	const { writer, readers } = inspectDistLock()
	if (!writer && readers.length === 0) {
		console.log("[dist-lock] dist/ is idle.")
		return
	}
	if (writer) {
		console.log(`[dist-lock] build holder: pid ${writer.pid}, run '${writer.runId}', command '${writer.command}'`)
	}
	for (const reader of readers) {
		console.log(`[dist-lock] test reader: pid ${reader.pid}, run '${reader.runId}', command '${reader.command}'`)
	}
}

/**
 * Quote one argument for the platform shell.
 *
 * The wrapped commands are shell launchers (`npm`, `playwright`, `vsce`), which
 * on Windows resolve through `.cmd` shims that `spawn` cannot execute directly.
 * A shell is therefore required, and passing an argument array alongside
 * `shell: true` concatenates the arguments unescaped - Node reports this as
 * DEP0190. Quoting here and passing one command string keeps arguments such as
 * `--project="work smoke"` intact.
 *
 * @param {string} argument
 * @returns {string}
 */
function quoteArgument(argument) {
	if (process.platform === "win32") {
		// cmd.exe ends a quoted run on the next quote, and doubling escapes one.
		return /[\s"^&|<>()]/.test(argument) ? `"${argument.replaceAll('"', '""')}"` : argument
	}
	// Single quotes suppress every POSIX expansion; a quote is closed, escaped, and reopened.
	return /[^\w@%+=:,./-]/.test(argument) ? `'${argument.replaceAll("'", "'\\''")}'` : argument
}

/**
 * Run the child to completion and resolve with how it terminated.
 *
 * A child killed by a signal is reported as such rather than coerced to an exit
 * code, so the wrapper can reproduce that termination for its own caller.
 *
 * @param {string[]} command
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null }>}
 */
function runChild(command) {
	return new Promise((resolve, reject) => {
		const child = spawn(command.map(quoteArgument).join(" "), {
			cwd: PROJECT_ROOT,
			stdio: "inherit",
			shell: true,
		})

		// Forward interrupts so the child can shut down before the lock is released;
		// releasing first would let a queued build start against a live test run.
		const forwardSignal = (signal) => () => {
			if (!child.killed) child.kill(signal)
		}
		const onSigint = forwardSignal("SIGINT")
		const onSigterm = forwardSignal("SIGTERM")
		process.on("SIGINT", onSigint)
		process.on("SIGTERM", onSigterm)

		const detach = () => {
			process.off("SIGINT", onSigint)
			process.off("SIGTERM", onSigterm)
		}

		child.on("error", (error) => {
			detach()
			reject(error)
		})
		child.on("close", (code, signal) => {
			detach()
			resolve({ code, signal })
		})
	})
}

const { mode, status, command } = parseArguments(process.argv.slice(2))

if (status) {
	reportStatus()
	process.exit(0)
}

if (!mode) fail(`Specify --exclusive or --shared.\n${USAGE}`)
if (command.length === 0) fail(`Provide a command after '--'.\n${USAGE}`)

let release
try {
	release = acquireDistLock(mode, command.join(" "))
} catch (error) {
	if (error instanceof DistLockUnavailableError) {
		fail(
			`${error.message}\n` +
				"Run one build at a time, then start concurrent test runs against that build. " +
				"See `npm run e2e:lock:status` to inspect the current holders.",
		)
	}
	throw error
}

try {
	const { code, signal } = await runChild(command)
	release()
	if (signal) {
		process.kill(process.pid, signal)
	} else {
		process.exit(code ?? 0)
	}
} catch (error) {
	release()
	fail(`Failed to run '${command.join(" ")}': ${error.message}`)
}
