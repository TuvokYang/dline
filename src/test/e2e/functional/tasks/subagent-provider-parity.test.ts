import { mkdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type { MockApiConsumption } from "@e2e/fixtures/server"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

interface ProviderScenario {
	title: string
	profile: string
	target: "anthropic-messages" | "openai-compatible-responses"
	requiresReasoningReplay: boolean
}

const PROVIDER_SCENARIOS: readonly ProviderScenario[] = [
	{
		title: "Anthropic Messages",
		profile: E2E_PROFILE_NAMES.mockAnthropic,
		target: "anthropic-messages",
		requiresReasoningReplay: true,
	},
	{
		title: "OpenAI Responses",
		profile: E2E_PROFILE_NAMES.mockOpenAiResponses,
		target: "openai-compatible-responses",
		requiresReasoningReplay: false,
	},
]

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function configureNativeToolCalls(dlineDir: string, enabled: boolean): Promise<void> {
	const globalStatePath = path.join(dlineDir, "data", "globalState.json")
	const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
	const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
	const [globalState, settings, profiles] = await Promise.all([
		readFile(globalStatePath, "utf8").then((value) => JSON.parse(value) as Record<string, unknown>),
		readFile(settingsPath, "utf8").then((value) => JSON.parse(value) as Record<string, unknown>),
		readFile(profilesPath, "utf8").then((value) => JSON.parse(value) as Array<{ id: string; name: string }>),
	])
	const parentProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!parentProfile) throw new Error(`Missing E2E Profile: ${E2E_PROFILE_NAMES.mockOpenAiResponses}`)

	globalState.nativeToolCallEnabled = enabled
	settings.actModeProfile = parentProfile.name
	settings.actModeProfileId = parentProfile.id
	settings.planModeProfile = parentProfile.name
	settings.planModeProfileId = parentProfile.id
	await Promise.all([
		writeFile(globalStatePath, `${JSON.stringify(globalState, null, 2)}\n`, "utf8"),
		writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8"),
	])
}

async function writeSubagent(workspaceDir: string, name: string, profile: string): Promise<void> {
	const directory = path.join(workspaceDir, ".agents", "subagents")
	await mkdir(directory, { recursive: true })
	await writeFile(
		path.join(directory, `${name}.yml`),
		`---
name: ${name}
description: Cross-provider reasoning and tool observability contract.
profile: ${profile}
tools:
  - read_file
  - list_files
  - attempt_completion
---

Execute the requested tools in order and preserve Provider reasoning across turns.`,
		"utf8",
	)
}

function findAssistantContent(consumption: MockApiConsumption): Array<Record<string, unknown>> {
	const body = consumption.requestBody as {
		messages?: Array<{ role?: string; content?: unknown }>
	}
	const assistant = body.messages?.find((message) => message.role === "assistant")
	return Array.isArray(assistant?.content) ? (assistant.content as Array<Record<string, unknown>>) : []
}

