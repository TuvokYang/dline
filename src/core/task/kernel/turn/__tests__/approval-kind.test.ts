import { type AutoApprovalSettings, DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { type ConfigurableCeilings, resolveApprovalCeiling, resolveApprovalKind, resolvePermissionScope } from "../approval-kind"

/** Settings with every per-scope toggle on. */
function allApproved(version = 1): AutoApprovalSettings {
	return {
		...DEFAULT_AUTO_APPROVAL_SETTINGS,
		version,
		enabled: true,
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
			focusChain: true,
		},
	}
}

/** Settings with every toggle off. */
function noneApproved(version = 1): AutoApprovalSettings {
	return {
		...DEFAULT_AUTO_APPROVAL_SETTINGS,
		version,
		enabled: true,
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
			focusChain: false,
		},
	}
}

describe("permission scope", () => {
	it("separates workspace and external reads", () => {
		expect(resolvePermissionScope(ClineDefaultTool.FILE_READ)).toBe("read_workspace")
		expect(resolvePermissionScope(ClineDefaultTool.FILE_READ, { isExternalPath: true })).toBe("read_external")
	})

	it("separates workspace and external edits", () => {
		expect(resolvePermissionScope(ClineDefaultTool.FILE_EDIT)).toBe("edit_workspace")
		expect(resolvePermissionScope(ClineDefaultTool.REPLACE_TEXT)).toBe("edit_workspace")
		expect(resolvePermissionScope(ClineDefaultTool.APPLY_PATCH, { isExternalPath: true })).toBe("edit_external")
		expect(resolvePermissionScope(ClineDefaultTool.REPLACE_TEXT, { isExternalPath: true })).toBe("edit_external")
	})

	it("separates safe and unclassified commands", () => {
		expect(resolvePermissionScope(ClineDefaultTool.BASH, { isSafeCommand: true })).toBe("command_safe")
		expect(resolvePermissionScope(ClineDefaultTool.BASH)).toBe("command_all")
	})

	it("maps resource tools onto their own scopes", () => {
		expect(resolvePermissionScope(ClineDefaultTool.BROWSER)).toBe("browser")
		expect(resolvePermissionScope(ClineDefaultTool.MCP_USE)).toBe("mcp")
		expect(resolvePermissionScope(ClineDefaultTool.WEB_FETCH)).toBe("web")
		expect(resolvePermissionScope(ClineDefaultTool.USE_SUBAGENTS)).toBe("subagent")
	})
})

describe("approval ceiling", () => {
	it("adds no restriction of its own until one is configured", () => {
		// A ceiling is a setting the user chooses. Defaulting external access
		// to manual_only would tighten approval for someone who never asked
		// for it, so every scope defaults to auto and the toggle still decides.
		expect(resolveApprovalCeiling("read_external")).toBe("auto")
		expect(resolveApprovalCeiling("edit_external")).toBe("auto")
		expect(resolveApprovalCeiling("read_workspace")).toBe("auto")
		expect(resolveApprovalCeiling("edit_workspace")).toBe("auto")
	})

	it("makes manual_only reachable for the external scopes it exists for", () => {
		const configured: ConfigurableCeilings = { read_external: "manual_only", edit_external: "manual_only" }
		expect(resolveApprovalCeiling("read_external", configured)).toBe("manual_only")
		expect(resolveApprovalCeiling("edit_external", configured)).toBe("manual_only")
	})

	it("prefers a configured ceiling over the default", () => {
		const configured: ConfigurableCeilings = { edit_workspace: "manual_only", read_external: "auto" }
		expect(resolveApprovalCeiling("edit_workspace", configured)).toBe("manual_only")
		expect(resolveApprovalCeiling("read_external", configured)).toBe("auto")
	})

	it("ignores a configured ceiling for scopes whose ceiling is architectural", () => {
		// A conversational tool cannot satisfy a manual_only ceiling: the
		// approval would be for the interaction it has not presented yet.
		expect(resolveApprovalCeiling("conversational", { conversational: "manual_only" })).toBe("auto")
	})
})

