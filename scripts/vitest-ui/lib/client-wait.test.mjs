import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import {
	assertNoUnhandledErrors,
	classifyFile,
	createVitestUiIdentity,
	ensureInitialRun,
	isSameVitestUiRoot,
	readKnownFiles,
	rerunWithScope,
	waitForIdle,
} from "./client.mjs"

function file(id, state) {
	return {
		id,
		filepath: `C:/repo/${id}.test.ts`,
		name: `${id}.test.ts`,
		projectName: "backend",
		type: "file",
		result: { state },
		tasks: [],
	}
}

test("ensureInitialRun dispatches discovered paths after an unknown collection stays stable", async () => {
	const reruns = []
	const client = {
		getPaths: async () => ["C:/repo/one.test.ts", "C:/repo/two.test.ts"],
		getFiles: async () => [file("one", "unknown")],
		rerun: async (paths, resetTestNamePattern) => {
			reruns.push({ paths, resetTestNamePattern })
		},
	}

	const result = await ensureInitialRun(client, { timeoutMs: 100, pollMs: 0, stablePollCount: 2 })

	assert.equal(result.triggered, true)
	assert.deepEqual(reruns, [
		{
			paths: ["C:/repo/one.test.ts", "C:/repo/two.test.ts"],
			resetTestNamePattern: true,
		},
	])
})

test("ensureInitialRun leaves an already started run unchanged", async () => {
	let rerunCalls = 0
	const client = {
		getPaths: async () => ["C:/repo/one.test.ts", "C:/repo/two.test.ts"],
		getFiles: async () => [file("one", "pass")],
		rerun: async () => {
			rerunCalls++
		},
	}

	const result = await ensureInitialRun(client, { timeoutMs: 100, pollMs: 0, stablePollCount: 1 })

	assert.equal(result.triggered, false)
	assert.equal(rerunCalls, 0)
})

test("waitForIdle waits until every discovered path has been collected", async () => {
	const batches = [
		[file("one", "pass")],
		[file("one", "pass"), file("two", "pass")],
		[file("one", "pass"), file("two", "pass"), file("three", "pass")],
	]
	let getFilesCalls = 0
	const client = {
		state: { lastFinishedAt: Date.now() },
		getPaths: async () => ["C:/repo/one.test.ts", "C:/repo/two.test.ts", "C:/repo/three.test.ts"],
		getFiles: async () => batches[Math.min(getFilesCalls++, batches.length - 1)],
	}

	const files = await waitForIdle(client, { timeoutMs: 100, pollMs: 0 })

	assert.equal(files.length, 3)
	assert.equal(getFilesCalls, 3)
})

test("waitForIdle reports collected and expected counts on timeout", async () => {
	const client = {
		state: { lastFinishedAt: 0 },
		getPaths: async () => ["C:/repo/one.test.ts", "C:/repo/two.test.ts"],
		getFiles: async () => [file("one", "pass")],
	}

	await assert.rejects(waitForIdle(client, { timeoutMs: 5, pollMs: 0 }), /Collected 1\/2 paths; missing=1/)
})

test("waitForIdle rejects unknown collection state unless explicitly allowed", async () => {
	const unknownFile = { ...file("one", "pass"), result: undefined }
	const client = {
		state: { lastFinishedAt: Date.now() },
		getPaths: async () => [unknownFile.filepath],
		getFiles: async () => [unknownFile],
	}

	await assert.rejects(waitForIdle(client, { timeoutMs: 5, pollMs: 0 }), /"unknown":1/)
	assert.deepEqual(await waitForIdle(client, { timeoutMs: 20, pollMs: 0, allowUnknown: true }), [unknownFile])
})

test("classifies a mixed passed and uncollected file as unknown", () => {
	const mixedFile = {
		...file("mixed", "pass"),
		tasks: [
			{ id: "passed", name: "passed", type: "test", result: { state: "pass" }, tasks: [] },
			{ id: "unknown", name: "unknown", type: "test", tasks: [] },
		],
	}

	assert.equal(classifyFile(mixedFile), "unknown")
})

test("readKnownFiles rejects empty and stale equal-count collections", async () => {
	await assert.rejects(
		readKnownFiles({ getPaths: async () => [], getFiles: async () => [] }),
		/has not discovered any test paths/,
	)
	await assert.rejects(
		readKnownFiles({
			getPaths: async () => ["C:/repo/one.test.ts", "C:/repo/two.test.ts"],
			getFiles: async () => [file("one", "pass"), file("three", "pass")],
		}),
		/Missing 1 paths: C:\/repo\/two.test.ts/,
	)
})

test("rejects global unhandled errors even when file results pass", async () => {
	await assert.rejects(
		assertNoUnhandledErrors({
			getUnhandledErrors: async () => [{ name: "Error", message: "global rejection" }],
		}),
		/Vitest reported 1 unhandled errors: global rejection/,
	)
	await assert.doesNotReject(assertNoUnhandledErrors({ getUnhandledErrors: async () => [] }))
})

test("normalizes Vitest UI identity and compares Windows roots case-insensitively", () => {
	const identity = createVitestUiIdentity({ root: process.cwd(), configFile: "vitest.config.ts" })

	assert.equal(identity.root, process.cwd())
	assert.equal(identity.configFile, path.resolve("vitest.config.ts"))
	assert.equal(isSameVitestUiRoot("C:/Repo/Dline", "c:/repo/dline", "win32"), true)
	assert.equal(isSameVitestUiRoot("/repo/one", "/repo/two", "linux"), false)
})

test("rerun all rejects an empty discovery result", async () => {
	await assert.rejects(
		rerunWithScope({ getPaths: async () => [], rerun: async () => undefined }, { scope: "all" }),
		/has not discovered any test paths to rerun/,
	)
})

test("rerun all dispatches every discovered path instead of only previously collected files", async () => {
	const reruns = []
	const client = {
		getFiles: async () => [file("one", "pass")],
		getPaths: async () => ["C:/repo/one.test.ts", "C:/repo/two.test.ts", "C:/repo/three.test.ts"],
		rerun: async (paths, resetTestNamePattern) => {
			reruns.push({ paths, resetTestNamePattern })
		},
	}

	const result = await rerunWithScope(client, { scope: "all" })

	assert.deepEqual(reruns, [
		{
			paths: ["C:/repo/one.test.ts", "C:/repo/two.test.ts", "C:/repo/three.test.ts"],
			resetTestNamePattern: true,
		},
	])
	assert.deepEqual(result.targets, ["C:/repo/one.test.ts", "C:/repo/two.test.ts", "C:/repo/three.test.ts"])
})
