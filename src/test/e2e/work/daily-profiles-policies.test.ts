import path from "node:path"
import type { MockApiConsumption, MockTokenUsage } from "@e2e/fixtures/server"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import {
	closeWorkCapabilities,
	createWorkspaceTaskStartHook,
	enableWorkspaceTaskStartHook,
	expectWorkPromptStale,
	openWorkCapabilities,
	refreshWorkPrompt,
	seedWorkPolicyResources,
	selectWorkCapabilityTab,
	selectWorkSlashCommand,
	type WorkPolicyMarkers,
	waitForWorkFileMarker,
	waitForWorkspaceTaskStartHook,
	workspaceTaskStartHookPath,
	writeWorkRuleVersionTwo,
	writeWorkspaceTaskStartHook,
} from "@e2e/utils/work/policy-resources"
import {
	closeWorkTask,
	expandWorkProfileCard,
	finishWorkSettings,
	getWorkProfileCard,
	openWorkHistoryTask,
	openWorkSettings,
	readWorkProfileCatalogText,
	readWorkProfiles,
	renameWorkProfile,
	selectWorkModel,
	selectWorkProfile,
	sendWorkMessageWithCtrlEnter,
	setWorkCheckbox,
	setWorkCustomBaseUrl,
	setWorkCustomModelId,
	setWorkFeature,
	setWorkSendShortcut,
	setWorkWebToolsMode,
	waitForWorkProfile,
	waitForWorkSetting,
	waitForWorkTaskBinding,
	workModelPickerInput,
	workTaskIdByMarker,
} from "@e2e/utils/work/profiles-policies"
import { prepareWorkSession, sendWorkMessage } from "@e2e/utils/work/session"
import { expect, type Frame, type Page } from "@playwright/test"
import type { ElectronApplication } from "playwright"

const DEEPSEEK_TARGET = "deepseek-chat" as const
const OPENAI_TARGET = "openai-compatible-chat" as const
const ANTHROPIC_TARGET = "anthropic-messages" as const
const OPENAI_MODEL = "work-daily-openai-custom"
const DEEPSEEK_MODEL = "work-daily-deepseek-free-form"
const ANTHROPIC_MODEL = "claude-sonnet-4-6"
const RENAMED_ANTHROPIC_PROFILE = `${E2E_PROFILE_NAMES.mockAnthropic} Daily Renamed`
const SKILL_TASK_MARKER = "WORK_PROFILES_POLICIES_SKILL"
const TASK_MARKER = "WORK_PROFILES_POLICIES_DEEPSEEK"
const DEEPSEEK_STALE_INPUT = "WORK_PROFILES_POLICIES_DEEPSEEK_STALE README.md"
const OPENAI_INPUT = "WORK_PROFILES_POLICIES_OPENAI README.md"
const ANTHROPIC_INPUT = "WORK_PROFILES_POLICIES_ANTHROPIC README.md"
const RESTART_INPUT = "WORK_PROFILES_POLICIES_RESTART README.md"
const SKILL_READY = "WORK_PROFILES_POLICIES_SKILL_READY"
const DEEPSEEK_READY = "WORK_PROFILES_POLICIES_DEEPSEEK_READY"
const DEEPSEEK_FROZEN_READY = "WORK_PROFILES_POLICIES_DEEPSEEK_FROZEN_READY"
const OPENAI_READY = "WORK_PROFILES_POLICIES_OPENAI_READY"
const ANTHROPIC_READY = "WORK_PROFILES_POLICIES_ANTHROPIC_READY"
const FINAL_COMPLETE = "WORK_PROFILES_POLICIES_COMPLETE"
const HOOK_CONTEXT = "WORK_PROFILES_POLICIES_HOOK_CONTEXT"
const HOOK_FILE_MARKER = "WORK_POLICY_HOOK_RAN"

