import path from "node:path"
import { createBirpcClient } from "./rpc.mjs"

export const DEFAULT_PORT = 51205
export const DEFAULT_HOST = "localhost"
export const DEFAULT_BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/__vitest__/`

const RUNNING_STATES = new Set(["run", "running", "queued"])
const FAILED_STATES = new Set(["fail", "failed"])
const PASSED_STATES = new Set(["pass", "passed"])
const SKIPPED_STATES = new Set(["skip", "skipped", "todo"])

export function normalizeBaseUrl(input = process.env.VITEST_UI_URL || DEFAULT_BASE_URL) {
	const url = new URL(input)
	if (!url.pathname.endsWith("/")) {
		url.pathname += "/"
	}
	if (!url.pathname.endsWith("__vitest__/")) {
		url.pathname = path.posix.join(url.pathname, "__vitest__") + "/"
	}
	return url.toString()
}

function comparableIdentityPath(value, platform = process.platform) {
	const resolved = path.resolve(String(value || ""))
	return platform === "win32" ? resolved.toLowerCase() : resolved
}

/** Build the checkout identity exposed by one Vitest UI server. */
export function createVitestUiIdentity(config) {
	if (!config?.root) {
		throw new Error("Vitest UI did not report a repository root")
	}
	const root = path.resolve(config.root)
	const configFile =
		typeof config.configFile === "string" && config.configFile
			? path.resolve(path.isAbsolute(config.configFile) ? config.configFile : path.join(root, config.configFile))
			: undefined
	return { root, configFile }
}

/** Read the checkout identity through the Vitest UI RPC client. */
export async function getVitestUiIdentity(client) {
	return createVitestUiIdentity(await client.getConfig())
}

/** Compare checkout roots using platform-appropriate path semantics. */
export function isSameVitestUiRoot(actualRoot, expectedRoot, platform = process.platform) {
	return comparableIdentityPath(actualRoot, platform) === comparableIdentityPath(expectedRoot, platform)
}

/** Compare the repository root and, when known, the selected Vitest config. */
export function isSameVitestUiIdentity(actual, expected, platform = process.platform) {
	if (!isSameVitestUiRoot(actual?.root, expected?.root, platform)) return false
	if (!expected?.configFile) return true
	return Boolean(actual?.configFile) && isSameVitestUiRoot(actual.configFile, expected.configFile, platform)
}

function toWebSocketUrl(baseUrl, token) {
	const url = new URL(baseUrl)
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
	url.pathname = "/__vitest_api__"
	url.search = `?token=${encodeURIComponent(token || "0")}`
	return url.toString()
}

async function getApiToken(baseUrl, timeoutMs = 15_000) {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(new Error(`Timed out fetching Vitest UI at ${baseUrl}`)), timeoutMs)
	timeout.unref?.()
	try {
		const response = await fetch(baseUrl, { signal: controller.signal })
		if (!response.ok) {
			throw new Error(`Failed to fetch Vitest UI at ${baseUrl}: ${response.status} ${response.statusText}`)
		}
		const html = await response.text()
		const token = html.match(/window\.VITEST_API_TOKEN\s*=\s*"([^"]+)"/)?.[1]
		if (!token) {
			throw new Error(`Vitest UI token was not found in ${baseUrl}`)
		}
		return token
	} finally {
		clearTimeout(timeout)
	}
}

function waitForOpen(socket, timeoutMs) {
	return new Promise((resolve, reject) => {
		if (socket.readyState === WebSocket.OPEN) {
			resolve()
			return
		}

		const timeout = setTimeout(() => {
			cleanup()
			reject(new Error(`Timed out connecting to ${socket.url}`))
		}, timeoutMs)
		timeout.unref?.()

		const cleanup = () => {
			clearTimeout(timeout)
			socket.removeEventListener("open", onOpen)
			socket.removeEventListener("error", onError)
		}
		const onOpen = () => {
			cleanup()
			resolve()
		}
		const onError = () => {
			cleanup()
			reject(new Error(`Failed to connect to ${socket.url}`))
		}

		socket.addEventListener("open", onOpen)
		socket.addEventListener("error", onError)
	})
}

export async function connectVitestUi(options = {}) {
	if (typeof WebSocket !== "function") {
		throw new Error("This script requires a Node.js runtime with global WebSocket support.")
	}

	const baseUrl = normalizeBaseUrl(options.url)
	const connectTimeoutMs = options.connectTimeoutMs || 15_000
	const token = await getApiToken(baseUrl, connectTimeoutMs)
	const socket = new WebSocket(toWebSocketUrl(baseUrl, token))
	const state = {
		lastFinishedAt: 0,
		lastUpdateAt: 0,
	}

	const rpc = createBirpcClient({
		socket,
		timeoutMs: options.rpcTimeoutMs ?? 60_000,
		handlers: {
			onTaskUpdate() {
				state.lastUpdateAt = Date.now()
			},
			onCollected() {
				state.lastUpdateAt = Date.now()
			},
			onPathsCollected() {
				state.lastUpdateAt = Date.now()
			},
			onSpecsCollected() {
				state.lastUpdateAt = Date.now()
			},
			onFinished() {
				state.lastFinishedAt = Date.now()
				state.lastUpdateAt = state.lastFinishedAt
			},
			onFinishedReportCoverage() {},
			onTestAnnotate() {},
			onUserConsoleLog() {},
			onUnhandledError() {},
			onAfterSuiteRun() {},
			onCancel() {},
			sendLog() {},
			snapshotSaved() {},
		},
	})

	await waitForOpen(socket, connectTimeoutMs)

	return {
		baseUrl,
		socketUrl: socket.url,
		state,
		rpc,
		async getFiles() {
			return rpc.call("getFiles")
		},
		async getPaths() {
			return rpc.call("getPaths")
		},
		async getConfig() {
			return rpc.call("getConfig")
		},
		async getUnhandledErrors() {
			return rpc.call("getUnhandledErrors")
		},
		async rerun(filepaths, resetTestNamePattern = true) {
			return rpc.call("rerun", filepaths, resetTestNamePattern)
		},
		async rerunTask(taskId) {
			return rpc.call("rerunTask", taskId)
		},
		close() {
			rpc.close()
			socket.close()
		},
	}
}

function normalizePathForMatch(value) {
	return String(value || "").replace(/\\/g, "/")
}

export function getTaskState(task) {
	return task?.result?.state || "unknown"
}

export function walkTasks(task, callback, ancestors = []) {
	if (!task) {
		return
	}
	callback(task, ancestors)
	for (const child of task.tasks || []) {
		walkTasks(child, callback, [...ancestors, task])
	}
}

export function hasState(task, predicate) {
	let found = false
	walkTasks(task, (current) => {
		if (predicate(getTaskState(current), current)) {
			found = true
		}
	})
	return found
}

function hasUnknownRunnableTask(file) {
	let sawRunnableTask = false
	let sawUnknownTask = false
	walkTasks(file, (task) => {
		if (task === file || task.type !== "test") return
		sawRunnableTask = true
		if (getTaskState(task) === "unknown") sawUnknownTask = true
	})
	return sawUnknownTask || (!sawRunnableTask && getTaskState(file) === "unknown")
}

export function classifyFile(file) {
	if (hasState(file, (state) => RUNNING_STATES.has(state))) return "running"
	if (hasState(file, (state) => FAILED_STATES.has(state))) return "fail"
	if (hasUnknownRunnableTask(file)) return "unknown"
	if (hasState(file, (state) => PASSED_STATES.has(state))) return "pass"
	if (hasState(file, (state) => SKIPPED_STATES.has(state))) return "skip"
	return "unknown"
}

export function summarizeFiles(files) {
	const summary = {
		total: files.length,
		fail: 0,
		pass: 0,
		running: 0,
		skip: 0,
		unknown: 0,
	}

	for (const file of files) {
		summary[classifyFile(file)]++
	}

	return summary
}

function normalizeFilter(filter = "all") {
	const value = String(filter).toLowerCase()
	if (value === "success" || value === "passed") return "pass"
	if (value === "failed") return "fail"
	if (value === "run") return "running"
	return value
}

export function filterFiles(files, filter = "all") {
	const normalized = normalizeFilter(filter)
	if (normalized === "all") {
		return files
	}
	return files.filter((file) => classifyFile(file) === normalized)
}

const MAX_ERROR_FIELD_CHARS = 4_000
const MAX_FAILURES = 50

function boundedText(value) {
	if (value === undefined || value === null) return undefined
	const text = typeof value === "string" ? value : String(value)
	return text.length <= MAX_ERROR_FIELD_CHARS ? text : `${text.slice(0, MAX_ERROR_FIELD_CHARS)}\n…[truncated]`
}

function simplifyError(error) {
	return {
		name: boundedText(error?.name),
		message: boundedText(error?.message || String(error)),
		stack: boundedText(error?.stack),
		diff: boundedText(error?.diff),
		actual: boundedText(error?.actual),
		expected: boundedText(error?.expected),
	}
}

export function taskFullName(task, ancestors = []) {
	return [...ancestors, task]
		.filter((item) => item?.type !== "file")
		.map((item) => item.name)
		.filter(Boolean)
		.join(" > ")
}

export function collectFailures(files, { includeContainers = false } = {}) {
	const failures = []
	for (const file of files) {
		walkTasks(file, (task, ancestors) => {
			if (failures.length >= MAX_FAILURES || !FAILED_STATES.has(getTaskState(task))) {
				return
			}
			if (!includeContainers && task.type !== "test") {
				return
			}
			failures.push({
				file: file.filepath,
				projectName: file.projectName,
				taskId: task.id,
				type: task.type,
				name: task.name,
				fullName: taskFullName(task, ancestors),
				errors: (task.result?.errors || []).map(simplifyError),
			})
		})
	}
	return failures
}

export function simplifyFile(file, { includeTasks = false } = {}) {
	const output = {
		id: file.id,
		filepath: file.filepath,
		name: file.name,
		projectName: file.projectName,
		typecheck: file.meta?.typecheck,
		state: classifyFile(file),
		duration: file.result?.duration,
		errors: (file.result?.errors || []).map(simplifyError),
	}
	if (includeTasks) {
		const tasks = []
		walkTasks(file, (task, ancestors) => {
			if (task === file) {
				return
			}
			tasks.push({
				id: task.id,
				type: task.type,
				name: task.name,
				fullName: taskFullName(task, ancestors),
				state: getTaskState(task),
				duration: task.result?.duration,
				errors: (task.result?.errors || []).map(simplifyError),
			})
		})
		output.tasks = tasks
	}
	return output
}

export function matchFile(file, pattern) {
	const filepath = normalizePathForMatch(file.filepath)
	const input = normalizePathForMatch(pattern)
	const resolvedInput = normalizePathForMatch(path.resolve(pattern))
	return filepath === input || filepath === resolvedInput || filepath.endsWith(input) || filepath.includes(input)
}

function toMatcher(pattern, exact = false) {
	if (pattern instanceof RegExp) {
		return (value) => pattern.test(value)
	}
	const text = String(pattern || "")
	const regex = text.match(/^\/(.+)\/([a-z]*)$/i)
	if (regex) {
		const compiled = new RegExp(regex[1], regex[2])
		return (value) => compiled.test(value)
	}
	if (exact) {
		return (value) => value === text
	}
	const lower = text.toLowerCase()
	return (value) => value.toLowerCase().includes(lower)
}

export function findMatchingFiles(files, pattern) {
	return files.filter((file) => matchFile(file, pattern))
}

export function findMatchingTasks(files, { file, testName, taskId, exact = false } = {}) {
	const matchingFiles = file ? findMatchingFiles(files, file) : files
	const matches = []
	const nameMatches = toMatcher(testName || "", exact)

	for (const currentFile of matchingFiles) {
		walkTasks(currentFile, (task, ancestors) => {
			if (task === currentFile) {
				return
			}
			if (taskId && task.id === taskId) {
				matches.push({ file: currentFile, task, ancestors })
				return
			}
			if (!testName) {
				return
			}
			const fullName = taskFullName(task, ancestors)
			if (nameMatches(task.name || "") || nameMatches(fullName)) {
				matches.push({ file: currentFile, task, ancestors })
			}
		})
	}

	return matches
}

function inspectCollection(targetPaths, files) {
	const expectedPaths = new Set(targetPaths.map(normalizePathForMatch).filter(Boolean))
	const collectedPaths = new Set(files.map((file) => normalizePathForMatch(file.filepath)).filter(Boolean))
	const missingPaths = [...expectedPaths].filter((expectedPath) => !collectedPaths.has(expectedPath))
	return {
		expectedFileCount: expectedPaths.size,
		collectedFileCount: collectedPaths.size,
		missingPaths,
		summary: summarizeFiles(files),
	}
}

/** Trigger one initial run when Vitest discovered paths but left every collected file unknown. */
export async function ensureInitialRun(client, { timeoutMs = 15_000, pollMs = 500, stablePollCount = 3 } = {}) {
	const started = Date.now()
	let stableSignature
	let stableCount = 0
	let lastCollection = inspectCollection([], [])

	while (Date.now() - started < timeoutMs) {
		const [targetPaths, files] = await Promise.all([client.getPaths(), client.getFiles()])
		lastCollection = inspectCollection(targetPaths, files)
		const { summary } = lastCollection
		const runAlreadyStarted = summary.running + summary.pass + summary.fail + summary.skip > 0
		const collectionComplete = lastCollection.expectedFileCount > 0 && lastCollection.missingPaths.length === 0
		const collectionSettled = collectionComplete && summary.unknown === 0

		if (collectionSettled || runAlreadyStarted) {
			return { triggered: false, collection: lastCollection }
		}

		if (lastCollection.expectedFileCount > 0 && summary.unknown === summary.total) {
			const signature = `${lastCollection.expectedFileCount}:${lastCollection.collectedFileCount}:${lastCollection.missingPaths.length}`
			stableCount = signature === stableSignature ? stableCount + 1 : 1
			stableSignature = signature
			if (stableCount >= stablePollCount) {
				await client.rerun(targetPaths, true)
				return { triggered: true, collection: lastCollection, targets: targetPaths }
			}
		} else {
			stableSignature = undefined
			stableCount = 0
		}

		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}

	throw new Error(
		`Vitest UI did not expose a runnable initial collection within ${timeoutMs}ms. Collected ${lastCollection.collectedFileCount}/${lastCollection.expectedFileCount} paths; missing=${lastCollection.missingPaths.length}. Last summary: ${JSON.stringify(lastCollection.summary)}`,
	)
}

function assertKnownCollection(collection, { allowUnknown = false } = {}) {
	if (collection.expectedFileCount === 0) {
		throw new Error("Vitest UI has not discovered any test paths")
	}
	if (collection.missingPaths.length > 0) {
		throw new Error(
			`Vitest UI collection is incomplete. Missing ${collection.missingPaths.length} paths: ${collection.missingPaths.slice(0, 5).join(", ")}`,
		)
	}
	if (!allowUnknown && collection.summary.unknown > 0) {
		throw new Error(`Vitest UI collection contains ${collection.summary.unknown} unknown files`)
	}
}

/** Read the current collection while rejecting empty, missing, or unknown results by default. */
export async function readKnownFiles(client, { allowUnknown = false } = {}) {
	const [targetPaths, files] = await Promise.all([client.getPaths(), client.getFiles()])
	assertKnownCollection(inspectCollection(targetPaths, files), { allowUnknown })
	return files
}

/** Reject a result snapshot when Vitest recorded errors outside individual files. */
export async function assertNoUnhandledErrors(client) {
	const errors = (await client.getUnhandledErrors()).map(simplifyError)
	if (errors.length > 0) {
		throw new Error(`Vitest reported ${errors.length} unhandled errors: ${errors.map((error) => error.message).join(" | ")}`)
	}
}

export async function waitForIdle(client, { timeoutMs = 180_000, pollMs = 1_500, since = 0, allowUnknown = false } = {}) {
	const started = Date.now()
	let lastFiles = []
	let lastCollection = inspectCollection([], lastFiles)

	while (Date.now() - started < timeoutMs) {
		const [targetPaths, files] = await Promise.all([client.getPaths(), client.getFiles()])
		lastFiles = files
		lastCollection = inspectCollection(targetPaths, files)
		const collectionComplete = lastCollection.expectedFileCount > 0 && lastCollection.missingPaths.length === 0
		if (
			collectionComplete &&
			lastCollection.summary.running === 0 &&
			(allowUnknown || lastCollection.summary.unknown === 0) &&
			(!since || client.state.lastFinishedAt >= since)
		) {
			return lastFiles
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}

	throw new Error(
		`Timed out waiting for Vitest UI to become idle after ${timeoutMs}ms. Collected ${lastCollection.collectedFileCount}/${lastCollection.expectedFileCount} paths; missing=${lastCollection.missingPaths.length}. Last summary: ${JSON.stringify(lastCollection.summary)}`,
	)
}

export async function rerunWithScope(client, options = {}) {
	const scope = options.scope || "all"
	const startedAt = Date.now()

	if (scope === "all") {
		const paths = await client.getPaths()
		if (paths.length === 0) throw new Error("Vitest UI has not discovered any test paths to rerun")
		await client.rerun(paths, true)
		return { scope, startedAt, targets: paths }
	}

	const files = await client.getFiles()

	if (scope === "failed" || scope === "fail") {
		const failedFiles = filterFiles(files, "fail")
		await client.rerun(
			failedFiles.map((file) => file.filepath),
			false,
		)
		return { scope: "failed", startedAt, targets: failedFiles.map((file) => file.filepath) }
	}

	if (scope === "file") {
		if (!options.file) {
			throw new Error("rerun file requires --file <path>")
		}
		const matchingFiles = findMatchingFiles(files, options.file)
		if (!matchingFiles.length) {
			throw new Error(`No Vitest file matched "${options.file}"`)
		}
		if (matchingFiles.length > 1 && !options.allMatches) {
			throw new Error(`Multiple files matched "${options.file}": ${matchingFiles.map((file) => file.filepath).join(", ")}`)
		}
		await client.rerun(
			matchingFiles.map((file) => file.filepath),
			false,
		)
		return { scope, startedAt, targets: matchingFiles.map((file) => file.filepath) }
	}

	if (scope === "task" || scope === "test") {
		const matches = findMatchingTasks(files, {
			file: options.file,
			testName: options.testName,
			taskId: options.taskId,
			exact: options.exact,
		})
		if (!matches.length) {
			throw new Error(`No Vitest task matched "${options.taskId || options.testName}"`)
		}
		if (matches.length > 1 && !options.allMatches) {
			const names = matches.slice(0, 10).map((match) => `${match.task.id} ${taskFullName(match.task, match.ancestors)}`)
			throw new Error(`Multiple tasks matched. Narrow the query or pass --all-matches:\n${names.join("\n")}`)
		}
		for (const match of matches) {
			await client.rerunTask(match.task.id)
		}
		return {
			scope,
			startedAt,
			targets: matches.map((match) => ({
				file: match.file.filepath,
				taskId: match.task.id,
				name: taskFullName(match.task, match.ancestors),
			})),
		}
	}

	throw new Error(`Unknown rerun scope "${scope}"`)
}
