import { strict as assert } from "node:assert"
import * as api from "@core/api"
import * as profileStore from "@core/controller/file/getApiProfiles"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import type { ApiConfiguration } from "@shared/api"
import { afterEach, describe, it, vi } from "vitest"
// sinon import removed: using vitest globals
import { ClineDefaultTool } from "@/shared/tools"
import { AgentConfigLoader } from "../AgentConfigLoader"
import { SUBAGENT_DEFAULT_ALLOWED_TOOLS, SUBAGENT_SYSTEM_SUFFIX, SubagentBuilder } from "../SubagentBuilder"

/**
 * Create the minimal task config needed by SubagentBuilder tests.
 *
 * @param mode Current global mode returned by state manager.
 * @param provider Current act and plan profile name.
 * @returns TaskConfig test double.
 */
function createTaskConfig(
	mode: "act" | "plan",
	provider: string,
	actModeReasoningOverride?: { kind: "effort"; effort: string },
	actModeServiceTierOverride?: ApiConfiguration["actModeServiceTierOverride"],
	actModeProfileId?: string,
): TaskConfig {
	return {
		taskId: "task-1",
		ulid: "ulid-123",
		services: {
			stateManager: {
				getGlobalSettingsKey: (key: string) => (key === "mode" ? mode : undefined),
				getApiConfiguration: () => {
					throw new Error("SubagentBuilder must not consult the shared active-task cursor")
				},
				getApiConfigurationForTask: (taskId?: string) => {
					assert.equal(taskId, "task-1")
					return {
						actModeProfileId,
						actModeProfile: provider,
						planModeProfile: provider,
						actModeReasoningOverride,
						actModeServiceTierOverride,
						actModeApiModelId: "act-default",
						planModeApiModelId: "plan-default",
						actModeOpenAiModelId: "openai-act-default",
						planModeOpenRouterModelId: "openrouter-plan-default",
					} as any
				},
			},
		},
	} as unknown as TaskConfig
}

