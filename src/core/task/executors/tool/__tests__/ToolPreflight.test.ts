import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { admitToolCall, rejectToolCall, type ToolPreflightInput } from "../ToolPreflight"

/** Build approval settings with only the named actions enabled. */
function settings(actions: Partial<AutoApprovalSettings["actions"]> = {}, version = 1): AutoApprovalSettings {
	return {
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
			useMcp: false,
			useWeb: false,
			generateImages: false,
			focusChain: false,
			...actions,
		},
		maxRequests: 20,
		enableNotifications: false,
	} as AutoApprovalSettings
}

/** Preflight input for one workspace file read. */
function readInput(overrides: Partial<ToolPreflightInput> = {}): ToolPreflightInput {
	return { toolName: ClineDefaultTool.FILE_READ, settings: settings(), ...overrides }
}

describe("ToolPreflight admission", () => {
	it("returns approval presentation as data without performing any UI call", () => {
		const presentation = { ask: "tool" as const, body: '{"tool":"readFile"}', notify: false }

		const admission = admitToolCall(readInput(), async () => "result", presentation)

		// Producing the payload required no host, which is the property that
		// makes the approval decision testable in isolation.
		expect(admission.outcome).toBe("admitted")
		expect(admission.decision.kind).toBe("manual")
		expect(admission.presentation).toEqual(presentation)
	})

	it("does not start the side effect during preflight", async () => {
		const run = vi.fn(async () => "done")

		const admission = admitToolCall(readInput(), run)

		// Nothing has happened yet: approval has not been granted.
		expect(run).not.toHaveBeenCalled()
		await expect(admission.run()).resolves.toBe("done")
		expect(run).toHaveBeenCalledOnce()
	})

	it("omits the presentation when policy already approved the call", () => {
		const admission = admitToolCall(readInput({ settings: settings({ readFiles: true }) }), async () => undefined, {
			ask: "tool",
			body: "{}",
			notify: false,
		})

		expect(admission.decision.kind).toBe("automatic")
		// An automatic approval must never reach the single user-facing slot.
		expect(admission.presentation).toBeUndefined()
	})

	it("declares one lane per write path so a multi-file edit protects every file", () => {
		const admission = admitToolCall(
			{
				toolName: ClineDefaultTool.APPLY_PATCH,
				settings: settings({ editFiles: true }),
				lanes: { canonicalWritePaths: ["/w/a.ts", "/w/b.ts"] },
			},
			async () => undefined,
		)

		expect(admission.lanes).toContain("write-path:/w/a.ts")
		expect(admission.lanes).toContain("write-path:/w/b.ts")
	})

	it("treats an inherited subagent approval as needing no decision", () => {
		const admission = admitToolCall(readInput({ inheritsApproval: true }), async () => undefined, {
			ask: "tool",
			body: "{}",
			notify: false,
		})

		expect(admission.decision.kind).toBe("none")
		expect(admission.presentation).toBeUndefined()
	})

	it("reports a rejected call without producing an effect", () => {
		const result = rejectToolCall<string>({ reason: "invalid_parameters", message: "missing path" })

		expect(result).toEqual({
			outcome: "rejected",
			rejection: { reason: "invalid_parameters", message: "missing path" },
		})
	})
})

describe("ToolPreflight ceilings", () => {
	it("forces manual approval for a manual_only scope even when its toggle is on", () => {
		const admission = admitToolCall(
			readInput({
				settings: settings({ readFilesExternally: true }),
				ceilings: { read_external: "manual_only" },
				scope: { isExternalPath: true },
			}),
			async () => undefined,
		)

		// The ceiling is configured, so the toggle cannot satisfy it.
		expect(admission.decision.ceiling).toBe("manual_only")
		expect(admission.decision.kind).toBe("manual")
	})

	it("forces manual approval for a manual_only scope even under a blanket switch", () => {
		const admission = admitToolCall(
			readInput({
				settings: settings({ readFiles: true }),
				ceilings: { read_external: "manual_only" },
				scope: { isExternalPath: true },
				blanket: { yoloMode: true, approveAll: true },
			}),
			async () => undefined,
		)

		expect(admission.decision.kind).toBe("manual")
	})

	it("leaves approval unchanged for every ordinary scope when no ceiling is configured", () => {
		const automatic = admitToolCall(readInput({ settings: settings({ readFiles: true }) }), async () => undefined)
		const manual = admitToolCall(readInput(), async () => undefined)

		// With no ceilings configured the toggle alone decides, exactly as before.
		expect(automatic.decision.kind).toBe("automatic")
		expect(manual.decision.kind).toBe("manual")
	})

	it("leaves an external read to its own toggle until a ceiling is configured", () => {
		// Introducing ceilings must not tighten anyone's approval on its own.
		// An external read was governed by readFilesExternally before, and it
		// still is for a user who has configured no ceiling.
		const admission = admitToolCall(
			readInput({
				settings: settings({ readFilesExternally: true }),
				scope: { isExternalPath: true },
			}),
			async () => undefined,
		)

		expect(admission.decision.scope).toBe("read_external")
		expect(admission.decision.ceiling).toBe("auto")
		expect(admission.decision.kind).toBe("automatic")
	})

	it("keeps manual_only above inherited parent approval", () => {
		const admission = admitToolCall(
			readInput({
				inheritsApproval: true,
				scope: { isExternalPath: true },
				ceilings: { read_external: "manual_only" },
			}),
			async () => undefined,
		)

		expect(admission.decision).toMatchObject({ kind: "manual", scope: "read_external", ceiling: "manual_only" })
	})

	it("classifies an inherited call by its real path rather than defaulting the scope", () => {
		// The inherited branch reports the scope for diagnostics. Spreading the
		// input instead of mapping scope to context would silently label an
		// external read as an in-workspace one.
		const admission = admitToolCall(
			readInput({ inheritsApproval: true, scope: { isExternalPath: true } }),
			async () => undefined,
		)

		expect(admission.decision.kind).toBe("none")
		expect(admission.decision.scope).toBe("read_external")
	})
})

describe("ToolPreflight re-resolution", () => {
	it("re-resolves the same call from current permission state without a version counter", () => {
		const granted = admitToolCall(readInput({ settings: settings({ readFiles: true }) }), async () => undefined)
		const tightened = admitToolCall(
			readInput({
				settings: settings({ readFiles: true }),
				ceilings: { read_workspace: "manual_only" },
			}),
			granted.run,
		)

		expect(granted.decision.kind).toBe("automatic")
		expect(tightened.decision.kind).toBe("manual")
	})
})
