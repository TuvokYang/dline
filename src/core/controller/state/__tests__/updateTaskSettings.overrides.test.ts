import { ApiProfile } from "@shared/proto/dline/profile"
import { UpdateTaskSettingsRequest } from "@shared/proto/dline/state"
import { createTaskCapabilityToggles, serializeTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Controller } from "../.."
import { updateTaskSettings } from "../updateTaskSettings"

const { findEnabledProfileByName, getProfileModelInfo, readApiProfiles } = vi.hoisted(() => ({
	findEnabledProfileByName: vi.fn(),
	getProfileModelInfo: vi.fn(),
	readApiProfiles: vi.fn(),
}))

vi.mock("@core/controller/file/getApiProfiles", () => ({
	findEnabledProfileByName,
	readApiProfiles,
}))

vi.mock("@core/api/model-info", () => ({
	getProfileModelInfo,
}))

function createOpenAiProfile() {
	return ApiProfile.create({
		id: "profile-1",
		name: "OpenAI profile",
		provider: "openai",
		modelId: "gpt-test",
		enabled: true,
		openai: {
			reasoning: { enableThinking: true, effort: "medium" },
			serviceTier: "default",
		},
	})
}

function createController() {
	const order: string[] = []
	const setTaskSettingsBatch = vi.fn()
	const setTaskSettings = vi.fn()
	const clearTaskSetting = vi.fn()
	const flushPendingState = vi.fn(async () => {
		order.push("flush")
	})
	const rebuildApiHandler = vi.fn(async () => {
		order.push("rebuild")
	})
	const flushPromptFreshnessInvalidation = vi.fn(async () => {
		order.push("freshness")
	})
	const postStateToWebview = vi.fn(async () => {
		order.push("post")
	})
	const getApiConfigurationForTask = vi.fn(() => ({
		planModeProfileId: "profile-1",
		planModeProfile: "OpenAI profile",
		actModeProfileId: "profile-1",
		actModeProfile: "OpenAI profile",
	}))
	const controller = {
		stateManager: {
			setTaskSettingsBatch,
			setTaskSettings,
			clearTaskSetting,
			flushPendingState,
			getApiConfigurationForTask,
			getGlobalSettingsKey: vi.fn((key: string) => {
				if (key === "autoApprovalSettings") return { actions: {} }
				if (key === "browserSettings") return { viewport: { width: 900, height: 600 } }
				if (key === "mode") return "act"
				return undefined
			}),
		},
		task: { taskId: "task-1", rebuildApiHandler, flushPromptFreshnessInvalidation },
		restartAccountUsagePolling: vi.fn(),
		postStateToWebview,
	} as unknown as Controller

	return {
		clearTaskSetting,
		controller,
		flushPendingState,
		flushPromptFreshnessInvalidation,
		getApiConfigurationForTask,
		order,
		postStateToWebview,
		rebuildApiHandler,
		setTaskSettings,
		setTaskSettingsBatch,
	}
}

beforeEach(() => {
	findEnabledProfileByName.mockReset()
	getProfileModelInfo.mockReset()
	readApiProfiles.mockReset()
	findEnabledProfileByName.mockReturnValue(createOpenAiProfile())
	readApiProfiles.mockReturnValue([createOpenAiProfile()])
	getProfileModelInfo.mockReturnValue({
		capabilities: {
			thinking: {
				supported: true,
				effortLevels: ["none", "low", "medium", "high"],
				maxBudget: 8_192,
			},
		},
	})
})

