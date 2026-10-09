import { PromptProfile } from "@core/prompts/profiles/types"
import { describe, expect, it, vi } from "vitest"
import { TaskEnvironmentProjection } from "./TaskEnvironmentProjection"

function projection() {
	const beginRequest = vi.fn()
	const project = vi.fn(() => "# TODO LIST NEEDED\nCreate a TODO list now.")
	const stateManager = {
		getGlobalStateKey: vi.fn(() => false),
		getGlobalSettingsKey: vi.fn((key: string) => {
			if (key === "focusChainSettings") return { enabled: true, remindClineInterval: 1 }
			if (key === "showActiveTasksInEnvDetails") return false
			return false
		}),
	}
	const api = {
		getModel: () => ({ id: "test-model", info: { capabilities: { contextWindow: 128_000 } } }),
	}
	const value = new TaskEnvironmentProjection({
		identity: { taskId: "task-1", cwd: "C:/workspace" },
		host: {
			getHostVersion: vi.fn(async () => ({ platform: "test", clineVersion: "test" })),
			getVisibleFiles: vi.fn(async () => []),
			getOpenTabs: vi.fn(async () => []),
			buildActiveTasksSection: vi.fn(() => ""),
		} as never,
		workspace: {
			stateManager: stateManager as never,
			ignoreController: { filterPaths: vi.fn(() => []) } as never,
		},
		runtime: { getApi: () => api as never, getMode: () => "act", getPhase: () => "running" },
		conversation: {
			messages: { clineMessages: [] } as never,
			taskState: { didEditFile: false, currentFocusChainChecklist: null, currentInProgressItemIndex: 0 },
			focusChain: { beginRequest, project },
		},
		execution: {
			terminals: { getTerminals: vi.fn(() => []) } as never,
			tools: { getSubagentJobManager: () => ({ listJobs: () => [] }) } as never,
			commands: { listBackgroundCommands: () => [], markBackgroundCommandOutputSent: vi.fn() } as never,
		},
		tracking: {
			files: { peekRecentlyModifiedFiles: () => ({ files: [] }) } as never,
			taskFiles: { getAllModifiedFiles: () => [] } as never,
		},
	})
	return { value, beginRequest, project }
}

describe("TaskEnvironmentProjection Focus Chain reminders", () => {
	it("injects reminders only into real ordinary requests, not preview projections", async () => {
		const { value, beginRequest, project } = projection()

		const requestEnvironment = await value.build(false, PromptProfile.Standard)
		expect(requestEnvironment).toContain("# TODO LIST NEEDED")
		expect(beginRequest).toHaveBeenCalledTimes(1)
		expect(project).toHaveBeenCalledWith({ mode: "act" })

		const previewEnvironment = await value.build(false, PromptProfile.Standard, { preview: true })
		expect(previewEnvironment).not.toContain("# TODO LIST NEEDED")
		expect(beginRequest).toHaveBeenCalledTimes(1)
		expect(project).toHaveBeenCalledTimes(1)
	})
})