for (const scenario of PROVIDER_SCENARIOS) {
	e2e(`Subagent provider parity - ${scenario.title}`, async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const scenarioSlug = scenario.target.replaceAll("-", "_")
		const agentName = `e2e-provider-parity-${scenarioSlug}`
		const subagentTask = `E2E_SUBAGENT_PROVIDER_PARITY_${scenarioSlug.toUpperCase()}`
		const childResult = `E2E_SUBAGENT_PROVIDER_PARITY_CHILD_${scenarioSlug.toUpperCase()}`
		const parentResult = `E2E_SUBAGENT_PROVIDER_PARITY_PARENT_${scenarioSlug.toUpperCase()}`
		const firstReasoning = `E2E_REASONING_FIRST_${scenarioSlug.toUpperCase()}`
		const secondReasoning = `E2E_REASONING_SECOND_${scenarioSlug.toUpperCase()}`
		const finalReasoning = `E2E_REASONING_FINAL_${scenarioSlug.toUpperCase()}`
		const readCallId = `call_provider_parity_read_${scenarioSlug}`
		const listCallId = `call_provider_parity_list_${scenarioSlug}`

		await writeSubagent(workspaceDir, agentName, scenario.profile)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: `call_provider_parity_subagent_${scenarioSlug}`,
				name: "use_subagent",
				arguments: {
					agent_name: agentName,
					task: subagentTask,
					context: "Read README.md, list the workspace root, then complete.",
					timeout: 120,
				},
			},
			{
				type: "tool",
				id: `call_provider_parity_parent_complete_${scenarioSlug}`,
				name: "attempt_completion",
				arguments: { result: parentResult },
				expectedToolResults: [
					{
						callId: `call_provider_parity_subagent_${scenarioSlug}`,
						contentIncludes: childResult,
					},
				],
			},
		)
		server.enqueueResponses(
			scenario.target,
			{
				type: "tool",
				id: readCallId,
				name: "read_file",
				arguments: { path: "README.md" },
				reasoning: firstReasoning,
				usage: { inputTokens: 10, outputTokens: 2 },
			},
			{
				type: "tool",
				id: listCallId,
				name: "list_files",
				arguments: { path: ".", recursive: false },
				reasoning: secondReasoning,
				usage: { inputTokens: 10, outputTokens: 2 },
				expectedToolResults: [{ callId: readCallId, contentIncludes: "# Test Workspace" }],
			},
			{
				type: "tool",
				id: `call_provider_parity_complete_${scenarioSlug}`,
				name: "attempt_completion",
				arguments: { result: childResult },
				reasoning: finalReasoning,
				usage: { inputTokens: 10, outputTokens: 2 },
				expectedToolResults: [{ callId: listCallId, contentIncludes: "README.md" }],
			},
		)

		await sendTask(sidebar, `Run the ${scenario.title} provider-parity subagent.`)
		const approveButton = sidebar.getByText("Approve", { exact: true })
		const subagentTaskRow = sidebar.getByRole("heading", { name: subagentTask, exact: true }).last()
		await expect(approveButton.or(subagentTaskRow)).toBeVisible({ timeout: 60_000 })
		if (await approveButton.isVisible()) await approveButton.click()
		await expect(sidebar.getByText(parentResult, { exact: false }).last()).toBeVisible({ timeout: 120_000 })

		const subagentCard = subagentTaskRow.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
		await expect(subagentCard.getByTestId("subagent-metrics")).toContainText("3 tools")
		await expect(subagentCard.getByTestId("subagent-metrics")).toContainText("In:30")
		await expect(subagentCard.getByTestId("subagent-metrics")).toContainText("Out:6")
		await expect(subagentCard.getByRole("button", { name: "Collapse subagent tools" })).toContainText("Tools (3)")
		const toolSteps = subagentCard.getByTestId("subagent-tool-step")
		await expect(toolSteps).toHaveCount(3)
		await expect(toolSteps.nth(0)).toContainText("read_file")
		await expect(toolSteps.nth(1)).toContainText("list_files")
		await expect(toolSteps.nth(2)).toContainText("attempt_completion")

		const childConsumptions = server.getMockConsumptions(scenario.target)
		expect(childConsumptions).toHaveLength(3)
		expect(childConsumptions.every((consumption) => consumption.contractError === undefined)).toBe(true)
		const secondRequestText = JSON.stringify(childConsumptions[1].requestBody)
		expect(secondRequestText).toContain(firstReasoning)
		if (scenario.requiresReasoningReplay) {
			const secondTurnContent = findAssistantContent(childConsumptions[1])
			expect(secondTurnContent[0]).toMatchObject({
				type: "thinking",
				thinking: firstReasoning,
			})
			expect(secondTurnContent[0]?.signature).toEqual(expect.stringContaining("e2e_signature_"))
			expect(secondTurnContent[1]).toMatchObject({ type: "tool_use", id: readCallId })
		} else {
			const input = (childConsumptions[1].requestBody as { input?: Array<{ type?: string }> }).input ?? []
			const reasoningIndex = input.findIndex((item) => item.type === "reasoning")
			expect(reasoningIndex).toBeGreaterThanOrEqual(0)
			expect(["message", "function_call"]).toContain(input[reasoningIndex + 1]?.type)
		}
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	})
}

