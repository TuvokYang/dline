import { IgnoreController } from "@core/ignore/IgnoreController"
import * as childProcess from "child_process"
import { EventEmitter, Readable } from "stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { regexSearchFiles } from "../index"

/**
 * Searching a path the scan rules exclude.
 *
 * Two kinds of exclusion share one mechanism but not one authority. Repository
 * rules and the built-in directory floor prune the walk to bound its cost, and
 * a caller that names such a path has already bounded it. An `.agentignore`
 * entry states what the workspace forbids, and naming the path must not widen
 * it — otherwise the refusal merely pushes the agent towards a shell command
 * that ignores the boundary entirely.
 *
 * These tests assert both directions: the pruned path becomes searchable, and
 * the restricted one stays refused with no flag loosened on its behalf.
 */

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>()
	return { ...actual, spawn: spawnMock }
})

vi.mock("@/utils/fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/utils/fs")>()
	return { ...actual, getBinaryLocation: async () => "rg" }
})

const WORKSPACE = process.platform === "win32" ? "C:\\workspace" : "/workspace"

/** Join under the workspace using the platform separator ripgrep would see. */
function inWorkspace(...segments: string[]): string {
	const separator = process.platform === "win32" ? "\\" : "/"
	return [WORKSPACE, ...segments].join(separator)
}

/** A ripgrep stand-in that emits the given JSON lines and exits cleanly. */
function stubRipgrepProcess(lines: readonly string[]): childProcess.ChildProcess {
	const stdout = new Readable({ read() {} })
	const stderr = new Readable({ read() {} })
	const proc = Object.assign(new EventEmitter(), {
		stdout,
		stderr,
		kill: vi.fn(),
	}) as unknown as childProcess.ChildProcess

	setImmediate(() => {
		for (const line of lines) stdout.push(`${line}\n`)
		stdout.push(null)
		stderr.push(null)
		proc.emit("close", 0, null)
	})

	return proc
}

/** One ripgrep JSON match for a file, shaped like the real `--json` stream. */
function matchLine(absolutePath: string): string {
	return JSON.stringify({
		type: "match",
		data: {
			path: { text: absolutePath },
			lines: { text: "needle\n" },
			line_number: 1,
			absolute_offset: 0,
			submatches: [{ match: { text: "needle" }, start: 0, end: 6 }],
		},
	})
}

function lastSpawnArgs(): string[] {
	const call = spawnMock.mock.calls.at(-1)
	if (!call) throw new Error("ripgrep was never spawned")
	return call[1] as string[]
}

/**
 * An IgnoreController holding real compiled rules.
 *
 * The permission split is the behaviour under test, so the real class is used
 * rather than a stub that could encode the expected answer.
 */
async function controllerWith(agentRules: string | undefined): Promise<IgnoreController> {
	// The rule files live on disk in production; the compiled-rule behaviour is
	// what matters here, so only the file read is replaced. `loadSnapshot` then
	// compiles them through the ordinary path without leaving a watcher behind.
	const readRuleFile = async (fileName: string): Promise<string | undefined> =>
		fileName === ".agentignore" ? agentRules : undefined
	const prototype = IgnoreController.prototype as unknown as { readRuleFile: typeof readRuleFile }
	const original = prototype.readRuleFile
	prototype.readRuleFile = readRuleFile
	try {
		return await IgnoreController.loadSnapshot(WORKSPACE)
	} finally {
		prototype.readRuleFile = original
	}
}

describe("searching an excluded path", () => {
	beforeEach(() => {
		spawnMock.mockReset()
		spawnMock.mockImplementation(() => stubRipgrepProcess([]))
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("searches a pruned directory when the caller names it", async () => {
		const controller = await controllerWith(undefined)
		const target = inWorkspace("node_modules", "react-virtuoso", "dist")
		spawnMock.mockImplementation(() => stubRipgrepProcess([matchLine(inWorkspace("node_modules", "a.mjs"))]))

		const output = await regexSearchFiles(WORKSPACE, target, "needle", undefined, controller)

		expect(lastSpawnArgs()).toContain("--no-ignore-vcs")
		expect(output).toContain("1 result")
	})

	it("keeps pruning when the search starts above the excluded tree", async () => {
		const controller = await controllerWith(undefined)

		await regexSearchFiles(WORKSPACE, WORKSPACE, "needle", undefined, controller)

		const args = lastSpawnArgs()
		expect(args).not.toContain("--no-ignore-vcs")
		expect(args).not.toContain("--hidden")
	})

	it("drops a match the agent rules exclude even during a deliberate descent", async () => {
		// `-s` removes only the scan permission, so this is a restriction rather
		// than pruning, and it sits inside the tree being descended into.
		const controller = await controllerWith("node_modules/private/ -s\n")
		const target = inWorkspace("node_modules", "pkg")
		spawnMock.mockImplementation(() =>
			stubRipgrepProcess([
				matchLine(inWorkspace("node_modules", "private", "secret.js")),
				matchLine(inWorkspace("node_modules", "pkg", "index.js")),
			]),
		)

		const output = await regexSearchFiles(WORKSPACE, target, "needle", undefined, controller)

		expect(output).not.toContain("secret.js")
		expect(output).toContain("index.js")
	})

	it("does not loosen any flag for an agent-restricted directory", async () => {
		const controller = await controllerWith("vault/ -s\n")
		const target = inWorkspace("vault")

		await regexSearchFiles(WORKSPACE, target, "needle", undefined, controller)

		const args = lastSpawnArgs()
		expect(args).not.toContain("--no-ignore-vcs")
		expect(args).not.toContain("--hidden")
	})

	it("reports why a pruned path was searched", async () => {
		const controller = await controllerWith(undefined)
		const target = inWorkspace("dist")

		const output = await regexSearchFiles(WORKSPACE, target, "needle", undefined, controller)

		expect(output).toContain("dist")
		expect(output).toContain("normally pruned")
		expect(output).toContain(".agentignore")
	})

	it("says nothing about pruning for an ordinary search", async () => {
		const controller = await controllerWith(undefined)

		const output = await regexSearchFiles(WORKSPACE, inWorkspace("src"), "needle", undefined, controller)

		expect(output).not.toContain("normally pruned")
	})
})

describe("scan exclusion reasons", () => {
	it("separates a permission decision from a cost decision", async () => {
		const controller = await controllerWith("vault/ -s\n")

		expect(controller.describeScanExclusion(inWorkspace("vault"))).toBe("agent-restricted")
		expect(controller.describeScanExclusion(inWorkspace("node_modules"))).toBe("pruned")
		expect(controller.describeScanExclusion(inWorkspace("src"))).toBeUndefined()
	})

	it("reports the agent restriction when both would exclude the path", async () => {
		// Overriding the cost decision must not silently override the permission.
		const controller = await controllerWith("node_modules/ -s\n")

		expect(controller.describeScanExclusion(inWorkspace("node_modules"))).toBe("agent-restricted")
	})

	it("excludes only pruning from the agent scan rules", async () => {
		const controller = await controllerWith("vault/ -s\n")

		const agentOnly = controller.getAgentScanContent() ?? ""
		expect(agentOnly).toContain("vault/")
		expect(agentOnly).not.toContain("node_modules/")
	})
})