describe("SubagentBuilder", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("uses cached config profile when it supports subagents", () => {
		const agentConfig = {
			name: "cached-agent",
			description: "cached description",
			tools: [ClineDefaultTool.LIST_FILES],
			profile: "subagent-profile",
			systemPrompt: "cached system prompt",
		}
		vi.spyOn(profileStore, "readApiProfiles").mockReturnValue([
			{ name: "subagent-profile", enabled: true, usedFor: ["subagents"] },
		] as ReturnType<typeof profileStore.readApiProfiles>)

		const fakeHandler = { getModel: vi.fn(), createMessage: vi.fn() }
		const buildApiHandlerStub = vi.spyOn(api, "buildApiHandlerFromProfile").mockReturnValue(fakeHandler as never)

		const builder = new SubagentBuilder(createTaskConfig("act", "act-default-profile"), "cached-agent", agentConfig)

		assert.equal(buildApiHandlerStub.mock.calls.length, 1)
		const [effectiveApiConfig, selectedMode] = buildApiHandlerStub.mock.calls[0]
		assert.equal(selectedMode, "act")
		assert.equal((effectiveApiConfig as Record<string, unknown>).ulid, "ulid-123")
		assert.equal((effectiveApiConfig as Record<string, unknown>).actModeProfile, "subagent-profile")
		assert.equal((effectiveApiConfig as Record<string, unknown>).planModeProfile, "act-default-profile")
		assert.equal(builder.getProfileName(), "subagent-profile")

		assert.deepEqual(builder.getAllowedTools(), [ClineDefaultTool.LIST_FILES, ClineDefaultTool.ATTEMPT])
		const prompt = builder.buildSystemPrompt("generated system prompt")
		assert.match(prompt, /^generated system prompt/)
		assert.match(prompt, /# Subagent Custom Instructions/)
		assert.match(prompt, /cached system prompt/)
		assert.match(prompt, /# Agent Profile/)
		assert.match(prompt, /Name: cached-agent/)
		assert.match(prompt, /Description: cached description/)
		assert.match(prompt, /Plain assistant text cannot complete a subagent run/)
		assert.match(prompt, /attempt_completion/)
		assert.match(prompt, new RegExp(SUBAGENT_SYSTEM_SUFFIX.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
	})

	it("keeps an explicit subagent Profile effort instead of applying the parent Task override", () => {
		const agentConfig = {
			name: "reviewer",
			description: "Reviews with an independent Profile",
			tools: [ClineDefaultTool.LIST_FILES],
			profile: "subagent-profile",
			systemPrompt: "Review carefully.",
		}
		vi.spyOn(profileStore, "readApiProfiles").mockReturnValue([
			{
				id: "profile-child",
				name: "subagent-profile",
				provider: "openai",
				apiKey: "",
				modelId: "claude-opus-4-7",
				usedFor: ["subagents"],
				enabled: true,
				modelInfo: {
					id: "claude-opus-4-7",
					capabilities: {
						supportsReasoning: true,
						thinking: { supported: true, mode: "effort", effortLevels: ["low", "high"] },
					},
				},
				openai: {
					reasoning: { enableThinking: true, effort: "low" },
					serviceTier: "default",
					serviceTierEnabled: true,
				},
			},
		] as ReturnType<typeof profileStore.readApiProfiles>)
		const buildApiHandlerStub = vi
			.spyOn(api, "buildApiHandlerFromProfile")
			.mockReturnValue({ getModel: vi.fn(), createMessage: vi.fn() } as never)

		const serviceTierOverride = { kind: "tier", tier: "ultrafast" } as const
		const builder = new SubagentBuilder(
			createTaskConfig("act", "parent-profile", { kind: "effort", effort: "max" }, serviceTierOverride),
			"reviewer",
			agentConfig,
		)

		assert.deepEqual(builder.getReasoningConfig(), { enableThinking: true, effort: "low" })
		const [effectiveApiConfig] = buildApiHandlerStub.mock.calls[0]
		assert.equal(effectiveApiConfig.actModeProfile, "subagent-profile")
		assert.equal(effectiveApiConfig.actModeProfileId, "profile-child")
		assert.equal(effectiveApiConfig.actModeReasoningOverride, undefined)
		assert.deepEqual(effectiveApiConfig.actModeServiceTierOverride, serviceTierOverride)
	})

	it("keeps an explicit subagent Profile budget when the parent Task uses an effort override", () => {
		const agentConfig = {
			name: "budget-reviewer",
			description: "Reviews with a fixed child budget",
			tools: [ClineDefaultTool.LIST_FILES],
			profile: "budget-profile",
			systemPrompt: "Review within the configured budget.",
		}
		vi.spyOn(profileStore, "readApiProfiles").mockReturnValue([
			{
				id: "profile-budget",
				name: "budget-profile",
				provider: "anthropic",
				apiKey: "",
				modelId: "claude-sonnet-4-6",
				usedFor: ["subagents"],
				enabled: true,
				modelInfo: {
					id: "claude-sonnet-4-6",
					capabilities: {
						supportsReasoning: true,
						thinking: { supported: true, mode: "budget", maxBudget: 8_192 },
					},
				},
				anthropic: { reasoning: { enableThinking: true, effort: "", thinkingBudget: 2_048 } },
			},
		] as ReturnType<typeof profileStore.readApiProfiles>)
		vi.spyOn(api, "buildApiHandlerFromProfile").mockReturnValue({ getModel: vi.fn(), createMessage: vi.fn() } as never)

		const builder = new SubagentBuilder(
			createTaskConfig("act", "parent-profile", { kind: "effort", effort: "high" }),
			"budget-reviewer",
			agentConfig,
		)

		assert.deepEqual(builder.getReasoningConfig(), { enableThinking: true, effort: "", thinkingBudget: 2_048 })
	})

	it("applies the parent Task overrides when the subagent falls back to the parent Act Profile", () => {
		vi.spyOn(profileStore, "readApiProfiles").mockReturnValue([
			{
				id: "profile-parent",
				name: "openai-parent",
				provider: "openai",
				apiKey: "",
				modelId: "claude-opus-4-7",
				usedFor: ["act", "subagents"],
				enabled: true,
				modelInfo: {
					id: "claude-opus-4-7",
					capabilities: {
						supportsReasoning: true,
						thinking: { supported: true, mode: "effort", effortLevels: ["low", "high"] },
					},
				},
				openai: {
					reasoning: { enableThinking: true, effort: "low" },
					serviceTier: "default",
					serviceTierEnabled: true,
				},
			},
		] as ReturnType<typeof profileStore.readApiProfiles>)
		const buildApiHandlerStub = vi
			.spyOn(api, "buildApiHandlerFromProfile")
			.mockReturnValue({ getModel: vi.fn(), createMessage: vi.fn() } as never)

		const serviceTierOverride = { kind: "tier", tier: "flex" } as const
		const builder = new SubagentBuilder(
			createTaskConfig("act", "openai-parent", { kind: "effort", effort: "high" }, serviceTierOverride),
		)

		assert.deepEqual(builder.getReasoningConfig(), { enableThinking: true, effort: "high", thinkingBudget: undefined })
		const [effectiveApiConfig] = buildApiHandlerStub.mock.calls[0]
		assert.deepEqual(effectiveApiConfig.actModeReasoningOverride, { kind: "effort", effort: "high" })
		assert.deepEqual(effectiveApiConfig.actModeServiceTierOverride, serviceTierOverride)
	})

	it("resolves the parent fallback by stable Profile ID when its display name is stale", () => {
		const parentProfile = {
			id: "profile-parent",
			name: "renamed-parent",
			provider: "anthropic",
			apiKey: "",
			modelId: "claude-opus-4-7",
			usedFor: ["act", "subagents"],
			enabled: true,
			modelInfo: {
				id: "claude-opus-4-7",
				capabilities: {
					supportsReasoning: true,
					thinking: { supported: true, mode: "effort", effortLevels: ["low", "high"] },
				},
			},
			anthropic: { reasoning: { enableThinking: true, effort: "low" } },
		}
		vi.spyOn(profileStore, "readApiProfiles").mockReturnValue([parentProfile] as ReturnType<
			typeof profileStore.readApiProfiles
		>)
		const buildApiHandlerStub = vi
			.spyOn(api, "buildApiHandlerFromProfile")
			.mockReturnValue({ getModel: vi.fn(), createMessage: vi.fn() } as never)

		const builder = new SubagentBuilder(createTaskConfig("act", "stale-parent-name", undefined, undefined, "profile-parent"))

		assert.deepEqual(builder.getReasoningConfig(), { enableThinking: true, effort: "low" })
		const [effectiveApiConfig, selectedMode, selectedProfile] = buildApiHandlerStub.mock.calls[0]
		assert.equal(selectedMode, "act")
		assert.equal(effectiveApiConfig.actModeProfile, "renamed-parent")
		assert.equal(effectiveApiConfig.actModeProfileId, "profile-parent")
		assert.equal(selectedProfile, parentProfile)
	})

	it("falls back to the parent Profile when an explicit subagent Profile name is ambiguous", () => {
		const parentProfile = {
			id: "profile-parent",
			name: "parent-profile",
			provider: "anthropic",
			apiKey: "",
			modelId: "claude-opus-4-7",
			usedFor: ["act", "subagents"],
			enabled: true,
			modelInfo: {
				id: "claude-opus-4-7",
				capabilities: {
					supportsReasoning: true,
					thinking: { supported: true, mode: "effort", effortLevels: ["low", "high"] },
				},
			},
			anthropic: { reasoning: { enableThinking: true, effort: "low" } },
		}
		vi.spyOn(profileStore, "readApiProfiles").mockReturnValue([
			parentProfile,
			{ id: "duplicate-a", name: "duplicate-child", enabled: true, usedFor: ["subagents"] },
			{ id: "duplicate-b", name: "duplicate-child", enabled: true, usedFor: ["subagents"] },
		] as ReturnType<typeof profileStore.readApiProfiles>)
		const buildApiHandlerStub = vi
			.spyOn(api, "buildApiHandlerFromProfile")
			.mockReturnValue({ getModel: vi.fn(), createMessage: vi.fn() } as never)
		const agentConfig = {
			name: "ambiguous-agent",
			description: "ambiguous child Profile",
			tools: [ClineDefaultTool.FILE_READ],
			profile: "duplicate-child",
			systemPrompt: "fallback system",
		}

		const builder = new SubagentBuilder(
			createTaskConfig("act", "parent-profile", { kind: "effort", effort: "high" }, undefined, "profile-parent"),
			"ambiguous-agent",
			agentConfig,
		)

		assert.deepEqual(builder.getReasoningConfig(), { enableThinking: true, effort: "high", thinkingBudget: undefined })
		const [effectiveApiConfig, , selectedProfile] = buildApiHandlerStub.mock.calls[0]
		assert.equal(effectiveApiConfig.actModeProfile, "parent-profile")
		assert.equal(effectiveApiConfig.actModeProfileId, "profile-parent")
		assert.deepEqual(effectiveApiConfig.actModeReasoningOverride, { kind: "effort", effort: "high" })
		assert.equal(selectedProfile, parentProfile)
	})

	it("uses defaults when no cached config is provided", () => {
		vi.spyOn(AgentConfigLoader, "getInstance").mockReturnValue({
			getCachedConfig: () => undefined,
		} as unknown as AgentConfigLoader)

		vi.spyOn(api, "buildApiHandler").mockReturnValue({ getModel: vi.fn(), createMessage: vi.fn() } as never)
		const builder = new SubagentBuilder(createTaskConfig("act", "anthropic"))

		assert.deepEqual(builder.getAllowedTools(), SUBAGENT_DEFAULT_ALLOWED_TOOLS)
		const prompt = builder.buildSystemPrompt("generated prompt")
		assert.equal(prompt, `generated prompt\n\n${SUBAGENT_SYSTEM_SUFFIX}`)
	})

	it("falls back to default act profile when configured profile is missing", () => {
		const agentConfig = {
			name: "missing-profile-agent",
			description: "missing profile agent",
			tools: [ClineDefaultTool.FILE_READ],
			profile: "deleted-profile",
			systemPrompt: "fallback system",
		}
		vi.spyOn(profileStore, "readApiProfiles").mockReturnValue([
			{ name: "another-profile", enabled: true, usedFor: ["subagents"] },
		] as ReturnType<typeof profileStore.readApiProfiles>)

		const buildApiHandlerStub = vi.spyOn(api, "buildApiHandler").mockReturnValue({
			getModel: vi.fn(),
			createMessage: vi.fn(),
		} as never)

		new SubagentBuilder(createTaskConfig("plan", "act-default-profile"), "missing-profile-agent", agentConfig)

		const [effectiveApiConfig, selectedMode] = buildApiHandlerStub.mock.calls[0]
		assert.equal(selectedMode, "act")
		assert.equal((effectiveApiConfig as Record<string, unknown>).actModeProfile, "act-default-profile")
		assert.equal((effectiveApiConfig as Record<string, unknown>).planModeProfile, "act-default-profile")
	})

	it.each([
		"disabled-profile",
		"plan-only-profile",
	])("falls back to default act profile when configured profile %s cannot be used by subagents", (configuredProfile) => {
		const agentConfig = {
			name: "invalid-profile-agent",
			description: "invalid profile agent",
			tools: [ClineDefaultTool.FILE_READ],
			profile: configuredProfile,
			systemPrompt: "fallback system",
		}
		vi.spyOn(profileStore, "readApiProfiles").mockReturnValue([
			{ name: "disabled-profile", enabled: false, usedFor: ["subagents"] },
			{ name: "plan-only-profile", enabled: true, usedFor: ["plan"] },
		] as ReturnType<typeof profileStore.readApiProfiles>)

		const buildApiHandlerStub = vi.spyOn(api, "buildApiHandler").mockReturnValue({
			getModel: vi.fn(),
			createMessage: vi.fn(),
		} as never)

		new SubagentBuilder(createTaskConfig("act", "act-default-profile"), "invalid-profile-agent", agentConfig)

		const [effectiveApiConfig, selectedMode] = buildApiHandlerStub.mock.calls[0]
		assert.equal(selectedMode, "act")
		assert.equal((effectiveApiConfig as Record<string, unknown>).actModeProfile, "act-default-profile")
	})

	it.each([
		[undefined, []],
		[null, []],
		["missing-profile", []],
		["disabled-profile", [{ name: "disabled-profile", enabled: false, usedFor: ["subagents"] }]],
		["plan-only-profile", [{ name: "plan-only-profile", enabled: true, usedFor: ["plan"] }]],
	] as const)("rejects generate_image without an available explicit subagent Profile: %s", (profile, profiles) => {
		vi.spyOn(profileStore, "readApiProfiles").mockReturnValue(
			profiles as unknown as ReturnType<typeof profileStore.readApiProfiles>,
		)
		vi.spyOn(api, "buildApiHandler").mockReturnValue({ getModel: vi.fn(), createMessage: vi.fn() } as never)

		expect(
			() =>
				new SubagentBuilder(createTaskConfig("act", "parent-profile"), "image-agent", {
					name: "image-agent",
					description: "image agent",
					profile,
					tools: [ClineDefaultTool.GENERATE_IMAGE],
					systemPrompt: "",
				}),
		).toThrow(/generate_image require an explicit API Profile|unavailable or not enabled for subagents/)
	})

	it("removes execute_command from the built-in default even when a legacy YAML still declares it", () => {
		const agentConfig = {
			name: "default",
			description: "legacy default",
			tools: [ClineDefaultTool.FILE_READ, ClineDefaultTool.BASH],
			systemPrompt: "legacy prompt",
		}
		vi.spyOn(api, "buildApiHandler").mockReturnValue({ getModel: vi.fn(), createMessage: vi.fn() } as never)

		const builder = new SubagentBuilder(createTaskConfig("act", "anthropic"), "default", agentConfig)

		assert.deepEqual(builder.getAllowedTools(), [ClineDefaultTool.FILE_READ, ClineDefaultTool.ATTEMPT])
	})

	it("preserves explicitly configured execute_command for a named custom subagent", () => {
		const agentConfig = {
			name: "ops-reviewer",
			description: "custom reviewer",
			tools: [ClineDefaultTool.BASH],
			systemPrompt: "custom prompt",
		}
		vi.spyOn(api, "buildApiHandler").mockReturnValue({ getModel: vi.fn(), createMessage: vi.fn() } as never)

		const builder = new SubagentBuilder(createTaskConfig("act", "anthropic"), "ops-reviewer", agentConfig)

		assert.deepEqual(builder.getAllowedTools(), [ClineDefaultTool.BASH, ClineDefaultTool.ATTEMPT])
	})

	it("exposes the exact configured allowlist for facade filtering", () => {
		const agentConfig = {
			name: "tools-agent",
			description: "tool-limited",
			tools: [ClineDefaultTool.LIST_FILES],
			profile: "tool-profile",
			systemPrompt: "tool prompt",
		}
		vi.spyOn(api, "buildApiHandler").mockReturnValue({ getModel: vi.fn(), createMessage: vi.fn() } as never)

		const builder = new SubagentBuilder(createTaskConfig("act", "anthropic"), "tools-agent", agentConfig)

		assert.deepEqual(builder.getAllowedTools(), [ClineDefaultTool.LIST_FILES, ClineDefaultTool.ATTEMPT])
	})

	it("degrades to the reporting tool when every configured tool was rejected", () => {
		const agentConfig = {
			name: "narrow-agent",
			description: "asked for tools policy forbids",
			tools: [],
			// The loader sets this when a written list was rejected in full.
			toolsExplicitlyNarrowed: true,
			systemPrompt: "narrow prompt",
		}
		vi.spyOn(api, "buildApiHandler").mockReturnValue({ getModel: vi.fn(), createMessage: vi.fn() } as never)

		const builder = new SubagentBuilder(createTaskConfig("act", "anthropic"), "narrow-agent", agentConfig)

		// Inheriting the default allowlist here would grant read_file,
		// list_files, search_files and more to an author who asked for less.
		assert.deepEqual(builder.getAllowedTools(), [ClineDefaultTool.ATTEMPT])
	})

	it("still inherits the default allowlist when no tools were configured at all", () => {
		const agentConfig = {
			name: "inheriting-agent",
			description: "no tools field",
			tools: [],
			systemPrompt: "inheriting prompt",
		}
		vi.spyOn(api, "buildApiHandler").mockReturnValue({ getModel: vi.fn(), createMessage: vi.fn() } as never)

		const builder = new SubagentBuilder(createTaskConfig("act", "anthropic"), "inheriting-agent", agentConfig)

		assert.deepEqual(builder.getAllowedTools(), [
			ClineDefaultTool.FILE_READ,
			ClineDefaultTool.LIST_FILES,
			ClineDefaultTool.SEARCH,
			ClineDefaultTool.LIST_CODE_DEF,
			ClineDefaultTool.LOAD_SKILL,
			ClineDefaultTool.ATTEMPT,
		])
	})
})
