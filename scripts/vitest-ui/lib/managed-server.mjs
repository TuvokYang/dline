import { spawn as spawnChild } from "node:child_process"
import path from "node:path"
import {
	connectVitestUi,
	DEFAULT_HOST,
	DEFAULT_PORT,
	ensureInitialRun,
	getVitestUiIdentity,
	isSameVitestUiIdentity,
	normalizeBaseUrl,
} from "./client.mjs"
import { buildVitestUiArgs } from "./server-args.mjs"
import { createVitestSpawnCommand } from "./spawn-command.mjs"

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Return whether the configured Vitest UI endpoint is accepting requests. */
export async function isReachable(url, fetchImpl = globalThis.fetch, timeoutMs = 5_000) {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), timeoutMs)
	timeout.unref?.()
	try {
		const response = await fetchImpl(url, { signal: controller.signal })
		return response.ok
	} catch {
		return false
	} finally {
		clearTimeout(timeout)
	}
}

/** Wait for Vitest UI while also surfacing child startup failures immediately. */
export async function waitForReachable(
	url,
	{ timeoutMs = 60_000, pollMs = 1_000, requestTimeoutMs = 5_000, fetchImpl = globalThis.fetch, getStartupError } = {},
) {
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		const startupError = getStartupError?.()
		if (startupError) throw startupError
		if (await isReachable(url, fetchImpl, requestTimeoutMs)) return
		await sleep(pollMs)
	}
	const startupError = getStartupError?.()
	if (startupError) throw startupError
	throw new Error(`Vitest UI did not become reachable at ${url} within ${timeoutMs}ms`)
}

function writeChunk(stream, chunk) {
	stream?.write(chunk)
}

/** Read one reachable server's repository identity and release its RPC connection. */
export async function readVitestUiIdentity(url, options = {}) {
	const connectImpl = options.connectImpl || connectVitestUi
	const client = await connectImpl({ url })
	try {
		return await getVitestUiIdentity(client)
	} finally {
		client.close()
	}
}

/** Ensure a newly started server dispatches an initial run before clients wait for idle. */
export async function bootstrapVitestUiInitialRun(url, options = {}) {
	const connectImpl = options.connectImpl || connectVitestUi
	const client = await connectImpl({
		url,
		connectTimeoutMs: options.connectTimeoutMs,
		rpcTimeoutMs: options.rpcTimeoutMs,
	})
	try {
		return await ensureInitialRun(client, {
			timeoutMs: options.timeoutMs,
			pollMs: options.pollMs,
			stablePollCount: options.stablePollCount,
		})
	} finally {
		client.close()
	}
}

function assertMatchingIdentity(url, actual, expected) {
	if (isSameVitestUiIdentity(actual, expected)) return
	throw new Error(
		`Vitest UI at ${url} belongs to root=${actual?.root || "unknown"} config=${actual?.configFile || "unknown"}, not root=${expected.root} config=${expected.configFile}. Configure a dedicated VITEST_UI_PORT or VITEST_UI_URL.`,
	)
}

/** Reuse a reachable repository-matched Vitest UI or start a local Vitest 4 UI process. */
export async function ensureVitestUiServer(options = {}) {
	const env = options.env || process.env
	const cwd = options.cwd || process.cwd()
	const configuredUrl = env.VITEST_UI_URL ? new URL(normalizeBaseUrl(env.VITEST_UI_URL)) : undefined
	const host = env.VITEST_UI_HOST || configuredUrl?.hostname || DEFAULT_HOST
	const port = Number(env.VITEST_UI_PORT || configuredUrl?.port || DEFAULT_PORT)
	const url = normalizeBaseUrl(configuredUrl?.toString() || `http://${host}:${port}/__vitest__/`)
	const fetchImpl = options.fetchImpl || globalThis.fetch
	const config = env.VITEST_UI_CONFIG || "vitest.config.ts"
	const expectedIdentity = {
		root: path.resolve(cwd),
		configFile: path.resolve(cwd, config),
	}

	if (await isReachable(url, fetchImpl)) {
		const identityReader = options.identityReader || readVitestUiIdentity
		const identity = await identityReader(url, { connectImpl: options.connectImpl })
		assertMatchingIdentity(url, identity, expectedIdentity)
		return { url, child: null, started: false, identity }
	}
	if (env.VITEST_UI_MCP_START === "false") {
		throw new Error(
			`Vitest UI is not reachable at ${url}. Start it with "npm run vitest:ui:server" or allow automatic startup.`,
		)
	}

	const vitestArgs = buildVitestUiArgs({ host, port, config })
	const spawnCommand = createVitestSpawnCommand({ cwd, execPath: options.execPath })
	const args = [...spawnCommand.args, ...vitestArgs]
	const stderr = options.stderr || process.stderr
	writeChunk(stderr, `[vitest-ui-mcp] starting: ${spawnCommand.file} ${args.join(" ")}\n`)

	let startupError
	const spawnImpl = options.spawnImpl || spawnChild
	const child = spawnImpl(spawnCommand.file, args, {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		...spawnCommand.options,
	})
	child.stdout?.on("data", (chunk) => writeChunk(stderr, chunk))
	child.stderr?.on("data", (chunk) => writeChunk(stderr, chunk))
	child.once("error", (error) => {
		startupError = new Error(`Failed to start Vitest UI: ${error.message}`, { cause: error })
	})
	child.once("exit", (code, signal) => {
		options.onExit?.(code, signal)
		if (code !== null || signal) {
			startupError = new Error(`Vitest UI exited before becoming reachable (code=${code ?? ""}, signal=${signal ?? ""})`)
		}
	})

	try {
		await waitForReachable(url, {
			timeoutMs: Number(env.VITEST_UI_MCP_START_TIMEOUT || 60_000),
			pollMs: options.pollMs,
			requestTimeoutMs: Number(env.VITEST_UI_MCP_REQUEST_TIMEOUT || 5_000),
			fetchImpl,
			getStartupError: () => startupError,
		})
		const identityReader = options.identityReader || readVitestUiIdentity
		const identity = await identityReader(url, { connectImpl: options.connectImpl })
		assertMatchingIdentity(url, identity, expectedIdentity)
		const initialRunBootstrap = options.initialRunBootstrap || bootstrapVitestUiInitialRun
		const initialRun = await initialRunBootstrap(url, {
			connectImpl: options.connectImpl,
			connectTimeoutMs: Number(env.VITEST_UI_MCP_START_TIMEOUT || 60_000),
			rpcTimeoutMs: Number(env.VITEST_UI_INITIAL_RUN_RPC_TIMEOUT || 30_000),
			timeoutMs: Number(env.VITEST_UI_INITIAL_RUN_TIMEOUT || 15_000),
			pollMs: options.initialRunPollMs,
			stablePollCount: options.initialRunStablePollCount,
		})
		return { url, child, started: true, identity, initialRun }
	} catch (error) {
		if (!child.killed && child.exitCode === null) child.kill("SIGTERM")
		throw error
	}
}