const POLICY_MARKERS: WorkPolicyMarkers = {
	globalRuleV1: "WORK_GLOBAL_RULE_V1",
	globalRuleV2: "WORK_GLOBAL_RULE_V2",
	workspaceRuleV1: "WORK_WORKSPACE_RULE_V1",
	workspaceRuleV2: "WORK_WORKSPACE_RULE_V2",
	conditionalRuleV1: "WORK_CONDITIONAL_RULE_V1",
	conditionalRuleV2: "WORK_CONDITIONAL_RULE_V2",
	workflowName: "work-daily-policy-workflow",
	workflowMarker: "WORK_POLICY_WORKFLOW_MARKER",
	skillName: "work-daily-policy-skill",
	skillMarker: "WORK_POLICY_SKILL_MARKER",
}

const USAGE: MockTokenUsage = { inputTokens: 3_000, outputTokens: 100 }

function responseNames(consumptions: readonly MockApiConsumption[]): string[] {
	return consumptions.map((consumption) => consumption.toolName ?? consumption.responseType)
}

function expectProviderRequest(
	consumption: MockApiConsumption | undefined,
	protocol: string,
	model: string,
): asserts consumption is MockApiConsumption {
	if (!consumption) throw new Error(`Missing ${protocol} consumption`)
	expect(consumption.protocol).toBe(protocol)
	expect((consumption.requestBody as { model?: unknown }).model).toBe(model)
	expect(consumption.contractError).toBeUndefined()
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<{ page: Page; sidebar: Frame }> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await prepareWorkSession(sidebar, helper)
	return { page, sidebar }
}

function profileByName<T extends { name: string }>(profiles: readonly T[], name: string): T {
	const profile = profiles.find((candidate) => candidate.name === name)
	if (!profile) throw new Error(`Missing E2E Profile ${name}`)
	return profile
}

async function submitSelectedSlashCommand(input: ReturnType<Frame["getByTestId"]>, prefix: string, text: string): Promise<void> {
	await input.fill(`${prefix}${text}`)
	await input.press("Control+Enter")
}

