import os from "node:os"
import path from "node:path"
import { HostProvider } from "@hosts/host-provider"
import type { ApprovalCeilingSetting, ConfigurablePermissionScope } from "@shared/AutoApprovalSettings"
import { ClineDefaultTool } from "@shared/tools"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AutoApprove } from "../autoApprove"

afterEach(() => vi.restoreAllMocks())

interface Options {
	actions?: Record<string, boolean>
	ceilings?: Partial<Record<ConfigurablePermissionScope, ApprovalCeilingSetting>>
	yolo?: boolean
	approveAll?: boolean
}

/** Build an AutoApprove over a stubbed settings store. */
function autoApprove(options: Options = {}): AutoApprove {
	return new AutoApprove({
		getGlobalSettingsKey: (key: string) => {
			if (key === "yoloModeToggled") return options.yolo === true
			if (key === "autoApproveAllToggled") return options.approveAll === true
			if (key === "autoApprovalSettings") {
				return { actions: options.actions ?? {}, ceilings: options.ceilings }
			}
			return undefined
		},
		// Consulted by the multi-root check inside the path-based gate.
		getGlobalStateKey: (key: string) => (key === "multiRootEnabled" ? false : undefined),
	} as never)
}

/** Read the in-workspace element of a possibly paired approval result. */
function local(result: boolean | [boolean, boolean]): boolean {
	return Array.isArray(result) ? result[0] : result
}

/** Read the external element of a possibly paired approval result. */
function external(result: boolean | [boolean, boolean]): boolean {
	return Array.isArray(result) ? result[1] : false
}

describe("AutoApprove ceilings — default compatibility", () => {
	it("leaves every built-in tool's approval unchanged when no ceiling is configured", () => {
		const enabled = autoApprove({
			actions: {
				readFiles: true,
				readFilesExternally: true,
				editFiles: true,
				editFilesExternally: true,
				executeSafeCommands: true,
				executeAllCommands: true,
				useBrowser: true,
				useWeb: true,
				useMcp: true,
				generateImages: true,
			},
		})

		// Introducing ceilings must not change any existing user's outcome.
		expect(enabled.shouldAutoApproveTool(ClineDefaultTool.FILE_READ)).toEqual([true, true])
		expect(enabled.shouldAutoApproveTool(ClineDefaultTool.FILE_NEW)).toEqual([true, true])
		expect(enabled.shouldAutoApproveTool(ClineDefaultTool.BASH)).toEqual([true, true])
		expect(enabled.shouldAutoApproveTool(ClineDefaultTool.BROWSER)).toBe(true)
		expect(enabled.shouldAutoApproveTool(ClineDefaultTool.WEB_FETCH)).toBe(true)
		expect(enabled.shouldAutoApproveTool(ClineDefaultTool.MCP_USE)).toBe(true)
		expect(enabled.shouldAutoApproveTool(ClineDefaultTool.GENERATE_IMAGE)).toBe(true)
	})

	it("keeps every tool manual when the toggles are off and no ceiling is set", () => {
		const disabled = autoApprove({
			actions: {
				readFiles: false,
				readFilesExternally: false,
				editFiles: false,
				editFilesExternally: false,
				executeSafeCommands: false,
				executeAllCommands: false,
				useBrowser: false,
				useWeb: false,
				useMcp: false,
				generateImages: false,
			},
		})

		expect(local(disabled.shouldAutoApproveTool(ClineDefaultTool.FILE_READ))).toBe(false)
		expect(local(disabled.shouldAutoApproveTool(ClineDefaultTool.BASH))).toBe(false)
		expect(disabled.shouldAutoApproveTool(ClineDefaultTool.MCP_USE)).toBe(false)
	})
})

