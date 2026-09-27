import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ToolUse } from "@core/assistant-message"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { resolvePermissionScope } from "../../../kernel/turn/approval-kind"
import { GenerateImageToolHandler } from "../../../tools/handlers/GenerateImageToolHandler"
import { ToolExecutorCoordinator } from "../../../tools/ToolExecutorCoordinator"
import { prepareRegisteredToolAdmission, type ToolAdmissionSnapshot } from "../ToolAdmissionRegistry"

function snapshot(overrides: Partial<ToolAdmissionSnapshot> = {}): ToolAdmissionSnapshot {
	return {
		taskId: "task-admission",
		cwd: "/workspace",
		workspaceRoots: ["/workspace"],
		settings: {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: {
				...DEFAULT_AUTO_APPROVAL_SETTINGS.actions,
				readFiles: false,
				readFilesExternally: false,
				editFiles: false,
				editFilesExternally: false,
			},
		},
		blanket: {},
		...overrides,
	}
}

function block(name: ClineDefaultTool, params: ToolUse["params"]): ToolUse {
	return {
		type: "tool_use",
		name,
		params,
		partial: false,
		function_id: `function-${name}`,
		dline_tid: `dline-${name}`,
		ts: 1,
	}
}

describe("ToolAdmissionRegistry", () => {
	it("returns an unstarted effect with declarative approval data", async () => {
		const run = vi.fn(async () => undefined)
		const admission = prepareRegisteredToolAdmission({
			canonicalToolName: ClineDefaultTool.FILE_READ,
			block: block(ClineDefaultTool.FILE_READ, { path: "src/a.ts" }),
			description: "read src/a.ts",
			snapshot: snapshot(),
			run,
		})

		expect(admission.outcome).toBe("admitted")
		if (admission.outcome !== "admitted") throw new Error("expected admission")
		expect(admission.decision).toMatchObject({ kind: "manual", scope: "read_workspace" })
		expect(JSON.parse(admission.presentation?.body ?? "{}")).toMatchObject({ tool: "readFile" })
		expect(run).not.toHaveBeenCalled()
		await admission.run()
		expect(run).toHaveBeenCalledOnce()
	})

	it("uses the image handler's typed presentation for manual approval", () => {
		const coordinator = new ToolExecutorCoordinator()
		coordinator.register(new GenerateImageToolHandler())
		const result = coordinator.prepareAdmission(
			block(ClineDefaultTool.GENERATE_IMAGE, { prompt: "A blue owl", count: "2" }),
			snapshot({
				settings: {
					...snapshot().settings,
					actions: { ...snapshot().settings.actions, generateImages: false },
				},
			}),
			async () => undefined,
		)

		expect(result.outcome).toBe("admitted")
		if (result.outcome !== "admitted") throw new Error("expected admission")
		expect(result.decision.kind).toBe("manual")
		expect(JSON.parse(result.presentation?.body ?? "{}")).toMatchObject({
			tool: "generateImage",
			imageGeneration: {
				schemaVersion: 1,
				status: "awaiting_approval",
				requestId: `dline-${ClineDefaultTool.GENERATE_IMAGE}`,
				prompt: "A blue owl",
				count: 2,
			},
		})
	})

	it("rejects invalid parameters without constructing or running an effect", () => {
		const run = vi.fn(async () => undefined)
		const result = prepareRegisteredToolAdmission({
			canonicalToolName: ClineDefaultTool.SEARCH,
			block: block(ClineDefaultTool.SEARCH, { path: "src" }),
			description: "search src",
			snapshot: snapshot(),
			run,
		})

		expect(result).toEqual({
			outcome: "rejected",
			rejection: {
				reason: "invalid_parameters",
				message: "Missing required parameter 'regex' for tool 'search_files'.",
			},
		})
		expect(run).not.toHaveBeenCalled()
	})

	it("rejects an unregistered tool at the coordinator boundary", () => {
		const coordinator = new ToolExecutorCoordinator()
		const run = vi.fn(async () => undefined)
		const result = coordinator.prepareAdmission(block(ClineDefaultTool.FILE_READ, { path: "a.ts" }), snapshot(), run)

		expect(result).toEqual({
			outcome: "rejected",
			rejection: { reason: "unsupported_tool", message: "No handler registered for tool: read_file" },
		})
		expect(run).not.toHaveBeenCalled()
	})

	it("classifies paths lexically without reading the target", () => {
		const result = prepareRegisteredToolAdmission({
			canonicalToolName: ClineDefaultTool.FILE_READ,
			block: block(ClineDefaultTool.FILE_READ, { path: "../outside.txt" }),
			description: "read outside",
			snapshot: snapshot({
				settings: {
					...snapshot().settings,
					actions: { ...snapshot().settings.actions, readFilesExternally: true },
				},
			}),
			run: async () => undefined,
		})

		expect(result.outcome).toBe("admitted")
		if (result.outcome !== "admitted") throw new Error("expected admission")
		expect(result.decision).toMatchObject({ kind: "automatic", scope: "read_external" })
	})

	it("mirrors multi-root unknown-hint fallback before classifying scope", async () => {
		const primaryRoot = path.resolve("/workspace/primary")
		const secondaryRoot = path.resolve("/workspace/secondary")
		const run = vi.fn(async () => undefined)
		const result = prepareRegisteredToolAdmission({
			canonicalToolName: ClineDefaultTool.FILE_READ,
			block: block(ClineDefaultTool.FILE_READ, { path: "@missing:../outside/secret.txt" }),
			description: "read unknown workspace hint",
			snapshot: snapshot({
				cwd: primaryRoot,
				workspaceRoots: [primaryRoot, secondaryRoot],
				workspaceRootEntries: [
					{ name: "frontend", path: primaryRoot },
					{ name: "backend", path: secondaryRoot },
				],
				primaryWorkspaceRoot: primaryRoot,
				isMultiRootEnabled: true,
				settings: {
					...snapshot().settings,
					actions: { ...snapshot().settings.actions, readFiles: true, readFilesExternally: true },
					ceilings: { read_external: "manual_only" },
				},
			}),
			run,
		})

		expect(result).toMatchObject({ outcome: "admitted", decision: { kind: "manual", scope: "read_external" } })
		if (result.outcome !== "admitted" || !result.confirm) throw new Error("expected scope confirmation")
		const confirmed = await result.confirm()
		if (confirmed.outcome !== "admitted") throw new Error("expected confirmed admission")
		expect(confirmed.decision).toMatchObject({ kind: "manual", scope: "read_external", ceiling: "manual_only" })
		expect(run).not.toHaveBeenCalled()
	})

	it("reclassifies a workspace junction by its canonical external target before execution", async () => {
		const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dline-admission-junction-"))
		try {
			const workspaceDir = path.join(temporaryRoot, "workspace")
			const externalDir = path.join(temporaryRoot, "external")
			const linkedDir = path.join(workspaceDir, "linked-outside")
			await fs.mkdir(workspaceDir)
			await fs.mkdir(externalDir)
			await fs.symlink(externalDir, linkedDir, process.platform === "win32" ? "junction" : "dir")
			const run = vi.fn(async () => undefined)
			const result = prepareRegisteredToolAdmission({
				canonicalToolName: ClineDefaultTool.FILE_NEW,
				block: block(ClineDefaultTool.FILE_NEW, {
					absolutePath: path.join(linkedDir, "proof.txt"),
					content: "proof",
				}),
				description: "write proof",
				snapshot: snapshot({
					cwd: workspaceDir,
					workspaceRoots: [workspaceDir],
					settings: {
						...snapshot().settings,
						actions: { ...snapshot().settings.actions, editFiles: true, editFilesExternally: false },
						ceilings: { edit_external: "manual_only" },
					},
				}),
				run,
			})

			expect(result).toMatchObject({ outcome: "admitted", decision: { kind: "automatic", scope: "edit_workspace" } })
			if (result.outcome !== "admitted" || !result.confirm) throw new Error("expected scope confirmation")
			const confirmed = await result.confirm()
			if (confirmed.outcome !== "admitted") throw new Error("expected confirmed admission")
			expect(confirmed.decision).toMatchObject({ kind: "manual", scope: "edit_external", ceiling: "manual_only" })
			expect(run).not.toHaveBeenCalled()
		} finally {
			await fs.rm(temporaryRoot, { recursive: true, force: true })
		}
	})

	it("keeps confirmed project replace_text targets under project edit approval", async () => {
		const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dline-replace-text-project-"))
		try {
			const workspaceDir = path.join(temporaryRoot, "workspace")
			await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true })
			await fs.writeFile(path.join(workspaceDir, "src", "target.ts"), "const oldName = 1\n", "utf8")
			const run = vi.fn(async () => undefined)
			const result = prepareRegisteredToolAdmission({
				canonicalToolName: ClineDefaultTool.REPLACE_TEXT,
				block: block(ClineDefaultTool.REPLACE_TEXT, {
					file_pattern: "src/*.ts",
					find: "oldName",
					replace: "newName",
				}),
				description: "replace project text",
				snapshot: snapshot({
					cwd: workspaceDir,
					workspaceRoots: [workspaceDir],
					settings: {
						...snapshot().settings,
						actions: { ...snapshot().settings.actions, editFiles: true, editFilesExternally: false },
					},
				}),
				run,
			})

			expect(result).toMatchObject({ outcome: "admitted", decision: { kind: "automatic", scope: "edit_workspace" } })
			if (result.outcome !== "admitted" || !result.confirm) throw new Error("expected replace_text scope confirmation")
			const confirmed = await result.confirm()
			if (confirmed.outcome !== "admitted") throw new Error("expected confirmed replace_text admission")
			expect(confirmed.decision).toMatchObject({ kind: "automatic", scope: "edit_workspace" })
			expect(run).not.toHaveBeenCalled()
		} finally {
			await fs.rm(temporaryRoot, { recursive: true, force: true })
		}
	})

	it("reclassifies replace_text targets reached through a workspace junction before execution", async () => {
		const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dline-replace-text-junction-"))
		try {
			const workspaceDir = path.join(temporaryRoot, "workspace")
			const externalDir = path.join(temporaryRoot, "external")
			const linkedDir = path.join(workspaceDir, "linked-outside")
			await fs.mkdir(workspaceDir)
			await fs.mkdir(externalDir)
			await fs.writeFile(path.join(externalDir, "target.ts"), "const oldName = 1\n", "utf8")
			await fs.symlink(externalDir, linkedDir, process.platform === "win32" ? "junction" : "dir")
			const run = vi.fn(async () => undefined)
			const result = prepareRegisteredToolAdmission({
				canonicalToolName: ClineDefaultTool.REPLACE_TEXT,
				block: block(ClineDefaultTool.REPLACE_TEXT, {
					file_pattern: "linked-outside/*.ts",
					find: "oldName",
					replace: "newName",
				}),
				description: "replace linked text",
				snapshot: snapshot({
					cwd: workspaceDir,
					workspaceRoots: [workspaceDir],
					settings: {
						...snapshot().settings,
						actions: { ...snapshot().settings.actions, editFiles: true, editFilesExternally: false },
						ceilings: { edit_external: "manual_only" },
					},
				}),
				run,
			})

			expect(result).toMatchObject({ outcome: "admitted", decision: { kind: "automatic", scope: "edit_workspace" } })
			if (result.outcome !== "admitted" || !result.confirm) throw new Error("expected replace_text scope confirmation")
			const confirmed = await result.confirm()
			if (confirmed.outcome !== "admitted") throw new Error("expected confirmed replace_text admission")
			expect(confirmed.decision).toMatchObject({ kind: "manual", scope: "edit_external", ceiling: "manual_only" })
			expect(run).not.toHaveBeenCalled()
		} finally {
			await fs.rm(temporaryRoot, { recursive: true, force: true })
		}
	})

	it("classifies every apply_patch target before exposing the retained effect", async () => {
		const run = vi.fn(async () => undefined)
		const result = prepareRegisteredToolAdmission({
			canonicalToolName: ClineDefaultTool.APPLY_PATCH,
			block: block(ClineDefaultTool.APPLY_PATCH, {
				input: [
					"*** Begin Patch",
					"*** Update File: src/in-workspace.ts",
					"@@",
					"-old",
					"+new",
					"*** Add File: ../outside.txt",
					"+outside",
					"*** End Patch",
				].join("\n"),
			}),
			description: "apply mixed-scope patch",
			snapshot: snapshot({
				settings: {
					...snapshot().settings,
					actions: { ...snapshot().settings.actions, editFiles: true, editFilesExternally: true },
					ceilings: { edit_external: "manual_only" },
				},
			}),
			run,
		})

		expect(result).toMatchObject({ outcome: "admitted", decision: { kind: "manual", scope: "edit_external" } })
		if (result.outcome !== "admitted" || !result.confirm) throw new Error("expected scope confirmation")
		const confirmed = await result.confirm()
		if (confirmed.outcome !== "admitted") throw new Error("expected confirmed admission")
		expect(confirmed.decision).toMatchObject({ kind: "manual", scope: "edit_external", ceiling: "manual_only" })
		expect(run).not.toHaveBeenCalled()
	})

	it.each([
		[
			"marker-like POSIX path",
			["*** Begin Patch", "*** Add File: ../outside/***.txt", "+outside", "*** End Patch"].join("\n"),
		],
		[
			"move destination",
			[
				"*** Begin Patch",
				"*** Update File: src/source.ts",
				"*** Move to: ../outside/moved.ts",
				"@@",
				"-old",
				"+new",
				"*** End Patch",
			].join("\n"),
		],
	] as const)("does not drop the apply_patch %s from scope classification", async (_caseName, input) => {
		const run = vi.fn(async () => undefined)
		const result = prepareRegisteredToolAdmission({
			canonicalToolName: ClineDefaultTool.APPLY_PATCH,
			block: block(ClineDefaultTool.APPLY_PATCH, { input }),
			description: "apply external patch target",
			snapshot: snapshot({
				settings: {
					...snapshot().settings,
					actions: { ...snapshot().settings.actions, editFiles: true, editFilesExternally: true },
					ceilings: { edit_external: "manual_only" },
				},
			}),
			run,
		})

		expect(result).toMatchObject({ outcome: "admitted", decision: { kind: "manual", scope: "edit_external" } })
		if (result.outcome !== "admitted" || !result.confirm) throw new Error("expected scope confirmation")
		const confirmed = await result.confirm()
		if (confirmed.outcome !== "admitted") throw new Error("expected confirmed admission")
		expect(confirmed.decision).toMatchObject({ kind: "manual", scope: "edit_external", ceiling: "manual_only" })
		expect(run).not.toHaveBeenCalled()
	})

	it("classifies every remaining tool by the resource class it reaches", () => {
		expect(resolvePermissionScope(ClineDefaultTool.FIND_REFERENCES)).toBe("read_workspace")
		expect(resolvePermissionScope(ClineDefaultTool.RENAME)).toBe("edit_workspace")
		expect(resolvePermissionScope(ClineDefaultTool.KILL_COMMAND)).toBe("terminate_command")
		expect(resolvePermissionScope(ClineDefaultTool.MCP_DOCS)).toBe("mcp")
		expect(resolvePermissionScope(ClineDefaultTool.LOAD_MCP)).toBe("mcp")
		expect(resolvePermissionScope(ClineDefaultTool.LOAD_SKILL)).toBe("read_workspace")
		expect(resolvePermissionScope(ClineDefaultTool.LOAD_WORKFLOW)).toBe("read_workspace")
		expect(resolvePermissionScope(ClineDefaultTool.GENERATE_EXPLANATION)).toBe("read_workspace")
		expect(resolvePermissionScope(ClineDefaultTool.SUMMARIZE_TASK)).toBe("read_workspace")
		expect(resolvePermissionScope(ClineDefaultTool.SPAWN_TASK)).toBe("subagent")
		expect(resolvePermissionScope(ClineDefaultTool.REPORT_BUG)).toBe("web")
	})

	// The workspace toggle the user granted has to reach a symbol tool aimed at
	// a workspace file. Charging it to the external permission instead withheld
	// nothing, because the language server's result set was never what the
	// approval gated.
	it.each([
		[ClineDefaultTool.FIND_REFERENCES, { file_path: "src/a.ts", line: "1", character: "1" }, "read_workspace"],
		[ClineDefaultTool.RENAME, { file_path: "src/a.ts", line: "1", character: "1", new_name: "renamed" }, "edit_workspace"],
	] as const)("admits %s under the workspace permission its target belongs to", async (toolName, params, scope) => {
		const run = vi.fn(async () => undefined)
		const result = prepareRegisteredToolAdmission({
			canonicalToolName: toolName,
			block: block(toolName, params),
			description: `run ${toolName}`,
			snapshot: snapshot({
				settings: {
					...snapshot().settings,
					actions: {
						...snapshot().settings.actions,
						readFiles: true,
						readFilesExternally: false,
						editFiles: true,
						editFilesExternally: false,
					},
				},
			}),
			run,
		})

		expect(result).toMatchObject({ outcome: "admitted", decision: { kind: "automatic", scope } })
		if (result.outcome !== "admitted" || !result.confirm) throw new Error("expected scope confirmation")
		const confirmed = await result.confirm()
		expect(confirmed).toMatchObject({ outcome: "admitted", decision: { kind: "automatic", scope } })
		expect(run).not.toHaveBeenCalled()
	})

	it.each([
		[ClineDefaultTool.FIND_REFERENCES, { file_path: "src/a.ts", line: "1", character: "1" }, "read_workspace"],
		[ClineDefaultTool.RENAME, { file_path: "src/a.ts", line: "1", character: "1", new_name: "renamed" }, "edit_workspace"],
	] as const)("keeps %s behind a ceiling configured on the scope it resolves to", (toolName, params, scope) => {
		const run = vi.fn(async () => undefined)
		const result = prepareRegisteredToolAdmission({
			canonicalToolName: toolName,
			block: block(toolName, params),
			description: `run ${toolName}`,
			snapshot: snapshot({
				settings: {
					...snapshot().settings,
					actions: {
						...snapshot().settings.actions,
						readFiles: true,
						readFilesExternally: true,
						editFiles: true,
						editFilesExternally: true,
					},
					ceilings: { read_workspace: "manual_only", edit_workspace: "manual_only" },
				},
			}),
			run,
		})

		expect(result).toMatchObject({ outcome: "admitted", decision: { kind: "manual", scope, ceiling: "manual_only" } })
		expect(run).not.toHaveBeenCalled()
	})

	it("projects the lexical command workdirectory before target I/O", () => {
		const inputSnapshot = snapshot({
			settings: {
				...snapshot().settings,
				actions: { ...snapshot().settings.actions, executeAllCommands: false },
			},
		})
		const result = prepareRegisteredToolAdmission({
			canonicalToolName: ClineDefaultTool.BASH,
			block: block(ClineDefaultTool.BASH, {
				command: "echo ok",
				requires_approval: "true",
				workdirectory: "commands",
			}),
			description: "execute command",
			snapshot: inputSnapshot,
			run: async () => undefined,
		})

		expect(result.outcome).toBe("admitted")
		if (result.outcome !== "admitted") throw new Error("expected admission")
		expect(result.decision).toMatchObject({ kind: "manual", scope: "command_all" })
		expect(result.presentation?.body).toContain(`Working directory: ${path.resolve(inputSnapshot.cwd, "commands")}`)
	})

	it("combines the MCP category toggle with the per-tool gate in the single resolver", () => {
		const settings = {
			...snapshot().settings,
			actions: { ...snapshot().settings.actions, useMcp: true },
		}
		const unresolvedTool = prepareRegisteredToolAdmission({
			canonicalToolName: ClineDefaultTool.MCP_USE,
			block: block(ClineDefaultTool.MCP_USE, { server_name: "docs", tool_name: "search" }),
			description: "use MCP",
			snapshot: snapshot({ settings }),
			run: async () => undefined,
		})
		const disabledTool = prepareRegisteredToolAdmission({
			canonicalToolName: ClineDefaultTool.MCP_USE,
			block: block(ClineDefaultTool.MCP_USE, { server_name: "docs", tool_name: "search" }),
			description: "use MCP",
			snapshot: snapshot({ settings, mcpToolAutoApprove: false }),
			run: async () => undefined,
		})
		const blanket = prepareRegisteredToolAdmission({
			canonicalToolName: ClineDefaultTool.MCP_USE,
			block: block(ClineDefaultTool.MCP_USE, { server_name: "docs", tool_name: "search" }),
			description: "use MCP",
			snapshot: snapshot({ settings, mcpToolAutoApprove: false, blanket: { approveAll: true } }),
			run: async () => undefined,
		})

		expect(unresolvedTool).toMatchObject({ outcome: "admitted", decision: { kind: "manual", scope: "mcp" } })
		expect(disabledTool).toMatchObject({ outcome: "admitted", decision: { kind: "manual", scope: "mcp" } })
		expect(blanket).toMatchObject({ outcome: "admitted", decision: { kind: "automatic", scope: "mcp" } })
	})

	it("validates action-dependent browser parameters and corrected tool schemas", () => {
		const invalidBrowser = prepareRegisteredToolAdmission({
			canonicalToolName: ClineDefaultTool.BROWSER,
			block: block(ClineDefaultTool.BROWSER, { action: "click" }),
			description: "click",
			snapshot: snapshot(),
			run: async () => undefined,
		})
		const validBatch = prepareRegisteredToolAdmission({
			canonicalToolName: ClineDefaultTool.USE_SUBAGENTS,
			block: block(ClineDefaultTool.USE_SUBAGENTS, { subagents: "[]" }),
			description: "subagents",
			snapshot: snapshot(),
			run: async () => undefined,
		})
		const validTodo = prepareRegisteredToolAdmission({
			canonicalToolName: ClineDefaultTool.CHANGE_TODO_LIST,
			block: block(ClineDefaultTool.CHANGE_TODO_LIST, { new_plan: "# Plan\n- [ ] Item" }),
			description: "change todo",
			snapshot: snapshot(),
			run: async () => undefined,
		})

		expect(invalidBrowser).toMatchObject({ outcome: "rejected", rejection: { reason: "invalid_parameters" } })
		expect(validBatch.outcome).toBe("admitted")
		expect(validTodo.outcome).toBe("admitted")
	})
})
