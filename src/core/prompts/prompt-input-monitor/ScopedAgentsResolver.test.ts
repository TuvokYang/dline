import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	applyScopedAgentsTurnBudget,
	resolveScopedAgents,
	SCOPED_AGENTS_FILE_MAX_BYTES,
	SCOPED_AGENTS_TURN_HARD_MAX_BYTES,
} from "./ScopedAgentsResolver"

const roots: string[] = []

async function workspace(files: Record<string, string | Buffer>): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "scoped-agents-"))
	roots.push(root)
	for (const [relativePath, content] of Object.entries(files)) {
		const absolutePath = path.join(root, relativePath)
		await fs.mkdir(path.dirname(absolutePath), { recursive: true })
		await fs.writeFile(absolutePath, content)
	}
	return root
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("resolveScopedAgents", () => {
	it("resolves only the target ancestor chain and does not require a root AGENTS.md", async () => {
		const root = await workspace({
			"packages/AGENTS.md": "packages",
			"packages/api/AGENTS.md": "api",
			"packages/web/AGENTS.md": "web",
			"packages/api/src/index.ts": "export {}",
		})

		const result = await resolveScopedAgents(
			[root],
			[{ absolutePath: path.join(root, "packages/api/src/index.ts"), kind: "file" }],
		)

		expect(result.candidates.map((candidate) => [candidate.relativePath, candidate.state, candidate.content])).toEqual([
			["packages/AGENTS.md", "present", "packages"],
			["packages/api/AGENTS.md", "present", "api"],
			["packages/api/src/AGENTS.md", "missing", undefined],
		])
	})

	it("deduplicates overlapping targets and chooses the deepest workspace root", async () => {
		const outer = await workspace({ "packages/AGENTS.md": "outer" })
		const inner = path.join(outer, "packages", "app")
		await fs.mkdir(path.join(inner, "src"), { recursive: true })
		await fs.writeFile(path.join(inner, "AGENTS.md"), "inner", "utf8")

		const target = path.join(inner, "src", "index.ts")
		const result = await resolveScopedAgents(
			[outer, inner],
			[
				{ absolutePath: target, kind: "file" },
				{ absolutePath: path.dirname(target), kind: "directory" },
			],
		)

		expect(result.candidates).toHaveLength(1)
		expect(result.candidates[0]).toMatchObject({
			workspaceRoot: inner,
			workspaceRootIndex: 1,
			relativePath: "src/AGENTS.md",
			state: "missing",
		})
	})

	it("limits each child file to 12,000 UTF-8 bytes without splitting characters", async () => {
		const root = await workspace({
			"pkg/AGENTS.md": `${"a".repeat(SCOPED_AGENTS_FILE_MAX_BYTES - 1)}😀tail`,
		})

		const result = await resolveScopedAgents([root], [{ absolutePath: path.join(root, "pkg", "file.ts"), kind: "file" }])
		const candidate = result.candidates[0]

		expect(candidate.state).toBe("present")
		expect(candidate.truncated).toBe(true)
		expect(candidate.contentBytes).toBeLessThanOrEqual(SCOPED_AGENTS_FILE_MAX_BYTES)
		expect(Buffer.from(candidate.content ?? "", "utf8").includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false)
	})
})

describe("applyScopedAgentsTurnBudget", () => {
	it("uses one deterministic 48,000-byte budget for all resolved scopes", async () => {
		const root = await workspace(
			Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`p${index}/AGENTS.md`, String(index).repeat(12_000)])),
		)
		const targets = Array.from({ length: 5 }, (_, index) => ({
			absolutePath: path.join(root, `p${index}`, "file.ts"),
			kind: "file" as const,
		}))
		const resolution = await resolveScopedAgents([root], targets)

		const first = applyScopedAgentsTurnBudget(resolution.candidates)
		const second = applyScopedAgentsTurnBudget([...resolution.candidates].reverse())

		expect(first.contentBytes).toBeLessThanOrEqual(SCOPED_AGENTS_TURN_HARD_MAX_BYTES)
		expect(first.omittedCount).toBeGreaterThan(0)
		expect(second).toEqual(first)
	})

	it("honors a stricter context allowance", async () => {
		const root = await workspace({ "pkg/AGENTS.md": "x".repeat(10_000) })
		const resolution = await resolveScopedAgents([root], [{ absolutePath: path.join(root, "pkg", "file.ts"), kind: "file" }])

		const result = applyScopedAgentsTurnBudget(resolution.candidates, 2_000)

		expect(result.contentBytes).toBeLessThanOrEqual(2_000)
		expect(result.entries[0]?.truncated).toBe(true)
	})
})