describe("updateTaskSettings Task runtime overrides", () => {
	it("validates, durably commits, and rebuilds the active handler exactly once", async () => {
		const fixture = createController()

		await updateTaskSettings(
			fixture.controller,
			UpdateTaskSettingsRequest.create({
				taskId: "task-1",
				settings: {
					actModeReasoningOverrideKind: "effort",
					actModeReasoningOverrideEffort: "high",
					actModeServiceTierOverrideKind: "tier",
					actModeServiceTierOverrideTier: "priority",
				},
			}),
		)

		expect(fixture.setTaskSettings).toHaveBeenCalledWith("task-1", "actModeReasoningOverrideKind", "effort")
		expect(fixture.setTaskSettings).toHaveBeenCalledWith("task-1", "actModeReasoningOverrideEffort", "high")
		expect(fixture.setTaskSettings).toHaveBeenCalledWith("task-1", "actModeServiceTierOverrideKind", "tier")
		expect(fixture.setTaskSettings).toHaveBeenCalledWith("task-1", "actModeServiceTierOverrideTier", "priority")
		expect(fixture.flushPendingState).toHaveBeenCalledOnce()
		expect(fixture.rebuildApiHandler).toHaveBeenCalledOnce()
		expect(fixture.order).toEqual(["flush", "rebuild", "post"])
	})

	it("rejects an effort not declared by ModelInfo before any Task settings write", async () => {
		const fixture = createController()
		getProfileModelInfo.mockReturnValue({ capabilities: { supportsReasoning: true } })

		await expect(
			updateTaskSettings(
				fixture.controller,
				UpdateTaskSettingsRequest.create({
					taskId: "task-1",
					settings: {
						actModeReasoningOverrideKind: "effort",
						actModeReasoningOverrideEffort: "high",
					},
				}),
			),
		).rejects.toThrow("Reasoning effort 'high' is not supported by the selected model.")

		expect(fixture.setTaskSettings).not.toHaveBeenCalled()
		expect(fixture.setTaskSettingsBatch).not.toHaveBeenCalled()
		expect(fixture.flushPendingState).not.toHaveBeenCalled()
		expect(fixture.rebuildApiHandler).not.toHaveBeenCalled()
	})

	it("uses the stable Profile ID when the compatibility name is stale", async () => {
		const fixture = createController()
		fixture.getApiConfigurationForTask.mockReturnValue({
			planModeProfileId: "profile-1",
			planModeProfile: "OpenAI profile",
			actModeProfileId: "profile-1",
			actModeProfile: "stale-profile-name",
		})
		findEnabledProfileByName.mockReturnValue(undefined)

		await updateTaskSettings(
			fixture.controller,
			UpdateTaskSettingsRequest.create({
				taskId: "task-1",
				settings: {
					actModeReasoningOverrideKind: "effort",
					actModeReasoningOverrideEffort: "low",
					actModeServiceTierOverrideKind: "tier",
					actModeServiceTierOverrideTier: "priority",
				},
			}),
		)

		expect(fixture.setTaskSettings).toHaveBeenCalledWith("task-1", "actModeReasoningOverrideEffort", "low")
		expect(fixture.setTaskSettings).toHaveBeenCalledWith("task-1", "actModeServiceTierOverrideTier", "priority")
		expect(fixture.rebuildApiHandler).toHaveBeenCalledOnce()
	})

	it("clears inherit fields and the legacy effort before one durable rebuild", async () => {
		const fixture = createController()

		await updateTaskSettings(
			fixture.controller,
			UpdateTaskSettingsRequest.create({
				taskId: "task-1",
				settings: {
					planModeReasoningOverrideKind: "inherit",
					planModeServiceTierOverrideKind: "inherit",
				},
			}),
		)

		for (const key of [
			"planModeReasoningOverrideKind",
			"planModeReasoningOverrideEffort",
			"planModeThinkingBudgetTokens",
			"planModeReasoningEffort",
			"planModeServiceTierOverrideKind",
			"planModeServiceTierOverrideTier",
		]) {
			expect(fixture.clearTaskSetting).toHaveBeenCalledWith("task-1", key)
		}
		expect(fixture.flushPendingState).toHaveBeenCalledOnce()
		expect(fixture.rebuildApiHandler).toHaveBeenCalledOnce()
	})

	it("rejects unsupported reasoning before mutating Task settings", async () => {
		const fixture = createController()

		await expect(
			updateTaskSettings(
				fixture.controller,
				UpdateTaskSettingsRequest.create({
					taskId: "task-1",
					settings: {
						actModeReasoningOverrideKind: "effort",
						actModeReasoningOverrideEffort: "xhigh",
					},
				}),
			),
		).rejects.toThrow("Reasoning effort 'xhigh' is not supported by the selected model.")

		expect(fixture.setTaskSettings).not.toHaveBeenCalled()
		expect(fixture.setTaskSettingsBatch).not.toHaveBeenCalled()
		expect(fixture.flushPendingState).not.toHaveBeenCalled()
		expect(fixture.postStateToWebview).not.toHaveBeenCalled()
	})

	it("commits an override while another request can retain its captured handler", async () => {
		const fixture = createController()

		await updateTaskSettings(
			fixture.controller,
			UpdateTaskSettingsRequest.create({
				taskId: "task-1",
				settings: {
					actModeServiceTierOverrideKind: "tier",
					actModeServiceTierOverrideTier: "flex",
				},
			}),
		)

		expect(fixture.setTaskSettings).toHaveBeenCalledWith("task-1", "actModeServiceTierOverrideTier", "flex")
		expect(fixture.flushPendingState).toHaveBeenCalledOnce()
		expect(fixture.rebuildApiHandler).toHaveBeenCalledOnce()
		expect(fixture.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("does not rebuild or publish when durable persistence fails", async () => {
		const fixture = createController()
		fixture.flushPendingState.mockRejectedValueOnce(new Error("durable Task write failed"))

		await expect(
			updateTaskSettings(
				fixture.controller,
				UpdateTaskSettingsRequest.create({
					taskId: "task-1",
					settings: {
						actModeReasoningOverrideKind: "budget",
						actModeThinkingBudgetTokens: 4_096,
					},
				}),
			),
		).rejects.toThrow("durable Task write failed")

		expect(fixture.rebuildApiHandler).not.toHaveBeenCalled()
		expect(fixture.postStateToWebview).not.toHaveBeenCalled()
	})

	it("re-evaluates the active Task after the complete capability snapshot is durable", async () => {
		const fixture = createController()
		const taskCapabilityToggles = serializeTaskCapabilityToggles(
			createTaskCapabilityToggles({
				localWorkflowToggles: { "e:/workspace/project/.agents/workflows/review.md": false },
				localSkillsToggles: { "e:/workspace/project/.agents/skills/review/SKILL.md": true },
				localSubagentsToggles: { "e:/workspace/project/.agents/subagents/reviewer.yaml": true },
				mcpServers: { docs: true },
			}),
		)

		await updateTaskSettings(
			fixture.controller,
			UpdateTaskSettingsRequest.create({ taskId: "task-1", settings: { taskCapabilityToggles } }),
		)

		expect(fixture.flushPromptFreshnessInvalidation).toHaveBeenCalledWith("task_capability_toggle")
		expect(fixture.order).toEqual(["flush", "freshness"])
		expect(fixture.postStateToWebview).not.toHaveBeenCalled()
	})

	it("does not re-evaluate the active Task when updating another Task capability snapshot", async () => {
		const fixture = createController()
		const taskCapabilityToggles = serializeTaskCapabilityToggles(createTaskCapabilityToggles({ mcpServers: { docs: false } }))

		await updateTaskSettings(
			fixture.controller,
			UpdateTaskSettingsRequest.create({ taskId: "task-2", settings: { taskCapabilityToggles } }),
		)

		expect(fixture.flushPromptFreshnessInvalidation).not.toHaveBeenCalled()
		expect(fixture.order).toEqual(["flush", "post"])
	})
})