describe("AutoApprove ceilings — enforcement", () => {
	it("forces manual approval for a scope set to manual_only even when its toggle is on", () => {
		const approver = autoApprove({
			actions: { editFiles: true, editFilesExternally: true },
			ceilings: { edit_external: "manual_only" },
		})

		const result = approver.shouldAutoApproveTool(ClineDefaultTool.FILE_NEW)

		// The in-workspace case is untouched; only the ceilinged scope is clamped.
		expect(local(result)).toBe(true)
		expect(external(result)).toBe(false)
	})

	it("outranks the approve-all blanket switch", () => {
		const approver = autoApprove({
			approveAll: true,
			ceilings: { edit_external: "manual_only" },
		})

		expect(external(approver.shouldAutoApproveTool(ClineDefaultTool.FILE_NEW))).toBe(false)
	})

	it("outranks the yolo blanket switch", () => {
		const approver = autoApprove({
			yolo: true,
			ceilings: { edit_external: "manual_only" },
		})

		expect(external(approver.shouldAutoApproveTool(ClineDefaultTool.FILE_NEW))).toBe(false)
	})

	it("clamps a single-scope tool under a blanket switch", () => {
		const approver = autoApprove({ yolo: true, ceilings: { mcp: "manual_only" } })

		expect(approver.shouldAutoApproveTool(ClineDefaultTool.MCP_USE)).toBe(false)
		// An unrelated scope keeps the blanket grant.
		expect(approver.shouldAutoApproveTool(ClineDefaultTool.BROWSER)).toBe(true)
	})

	it("clamps both command classes independently", () => {
		const approver = autoApprove({
			actions: { executeSafeCommands: true, executeAllCommands: true },
			ceilings: { command_all: "manual_only" },
		})

		const result = approver.shouldAutoApproveTool(ClineDefaultTool.BASH)

		expect(local(result)).toBe(true)
		expect(external(result)).toBe(false)
	})

	it("does not treat ai_approvable as a denial", () => {
		const approver = autoApprove({
			actions: { readFiles: true },
			ceilings: { read_workspace: "ai_approvable" },
		})

		// The ceiling permits automation up to the AI approver, so an enabled
		// toggle still grants it; only manual_only withdraws automation.
		expect(local(approver.shouldAutoApproveTool(ClineDefaultTool.FILE_READ))).toBe(true)
	})
})

describe("AutoApprove ceilings — path-based approval", () => {
	/** Point workspace resolution at a stable directory for the path gate. */
	function stubWorkspace(): void {
		vi.spyOn(HostProvider.workspace, "getWorkspacePaths").mockResolvedValue({
			paths: [path.join(os.tmpdir(), "dline-ceiling-scope")],
		} as never)
	}

	it("refuses a blanket grant for a manual_only edit scope", async () => {
		stubWorkspace()
		const approver = autoApprove({
			approveAll: true,
			ceilings: { edit_workspace: "manual_only", edit_external: "manual_only" },
		})

		await expect(approver.shouldAutoApproveToolWithPath(ClineDefaultTool.FILE_NEW, "src/a.ts")).resolves.toBe(false)
	})

	it("keeps the blanket grant when the scope has no manual_only ceiling", async () => {
		stubWorkspace()
		const approver = autoApprove({ approveAll: true, ceilings: { mcp: "manual_only" } })

		await expect(approver.shouldAutoApproveToolWithPath(ClineDefaultTool.FILE_NEW, "src/a.ts")).resolves.toBe(true)
	})

	it("applies the ceiling of the half that governs the path, not the permissive one", async () => {
		stubWorkspace()
		// The asymmetric case is the point of a ceiling: automate inside the
		// workspace, never outside it. Answering the blanket switch with
		// "either half allows it" would carry an external path past its own
		// manual_only ceiling.
		const approver = autoApprove({
			approveAll: true,
			ceilings: { edit_workspace: "auto", edit_external: "manual_only" },
		})

		await expect(
			approver.shouldAutoApproveToolWithPath(ClineDefaultTool.FILE_NEW, path.join(os.tmpdir(), "outside", "a.ts")),
		).resolves.toBe(false)
	})

	it("still grants a blanket workspace edit when only the external half is manual_only", async () => {
		stubWorkspace()
		const approver = autoApprove({
			approveAll: true,
			ceilings: { edit_workspace: "auto", edit_external: "manual_only" },
		})

		await expect(
			approver.shouldAutoApproveToolWithPath(
				ClineDefaultTool.FILE_NEW,
				path.join(os.tmpdir(), "dline-ceiling-scope", "a.ts"),
			),
		).resolves.toBe(true)
	})
})