e2e(
	"Subagent provider parity - Anthropic XML tools keep complete UI history",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const agentName = "e2e-provider-parity-anthropic-xml"
		const subagentTask = "E2E_SUBAGENT_PROVIDER_PARITY_ANTHROPIC_XML"
		const childResult = "E2E_SUBAGENT_PROVIDER_PARITY_CHILD_ANTHROPIC_XML"
		const parentResult = "E2E_SUBAGENT_PROVIDER_PARITY_PARENT_ANTHROPIC_XML"

		await configureNativeToolCalls(dlineDir, false)
		await writeSubagent(workspaceDir, agentName, E2E_PROFILE_NAMES.mockAnthropic)
		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)
			server.resetOpenAiMock()
			server.enqueueResponses(
				"openai-compatible-responses",
				{
					type: "tool",
					id: "call_provider_parity_subagent_anthropic_xml",
					name: "use_subagent",
					arguments: {
						agent_name: agentName,
						task: subagentTask,
						context: "Read README.md, list the workspace root, then complete.",
						timeout: 120,
					},
				},
				{
					type: "tool",
					id: "call_provider_parity_parent_complete_anthropic_xml",
					name: "attempt_completion",
					arguments: { result: parentResult },
					expectedToolResults: [
						{
							callId: "call_provider_parity_subagent_anthropic_xml",
							contentIncludes: childResult,
						},
					],
				},
			)
			server.enqueueResponses(
				"anthropic-messages",
				{
					type: "message",
					text: "<read_file>\n<path>README.md</path>\n</read_file>",
					reasoning: "E2E_REASONING_FIRST_ANTHROPIC_XML",
					usage: { inputTokens: 10, outputTokens: 2 },
				},
				{
					type: "message",
					text: "<list_files>\n<path>.</path>\n<recursive>false</recursive>\n</list_files>",
					reasoning: "E2E_REASONING_SECOND_ANTHROPIC_XML",
					usage: { inputTokens: 10, outputTokens: 2 },
					expectedRequestIncludes: ["# Test Workspace"],
				},
				{
					type: "message",
					text: `<attempt_completion>\n<result>${childResult}</result>\n</attempt_completion>`,
					reasoning: "E2E_REASONING_FINAL_ANTHROPIC_XML",
					usage: { inputTokens: 10, outputTokens: 2 },
					expectedRequestIncludes: ["README.md"],
				},
			)

			await sendTask(sidebar, "Run the Anthropic XML provider-parity subagent.")
			const approveButton = sidebar.getByText("Approve", { exact: true })
			const subagentTaskRow = sidebar.getByRole("heading", { name: subagentTask, exact: true }).last()
			await expect(approveButton.or(subagentTaskRow)).toBeVisible({ timeout: 60_000 })
			if (await approveButton.isVisible()) await approveButton.click()
			await expect(sidebar.getByText(parentResult, { exact: false }).last()).toBeVisible({ timeout: 120_000 })

			const subagentCard = subagentTaskRow.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
			await expect(subagentCard.getByTestId("subagent-metrics")).toContainText("3 tools")
			await expect(subagentCard.getByTestId("subagent-metrics")).toContainText("In:30")
			await expect(subagentCard.getByTestId("subagent-metrics")).toContainText("Out:6")
			await expect(subagentCard.getByRole("button", { name: "Collapse subagent tools" })).toContainText("Tools (3)")
			const toolSteps = subagentCard.getByTestId("subagent-tool-step")
			await expect(toolSteps).toHaveCount(3)
			await expect(toolSteps.nth(0)).toContainText("read_file")
			await expect(toolSteps.nth(1)).toContainText("list_files")
			await expect(toolSteps.nth(2)).toContainText("attempt_completion")

			const childConsumptions = server.getMockConsumptions("anthropic-messages")
			expect(childConsumptions).toHaveLength(3)
			expect(childConsumptions.every((consumption) => consumption.contractError === undefined)).toBe(true)
			const secondTurnContent = findAssistantContent(childConsumptions[1])
			expect(secondTurnContent[0]).toMatchObject({
				type: "thinking",
				thinking: "E2E_REASONING_FIRST_ANTHROPIC_XML",
			})
			expect(secondTurnContent[0]?.signature).toEqual(expect.stringContaining("e2e_signature_"))
			expect(secondTurnContent[1]).toMatchObject({ type: "text" })
			expect(secondTurnContent[1]?.text).toContain("<read_file>")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
