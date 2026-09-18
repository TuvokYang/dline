import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import path from "node:path"
import test from "node:test"
import { ensureVitestUiServer, isReachable } from "./managed-server.mjs"

function createChild() {
	const child = new EventEmitter()
	child.stdout = new EventEmitter()
	child.stderr = new EventEmitter()
	child.killed = false
	child.exitCode = null
	child.kill = (signal) => {
		child.killed = true
		child.killSignal = signal
		return true
	}
	return child
}

test("bounds each readiness request instead of waiting forever", async () => {
	let aborted = false
	const reachable = await isReachable(
		"http://localhost:51205/__vitest__/",
		(_url, { signal }) =>
			new Promise((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						aborted = true
						reject(signal.reason)
					},
					{ once: true },
				)
			}),
		5,
	)

	assert.equal(reachable, false)
	assert.equal(aborted, true)
})

function createStderr() {
	let text = ""
	return {
		stream: { write: (chunk) => (text += String(chunk)) },
		read: () => text,
	}
}

test("reuses an already reachable Vitest UI from the same repository without spawning", async () => {
	let spawnCalls = 0
	const result = await ensureVitestUiServer({
		cwd: process.cwd(),
		env: { VITEST_UI_URL: "http://localhost:51205/__vitest__/" },
		fetchImpl: async () => ({ ok: true }),
		identityReader: async () => ({ root: process.cwd(), configFile: path.resolve("vitest.config.ts") }),
		spawnImpl: () => {
			spawnCalls++
			return createChild()
		},
	})

	assert.equal(result.started, false)
	assert.equal(result.child, null)
	assert.equal(result.url, "http://localhost:51205/__vitest__/")
	assert.equal(result.identity.root, process.cwd())
	assert.equal(spawnCalls, 0)
})

test("rejects a reachable Vitest UI owned by another repository", async () => {
	let spawnCalls = 0
	await assert.rejects(
		ensureVitestUiServer({
			cwd: process.cwd(),
			env: { VITEST_UI_URL: "http://localhost:51205/__vitest__/" },
			fetchImpl: async () => ({ ok: true }),
			identityReader: async () => ({ root: path.resolve("other-checkout") }),
			spawnImpl: () => {
				spawnCalls++
				return createChild()
			},
		}),
		/belongs to root=.*other-checkout.*not root=/,
	)
	assert.equal(spawnCalls, 0)
})

test("fails immediately when automatic startup is disabled and the UI is unreachable", async () => {
	let spawnCalls = 0
	await assert.rejects(
		ensureVitestUiServer({
			env: {
				VITEST_UI_URL: "http://localhost:51205/__vitest__/",
				VITEST_UI_MCP_START: "false",
			},
			fetchImpl: async () => ({ ok: false }),
			spawnImpl: () => {
				spawnCalls++
				return createChild()
			},
		}),
		/Start it with "npm run vitest:ui:server"/,
	)
	assert.equal(spawnCalls, 0)
})

test("starts the local Vitest 4 UI without a shell and waits for readiness", async () => {
	const child = createChild()
	const stderr = createStderr()
	let fetchCalls = 0
	let spawnCall
	let initialRunUrl
	const result = await ensureVitestUiServer({
		cwd: process.cwd(),
		execPath: "C:\\Program Files\\nodejs\\node.exe",
		env: {
			VITEST_UI_HOST: "127.0.0.1",
			VITEST_UI_PORT: "51208",
			VITEST_UI_CONFIG: "vitest.config.ts",
			VITEST_UI_MCP_START_TIMEOUT: "100",
		},
		fetchImpl: async () => ({ ok: ++fetchCalls >= 2 }),
		identityReader: async () => ({ root: process.cwd(), configFile: path.resolve("vitest.config.ts") }),
		initialRunBootstrap: async (url) => {
			initialRunUrl = url
			return { triggered: true, targets: ["one.test.ts"] }
		},
		pollMs: 0,
		stderr: stderr.stream,
		spawnImpl: (file, args, options) => {
			spawnCall = { file, args, options }
			return child
		},
	})

	assert.equal(result.started, true)
	assert.equal(result.child, child)
	assert.equal(result.url, "http://127.0.0.1:51208/__vitest__/")
	assert.equal(result.identity.root, process.cwd())
	assert.equal(result.identity.configFile, path.resolve("vitest.config.ts"))
	assert.equal(result.initialRun.triggered, true)
	assert.equal(initialRunUrl, result.url)
	assert.equal(spawnCall.file, "C:\\Program Files\\nodejs\\node.exe")
	assert.equal(spawnCall.options.shell, false)
	assert.equal(
		spawnCall.args[0].endsWith("node_modules\\vitest\\vitest.mjs") ||
			spawnCall.args[0].endsWith("node_modules/vitest/vitest.mjs"),
		true,
	)
	assert.deepEqual(spawnCall.args.slice(1), [
		"--ui",
		"--watch",
		"--no-open",
		"--api.host",
		"127.0.0.1",
		"--api.port",
		"51208",
		"--config",
		"vitest.config.ts",
	])
	assert.match(stderr.read(), /--api\.host 127\.0\.0\.1 --api\.port 51208/)
	assert.doesNotMatch(stderr.read(), /(?:^|\s)--host(?:\s|$)|(?:^|\s)--port(?:\s|$)/)
})

test("rejects and terminates a foreign server that wins the startup race", async () => {
	const child = createChild()
	let fetchCalls = 0
	await assert.rejects(
		ensureVitestUiServer({
			cwd: process.cwd(),
			env: { VITEST_UI_PORT: "51207", VITEST_UI_MCP_START_TIMEOUT: "100" },
			fetchImpl: async () => ({ ok: ++fetchCalls >= 2 }),
			identityReader: async () => ({
				root: path.resolve("foreign-checkout"),
				configFile: path.resolve("vitest.config.ts"),
			}),
			pollMs: 0,
			stderr: { write() {} },
			spawnImpl: () => child,
		}),
		/belongs to root=.*foreign-checkout/,
	)
	assert.equal(child.killed, true)
	assert.equal(child.killSignal, "SIGTERM")
})

test("surfaces a child startup exit before the reachability timeout", async () => {
	const child = createChild()
	const started = Date.now()
	await assert.rejects(
		ensureVitestUiServer({
			env: {
				VITEST_UI_PORT: "51209",
				VITEST_UI_MCP_START_TIMEOUT: "1000",
			},
			fetchImpl: async () => ({ ok: false }),
			pollMs: 1,
			stderr: { write() {} },
			spawnImpl: () => {
				queueMicrotask(() => child.emit("exit", 1, null))
				return child
			},
		}),
		/Vitest UI exited before becoming reachable \(code=1, signal=\)/,
	)
	assert.equal(Date.now() - started < 500, true)
})