e2e(
	"daily profiles and policies remain continuous across providers and restart",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(600_000)
		const resources = await seedWorkPolicyResources(dlineDocsDir, workspaceDir, POLICY_MARKERS)
		const initialProfiles = await readWorkProfiles(dlineDir)
		const openAiProfile = profileByName(initialProfiles, E2E_PROFILE_NAMES.mockOpenAi)
		const deepSeekProfile = profileByName(initialProfiles, E2E_PROFILE_NAMES.mockDeepSeek)
		const anthropicProfile = profileByName(initialProfiles, E2E_PROFILE_NAMES.mockAnthropic)
		if (!openAiProfile.baseUrl || !deepSeekProfile.modelId || !anthropicProfile.baseUrl) {
			throw new Error("Mock Profile fixtures are missing their routed base URL or default model")
		}
		const workspaceName = path.basename(workspaceDir)
		const hookPath = workspaceTaskStartHookPath(workspaceDir)
		const hookMarkerPath = path.join(workspaceDir, "work-policy-task-start-marker.txt")

		let app: ElectronApplication | undefined
		try {
			app = await openVSCode(workspaceDir)
			let { page, sidebar } = await openSidebar(app, helper)

			await openWorkSettings(page, sidebar)
			const openAiCard = await expandWorkProfileCard(sidebar, E2E_PROFILE_NAMES.mockOpenAi)
			await setWorkCheckbox(openAiCard, "Use custom base URL", false)
			await waitForWorkProfile(dlineDir, openAiProfile.id, (profile) => profile.baseUrl === undefined)
			await setWorkCustomBaseUrl(openAiCard, openAiProfile.baseUrl)
			await setWorkCustomModelId(openAiCard, OPENAI_MODEL)
			await waitForWorkProfile(
				dlineDir,
				openAiProfile.id,
				(profile) =>
					profile.baseUrl === openAiProfile.baseUrl &&
					profile.modelId === OPENAI_MODEL &&
					profile.openai?.customModelEnabled === true,
			)

			const anthropicCard = await expandWorkProfileCard(sidebar, E2E_PROFILE_NAMES.mockAnthropic)
			await selectWorkModel(anthropicCard, sidebar, ANTHROPIC_MODEL)
			await setWorkCheckbox(anthropicCard, "Use custom base URL", false)
			await waitForWorkProfile(dlineDir, anthropicProfile.id, (profile) => profile.baseUrl === undefined)
			await setWorkCustomBaseUrl(anthropicCard, anthropicProfile.baseUrl, "Default: https://api.anthropic.com")
			await waitForWorkProfile(
				dlineDir,
				anthropicProfile.id,
				(profile) => profile.baseUrl === anthropicProfile.baseUrl && profile.modelId === ANTHROPIC_MODEL,
			)

			const deepSeekCard = await expandWorkProfileCard(sidebar, E2E_PROFILE_NAMES.mockDeepSeek)
			await selectWorkModel(deepSeekCard, sidebar, deepSeekProfile.modelId)
			await selectWorkModel(deepSeekCard, sidebar, DEEPSEEK_MODEL)
			await waitForWorkProfile(dlineDir, deepSeekProfile.id, (profile) => profile.modelId === DEEPSEEK_MODEL)
			expect(await readWorkProfileCatalogText(dlineDir)).not.toContain("dline-e2e-api-key")

			await setWorkSendShortcut(sidebar, "ctrlEnter")
			await waitForWorkSetting(dlineDir, "chatInputSendShortcut", "ctrlEnter")
			await setWorkFeature(sidebar, "Hooks", true)
			await finishWorkSettings(sidebar)

			await openWorkCapabilities(sidebar)
			await selectWorkCapabilityTab(sidebar, "Workflows")
			await expect(sidebar.getByText(`${POLICY_MARKERS.workflowName}.md`, { exact: true })).toBeVisible({ timeout: 30_000 })
			await selectWorkCapabilityTab(sidebar, "Skills")
			await expect(sidebar.getByText(POLICY_MARKERS.skillName, { exact: true })).toBeVisible({ timeout: 30_000 })
			await createWorkspaceTaskStartHook(sidebar, workspaceName)
			await waitForWorkspaceTaskStartHook(hookPath)
			await writeWorkspaceTaskStartHook(hookPath, hookMarkerPath, HOOK_CONTEXT)
			await enableWorkspaceTaskStartHook(sidebar, workspaceName)
			await closeWorkCapabilities(sidebar)

			server.resetOpenAiMock()
			server.enqueueResponses(
				DEEPSEEK_TARGET,
				{
					type: "tool",
					id: "call_work_policy_skill",
					name: "attempt_completion",
					arguments: { result: SKILL_READY },
					usage: USAGE,
					expectedRequestIncludes: [
						SKILL_TASK_MARKER,
						POLICY_MARKERS.skillMarker,
						POLICY_MARKERS.globalRuleV1,
						POLICY_MARKERS.workspaceRuleV1,
						POLICY_MARKERS.conditionalRuleV1,
						HOOK_CONTEXT,
					],
					expectedRequestExcludes: [`/skills:${POLICY_MARKERS.skillName}`],
				},
				{
					type: "tool",
					id: "call_work_policy_deepseek",
					name: "attempt_completion",
					arguments: { result: DEEPSEEK_READY },
					usage: USAGE,
					expectedRequestIncludes: [
						TASK_MARKER,
						POLICY_MARKERS.globalRuleV1,
						POLICY_MARKERS.workspaceRuleV1,
						POLICY_MARKERS.conditionalRuleV1,
						POLICY_MARKERS.workflowMarker,
						HOOK_CONTEXT,
					],
					expectedRequestExcludes: [POLICY_MARKERS.globalRuleV2, `/workflow:${POLICY_MARKERS.workflowName}`],
				},
				{
					type: "tool",
					id: "call_work_policy_deepseek_frozen",
					name: "attempt_completion",
					arguments: { result: DEEPSEEK_FROZEN_READY },
					usage: USAGE,
					expectedRequestIncludes: [
						DEEPSEEK_STALE_INPUT,
						POLICY_MARKERS.globalRuleV1,
						POLICY_MARKERS.workspaceRuleV1,
						POLICY_MARKERS.conditionalRuleV1,
					],
					expectedRequestExcludes: [POLICY_MARKERS.globalRuleV2],
				},
				{ type: "error", status: 500, code: "unexpected_deepseek_request", message: "Unexpected DeepSeek request" },
			)
			server.enqueueResponses(
				OPENAI_TARGET,
				{
					type: "tool",
					id: "call_work_policy_openai",
					name: "attempt_completion",
					arguments: { result: OPENAI_READY },
					usage: USAGE,
					expectedRequestIncludes: [
						OPENAI_INPUT,
						POLICY_MARKERS.globalRuleV2,
						POLICY_MARKERS.workspaceRuleV2,
						POLICY_MARKERS.conditionalRuleV2,
					],
					expectedRequestExcludes: [POLICY_MARKERS.globalRuleV1],
				},
				{ type: "error", status: 500, code: "unexpected_openai_request", message: "Unexpected OpenAI request" },
			)
			server.enqueueResponses(
				ANTHROPIC_TARGET,
				{
					type: "tool",
					id: "call_work_policy_anthropic",
					name: "attempt_completion",
					arguments: { result: ANTHROPIC_READY },
					usage: USAGE,
					expectedRequestIncludes: [
						ANTHROPIC_INPUT,
						POLICY_MARKERS.globalRuleV2,
						POLICY_MARKERS.workspaceRuleV2,
						POLICY_MARKERS.conditionalRuleV2,
					],
					expectedRequestExcludes: [POLICY_MARKERS.globalRuleV1],
				},
				{ type: "error", status: 500, code: "unexpected_anthropic_request", message: "Unexpected Anthropic request" },
			)

			await selectWorkProfile(sidebar, E2E_PROFILE_NAMES.mockDeepSeek)
			expect(server.getRequestCount(DEEPSEEK_TARGET)).toBe(0)
			const skillInput = await selectWorkSlashCommand(sidebar, "Skills", POLICY_MARKERS.skillName, [
				workspaceDir,
				"SKILL.md",
			])
			await submitSelectedSlashCommand(skillInput, `/skills:${POLICY_MARKERS.skillName} `, `${SKILL_TASK_MARKER} README.md`)
			await expect(sidebar.getByText(SKILL_READY, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount(DEEPSEEK_TARGET)).toBe(1)
			await waitForWorkFileMarker(hookMarkerPath, HOOK_FILE_MARKER)
			await closeWorkTask(sidebar)

			const workflowInput = await selectWorkSlashCommand(sidebar, "Workflows", POLICY_MARKERS.workflowName, [
				workspaceDir,
				".agents",
			])
			await submitSelectedSlashCommand(
				workflowInput,
				`/workflow:${POLICY_MARKERS.workflowName} `,
				`${TASK_MARKER} README.md`,
			)
			await expect(sidebar.getByText(DEEPSEEK_READY, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount(DEEPSEEK_TARGET)).toBe(2)
			const taskId = await workTaskIdByMarker(dlineDocsDir, TASK_MARKER)
			await waitForWorkTaskBinding(dlineDocsDir, taskId, deepSeekProfile.id, deepSeekProfile.name)

			await writeWorkRuleVersionTwo(resources, POLICY_MARKERS)
			const refreshButton = await expectWorkPromptStale(sidebar)
			await sendWorkMessageWithCtrlEnter(sidebar, DEEPSEEK_STALE_INPUT)
			await expect(sidebar.getByText(DEEPSEEK_FROZEN_READY, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount(DEEPSEEK_TARGET)).toBe(3)

			const requestCountBeforeRefresh = server.getMockConsumptions().length
			await refreshWorkPrompt(sidebar, refreshButton)
			expect(server.getMockConsumptions()).toHaveLength(requestCountBeforeRefresh)

			await selectWorkProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAi)
			expect(server.getRequestCount(OPENAI_TARGET)).toBe(0)
			await sendWorkMessageWithCtrlEnter(sidebar, OPENAI_INPUT)
			await expect(sidebar.getByText(OPENAI_READY, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount(OPENAI_TARGET)).toBe(1)
			await waitForWorkTaskBinding(dlineDocsDir, taskId, openAiProfile.id, openAiProfile.name)

			await openWorkSettings(page, sidebar)
			const anthropicRuntimeCard = await expandWorkProfileCard(sidebar, E2E_PROFILE_NAMES.mockAnthropic)
			await setWorkWebToolsMode(anthropicRuntimeCard, "Off")
			await waitForWorkProfile(
				dlineDir,
				anthropicProfile.id,
				(profile) => profile.webToolsMode === "WEB_TOOLS_MODE_FORCE_OFF",
			)
			await finishWorkSettings(sidebar)

			await selectWorkProfile(sidebar, E2E_PROFILE_NAMES.mockAnthropic)
			expect(server.getRequestCount(ANTHROPIC_TARGET)).toBe(0)
			await sendWorkMessageWithCtrlEnter(sidebar, ANTHROPIC_INPUT)
			await expect(sidebar.getByText(ANTHROPIC_READY, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount(ANTHROPIC_TARGET)).toBe(1)
			await waitForWorkTaskBinding(dlineDocsDir, taskId, anthropicProfile.id, anthropicProfile.name)

			await openWorkSettings(page, sidebar)
			await renameWorkProfile(sidebar, dlineDir, anthropicProfile.id, anthropicProfile.name, RENAMED_ANTHROPIC_PROFILE)
			await finishWorkSettings(sidebar)
			await expect(sidebar.getByRole("button", { name: "Select model" })).toHaveText(RENAMED_ANTHROPIC_PROFILE, {
				timeout: 30_000,
			})
			await waitForWorkTaskBinding(dlineDocsDir, taskId, anthropicProfile.id, RENAMED_ANTHROPIC_PROFILE)

			await closeWorkTask(sidebar)
			await app.close()
			app = undefined
			helper.clearCachedFrame()

			app = await openVSCode(workspaceDir)
			;({ page, sidebar } = await openSidebar(app, helper))
			await openWorkSettings(page, sidebar)
			const reopenedOpenAiCard = await expandWorkProfileCard(sidebar, E2E_PROFILE_NAMES.mockOpenAi)
			await expect(reopenedOpenAiCard.locator('vscode-text-field[placeholder="Enter base URL..."] input')).toHaveValue(
				openAiProfile.baseUrl,
			)
			await expect(reopenedOpenAiCard.locator('vscode-text-field[placeholder="Enter Model ID..."] input')).toHaveValue(
				OPENAI_MODEL,
			)
			const reopenedAnthropicCard = await expandWorkProfileCard(sidebar, RENAMED_ANTHROPIC_PROFILE)
			await expect(workModelPickerInput(reopenedAnthropicCard)).toHaveValue(ANTHROPIC_MODEL)
			await expect(reopenedAnthropicCard.getByRole("combobox", { name: "Web Tools mode" })).toHaveValue("2")
			await expect(
				reopenedAnthropicCard.locator('vscode-text-field[placeholder="Default: https://api.anthropic.com"] input'),
			).toHaveValue(anthropicProfile.baseUrl)
			const reopenedDeepSeekCard = getWorkProfileCard(sidebar, E2E_PROFILE_NAMES.mockDeepSeek)
			await expect(reopenedDeepSeekCard).toHaveCount(1)
			await expandWorkProfileCard(sidebar, E2E_PROFILE_NAMES.mockDeepSeek)
			await expect(workModelPickerInput(reopenedDeepSeekCard)).toHaveValue(DEEPSEEK_MODEL)
			await sidebar.getByTestId("tab-general").click()
			await expect
				.poll(() =>
					sidebar.locator("#chat-input-send-shortcut").evaluate((element) => (element as HTMLSelectElement).value),
				)
				.toBe("ctrlEnter")
			await sidebar.getByTestId("tab-features").click()
			await expect(sidebar.getByRole("switch", { name: "Hooks", exact: true })).toHaveAttribute("aria-checked", "true")
			await finishWorkSettings(sidebar)
			expect(server.getRequestCount(DEEPSEEK_TARGET)).toBe(3)
			expect(server.getRequestCount(OPENAI_TARGET)).toBe(1)
			expect(server.getRequestCount(ANTHROPIC_TARGET)).toBe(1)

			await openWorkHistoryTask(page, sidebar, TASK_MARKER)
			await expect(sidebar.getByRole("button", { name: "Select model" })).toHaveText(RENAMED_ANTHROPIC_PROFILE)
			await waitForWorkTaskBinding(dlineDocsDir, taskId, anthropicProfile.id, RENAMED_ANTHROPIC_PROFILE)
			server.clearPendingResponses(ANTHROPIC_TARGET)
			server.enqueueResponses(
				ANTHROPIC_TARGET,
				{
					type: "tool",
					id: "call_work_policy_restart",
					name: "attempt_completion",
					arguments: { result: FINAL_COMPLETE },
					usage: USAGE,
					expectedRequestIncludes: [RESTART_INPUT],
				},
				{ type: "error", status: 500, code: "unexpected_restart_request", message: "Unexpected restart request" },
			)
			await sendWorkMessage(sidebar, RESTART_INPUT)
			await expect(sidebar.getByText(FINAL_COMPLETE, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount(ANTHROPIC_TARGET)).toBe(2)

			const deepSeekConsumptions = server.getMockConsumptions(DEEPSEEK_TARGET)
			const openAiConsumptions = server.getMockConsumptions(OPENAI_TARGET)
			const anthropicConsumptions = server.getMockConsumptions(ANTHROPIC_TARGET)
			expect(responseNames(deepSeekConsumptions)).toEqual([
				"attempt_completion",
				"attempt_completion",
				"attempt_completion",
			])
			expect(responseNames(openAiConsumptions)).toEqual(["attempt_completion"])
			expect(responseNames(anthropicConsumptions)).toEqual(["attempt_completion", "attempt_completion"])
			expectProviderRequest(deepSeekConsumptions[0], "deepseek-chat", DEEPSEEK_MODEL)
			expectProviderRequest(deepSeekConsumptions[1], "deepseek-chat", DEEPSEEK_MODEL)
			expectProviderRequest(deepSeekConsumptions[2], "deepseek-chat", DEEPSEEK_MODEL)
			expectProviderRequest(openAiConsumptions[0], "openai-chat", OPENAI_MODEL)
			expectProviderRequest(anthropicConsumptions[0], "anthropic-messages", ANTHROPIC_MODEL)
			expectProviderRequest(anthropicConsumptions[1], "anthropic-messages", ANTHROPIC_MODEL)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)

			await testInfo.attach("daily-profiles-policies-evidence.json", {
				body: Buffer.from(
					`${JSON.stringify(
						{
							profiles: { openAi: openAiProfile.id, deepSeek: deepSeekProfile.id, anthropic: anthropicProfile.id },
							models: { openAi: OPENAI_MODEL, deepSeek: DEEPSEEK_MODEL, anthropic: ANTHROPIC_MODEL },
							providerSequence: {
								deepSeek: responseNames(deepSeekConsumptions),
								openAi: responseNames(openAiConsumptions),
								anthropic: responseNames(anthropicConsumptions),
							},
							renamedProfile: RENAMED_ANTHROPIC_PROFILE,
							hookPath,
						},
						null,
						2,
					)}\n`,
					"utf8",
				),
				contentType: "application/json",
			})
		} finally {
			await app?.close()
		}
	},
)