describe("approval kind", () => {
	describe("the ceiling is an upper bound, not another switch", () => {
		it("requires manual approval under manual_only with every toggle on", () => {
			const decision = resolveApprovalKind({
				toolName: ClineDefaultTool.FILE_EDIT,
				settings: allApproved(),
				ceilings: { edit_workspace: "manual_only" },
			})

			expect(decision.kind).toBe("manual")
			expect(decision.ceiling).toBe("manual_only")
		})

		it("outranks the blanket approve-all and yolo switches", () => {
			// These are the switches that actually grant broad approval; the
			// AutoApprovalSettings.enabled field is legacy and always true. A
			// ceiling that either of them could override would be a toggle, not
			// a ceiling.
			for (const blanket of [{ approveAll: true }, { yoloMode: true }, { approveAll: true, yoloMode: true }]) {
				const decision = resolveApprovalKind({
					toolName: ClineDefaultTool.FILE_EDIT,
					settings: allApproved(),
					ceilings: { edit_workspace: "manual_only" },
					blanket,
				})

				expect(decision.kind, `blanket=${JSON.stringify(blanket)}`).toBe("manual")
			}
		})

		it("lets a blanket switch approve a scope whose own toggle is off", () => {
			const decision = resolveApprovalKind({
				toolName: ClineDefaultTool.FILE_EDIT,
				settings: noneApproved(),
				blanket: { approveAll: true },
			})

			expect(decision.kind).toBe("automatic")
		})

		it("requires manual approval for external writes once that ceiling is configured", () => {
			const decision = resolveApprovalKind({
				toolName: ClineDefaultTool.FILE_NEW,
				settings: allApproved(),
				ceilings: { edit_external: "manual_only" },
				context: { isExternalPath: true },
			})

			expect(decision.scope).toBe("edit_external")
			expect(decision.kind).toBe("manual")
		})

		it("leaves an external write to its own toggle while no ceiling is configured", () => {
			// Classifying the scope is not the same as restricting it. Until
			// the user configures a ceiling, editFilesExternally still decides,
			// which is what the build did before ceilings existed.
			const decision = resolveApprovalKind({
				toolName: ClineDefaultTool.FILE_NEW,
				settings: allApproved(),
				context: { isExternalPath: true },
			})

			expect(decision.scope).toBe("edit_external")
			expect(decision.kind).toBe("automatic")
		})

		it("routes an ai_approvable scope to the approver when its toggle is off", () => {
			const decision = resolveApprovalKind({
				toolName: ClineDefaultTool.BROWSER,
				settings: noneApproved(),
				ceilings: { browser: "ai_approvable" },
			})

			// Not manual: the ceiling permits automation the user has not
			// enabled, which is exactly what the approver exists to decide.
			expect(decision.kind).toBe("ai_approver")
		})

		it("prefers the user's own approval over the approver", () => {
			const decision = resolveApprovalKind({
				toolName: ClineDefaultTool.BROWSER,
				settings: allApproved(),
				ceilings: { browser: "ai_approvable" },
			})

			expect(decision.kind).toBe("automatic")
		})

		it("follows the toggle for an auto scope", () => {
			expect(resolveApprovalKind({ toolName: ClineDefaultTool.FILE_READ, settings: allApproved() }).kind).toBe("automatic")
			expect(resolveApprovalKind({ toolName: ClineDefaultTool.FILE_READ, settings: noneApproved() }).kind).toBe("manual")
		})

		it("never routes an auto scope with its toggle off to the approver", () => {
			const decision = resolveApprovalKind({
				toolName: ClineDefaultTool.FILE_EDIT,
				settings: noneApproved(),
			})

			expect(decision.ceiling).toBe("auto")
			expect(decision.kind).toBe("manual")
		})
	})

	describe("command scopes", () => {
		it("lets approve-all cover safe commands", () => {
			const settings = noneApproved()
			settings.actions.executeAllCommands = true

			expect(
				resolveApprovalKind({ toolName: ClineDefaultTool.BASH, settings, context: { isSafeCommand: true } }).kind,
			).toBe("automatic")
		})

		it("does not let safe-command approval cover unclassified commands", () => {
			const settings = noneApproved()
			settings.actions.executeSafeCommands = true

			expect(resolveApprovalKind({ toolName: ClineDefaultTool.BASH, settings }).kind).toBe("manual")
		})
	})

	describe("subagent scope", () => {
		it("follows the read-file toggles, matching the existing runtime policy", () => {
			// The current AutoApprovalPolicy governs use_subagent(s) with the
			// read toggles. Naming the scope separately must not silently change
			// that to "never automatic" before a dedicated setting exists.
			expect(resolveApprovalKind({ toolName: ClineDefaultTool.USE_SUBAGENTS, settings: allApproved() }).kind).toBe(
				"automatic",
			)
			expect(resolveApprovalKind({ toolName: ClineDefaultTool.USE_SUBAGENT, settings: noneApproved() }).kind).toBe("manual")
		})
	})

	describe("tools that own their interaction", () => {
		it("returns no approval stage", () => {
			const decision = resolveApprovalKind({
				toolName: ClineDefaultTool.ATTEMPT,
				settings: noneApproved(),
			})

			// Gating a tool that presents its own interaction would deadlock the
			// turn: the approval it waits for is the one it has not shown yet.
			expect(decision.kind).toBe("none")
		})

		it("derives that from the tool, not from a caller-supplied flag", () => {
			// status_update likewise owns whether to block, which is the same
			// rule the existing runtime applies.
			for (const tool of [ClineDefaultTool.ASK, ClineDefaultTool.MAKE_PLAN, ClineDefaultTool.STATUS_UPDATE]) {
				expect(resolveApprovalKind({ toolName: tool, settings: noneApproved() }).kind, tool).toBe("none")
			}
		})

		it("cannot be given an unsatisfiable manual_only ceiling", () => {
			// A conversational tool waiting for approval of the interaction it
			// has not been allowed to present would deadlock, so its ceiling is
			// fixed rather than configurable.
			const decision = resolveApprovalKind({
				toolName: ClineDefaultTool.ATTEMPT,
				settings: noneApproved(),
				ceilings: { conversational: "manual_only" },
			})

			expect(decision.ceiling).toBe("auto")
			expect(decision.kind).toBe("none")
		})
	})

	describe("purity", () => {
		it("returns an equal decision for the same input", () => {
			const input = { toolName: ClineDefaultTool.FILE_EDIT, settings: allApproved() }
			expect(resolveApprovalKind(input)).toEqual(resolveApprovalKind(input))
		})
	})
})
