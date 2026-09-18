#!/usr/bin/env node
import { spawn } from "node:child_process"
import { DEFAULT_HOST, DEFAULT_PORT } from "./lib/client.mjs"
import { bootstrapVitestUiInitialRun, waitForReachable } from "./lib/managed-server.mjs"
import { buildVitestUiArgs, parseServerArgs } from "./lib/server-args.mjs"
import { createVitestSpawnCommand } from "./lib/spawn-command.mjs"

const options = parseServerArgs(process.argv.slice(2), process.env, { host: DEFAULT_HOST, port: DEFAULT_PORT })
const args = buildVitestUiArgs(options)

const spawnCommand = createVitestSpawnCommand({ cwd: process.cwd() })
const spawnArgs = [...spawnCommand.args, ...args]
const url = `http://${options.host}:${options.port}/__vitest__/`
console.error(`[vitest-ui] starting: ${spawnCommand.file} ${spawnArgs.join(" ")}`)
console.error(`[vitest-ui] url: ${url}`)

const child = spawn(spawnCommand.file, spawnArgs, {
	cwd: process.cwd(),
	env: process.env,
	stdio: "inherit",
	...spawnCommand.options,
})

function shutdown(signal) {
	if (!child.killed) {
		child.kill(signal)
	}
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

void (async () => {
	await waitForReachable(url, {
		timeoutMs: Number(process.env.VITEST_UI_START_TIMEOUT || 60_000),
	})
	const initialRun = await bootstrapVitestUiInitialRun(url, {
		rpcTimeoutMs: Number(process.env.VITEST_UI_INITIAL_RUN_RPC_TIMEOUT || 30_000),
		timeoutMs: Number(process.env.VITEST_UI_INITIAL_RUN_TIMEOUT || 15_000),
	})
	console.error(
		initialRun.triggered
			? `[vitest-ui] dispatched initial run for ${initialRun.targets.length} discovered paths`
			: "[vitest-ui] initial run was already active or complete",
	)
})().catch((error) => {
	console.error(`[vitest-ui] failed to bootstrap initial run: ${error instanceof Error ? error.message : String(error)}`)
	shutdown("SIGTERM")
})

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal)
		return
	}
	process.exit(code ?? 0)
})
