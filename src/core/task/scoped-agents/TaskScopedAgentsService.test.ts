import path from "node:path"
import type { ToolUse } from "@core/assistant-message"
import type { ScopedAgentsResolution } from "@core/prompts/prompt-input-monitor/ScopedAgentsResolver"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { TaskScopedAgentsService } from "./TaskScopedAgentsService"

function tool(name: ClineDefaultTool, params: ToolUse["params"], tid: string): ToolUse {
	return { type: "tool_use", name, params, partial: false, ts: 1, function_id: `fn-${tid}`, dline_tid: tid }
}

describe("TaskScopedAgentsService", () => {
	it("deduplicates parallel target scopes into one block and does not reinject pinned content", async () => {
		const root = path.resolve("e:/workspace/project")
		const tracked: string[][] = []
		const resolve = vi.fn(
			async (): Promise<ScopedAgentsResolution> => ({
				candidates: [
					{
						workspaceRoot: root,
						workspaceRootIndex: 0,
						absolutePath: path.join(root, "packages", "AGENTS.md"),
						relativePath: "packages/AGENTS.md",
						scopeRelativeDirectory: "packages",
						state: "present",
						content: "packages guidance",
						contentBytes: 17,
						truncated: false,
					},
				],
				diagnostics: { invalid_utf8: 0, read_failed: 0 },
			}),
		)
		const stale = vi.fn()
		const service = new TaskScopedAgentsService({
			cwd: root,
			workspaceRoots: () => [{ path: root, name: "project" }],
			isEnabled: () => true,
			history: () => [],
			trackExact: async (paths) => {
				tracked.push([...paths])
			},
			onStale: stale,
			resolve,
		})
		const tools = [
			tool(ClineDefaultTool.FILE_READ, { path: "packages/a.ts" }, "a"),
			tool(ClineDefaultTool.FILE_READ, { path: "packages/b.ts" }, "b"),
		]

		const first = await service.resolveTurn("turn:a", tools)
		const second = await service.resolveTurn("turn:b", tools)

		expect(first?.type).toBe("agents_instructions")
		expect(first?.sources).toHaveLength(1)
		expect(second).toBeUndefined()
		expect(resolve).toHaveBeenCalledTimes(2)
		expect(tracked).toHaveLength(2)

		service.markChanged(path.join(root, "packages", "AGENTS.md"))
		service.markChanged(path.join(root, "packages", "AGENTS.md"))
		expect(stale).toHaveBeenCalledOnce()
		expect(await service.resolveTurn("turn:c", tools)).toBeUndefined()

		service.refresh()
		const replacement = await service.resolveTurn("turn:d", tools)
		expect(replacement?.replaces_previous).toBe(true)
	})

	it("restores pinned source identities from canonical history", async () => {
		const root = path.resolve("e:/workspace/project")
		const service = new TaskScopedAgentsService({
			cwd: root,
			workspaceRoots: () => [{ path: root }],
			isEnabled: () => true,
			history: () => [
				{
					role: "user",
					content: [
						{
							type: "agents_instructions",
							turn_id: "turn:old",
							content: "old",
							sources: [{ workspace_root_index: 0, path: "pkg/AGENTS.md", bytes: 3 }],
						},
					],
				},
			],
			trackExact: async () => undefined,
			onStale: vi.fn(),
			resolve: async () => ({
				candidates: [
					{
						workspaceRoot: root,
						workspaceRootIndex: 0,
						absolutePath: path.join(root, "pkg", "AGENTS.md"),
						relativePath: "pkg/AGENTS.md",
						scopeRelativeDirectory: "pkg",
						state: "present",
						content: "new",
						contentBytes: 3,
						truncated: false,
					},
				],
				diagnostics: { invalid_utf8: 0, read_failed: 0 },
			}),
		})

		expect(
			await service.resolveTurn("turn:new", [tool(ClineDefaultTool.FILE_READ, { path: "pkg/file.ts" }, "new")]),
		).toBeUndefined()
	})
})
