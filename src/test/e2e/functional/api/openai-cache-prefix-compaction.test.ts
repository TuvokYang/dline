import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { getE2EWorkspaceMcpUrl } from "@e2e/fixtures/server/workspace-mcp"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"
import type { ElectronApplication } from "playwright"

const RULE_MARKER = "E2E_CACHE_PREFIX_RULES_CATALOG"
const SKILL_NAME = "e2e-cache-prefix-skill"
const WORKFLOW_NAME = "e2e-cache-prefix-workflow"
const MCP_NAME = "e2e-cache-prefix-mcp"
const MCP_TOOL_NAME = "e2e_workspace_echo"
const COMPACTION_MARKER = "The current conversation is rapidly running out of context"

interface StoredProfile {
	id: string
	name: string
	provider: string
	baseUrl?: string
	modelId?: string
	usedFor?: string[]
	enabled?: boolean
	webToolsMode?: string
	openai?: {
		apiFormat?: string
		customModelEnabled?: boolean
		reasoning?: Record<string, unknown>
		serviceTier?: string
		serviceTierEnabled?: boolean
		streamIncludeUsage?: boolean
		capabilities?: {
			contextWindow?: number
			maxTokens?: number
			supportsImages?: boolean
			supportsPromptCache?: boolean
			supportsTools?: boolean
		}
		pricing?: Record<string, number>
	}
}

const PROVIDER_CONTEXT_WINDOW = 472_000
const AUTO_CONDENSE_TRIGGER_PERCENT = 95
const AUTO_CONDENSE_TRIGGER_BUFFER_TOKENS = 3_000
const AUTO_CONDENSE_MAX_CONTEXT_TOKENS = 0
const MIN_NEAR_TRIGGER_INPUT_TOKENS = 400_000
const CONSECUTIVE_COMPACTION_TRIGGER_TOKENS =
	Math.floor((PROVIDER_CONTEXT_WINDOW * AUTO_CONDENSE_TRIGGER_PERCENT) / 100) - AUTO_CONDENSE_TRIGGER_BUFFER_TOKENS
const CONSECUTIVE_COMPACTION_MAX_TOTAL_INPUT_TOKENS =
	CONSECUTIVE_COMPACTION_TRIGGER_TOKENS + Math.floor((PROVIDER_CONTEXT_WINDOW - CONSECUTIVE_COMPACTION_TRIGGER_TOKENS) / 2)
const AUTO_COMPACTION_PROVIDER_INPUT_TOKENS = CONSECUTIVE_COMPACTION_TRIGGER_TOKENS + AUTO_CONDENSE_TRIGGER_BUFFER_TOKENS + 1_000
const MAX_COMPACTION_DYNAMIC_TAIL_TOKENS = 10_000
const AUTO_COMPACTION_COUNT = 6
const ORDINARY_TURN_COUNT = AUTO_COMPACTION_COUNT + 1
const FIRST_TURN_READ_CALLS = 24
const LATER_TURN_READ_CALLS = 26
const MIN_SEARCH_CALLS_PER_TURN = 2
const MAX_SEARCH_CALLS_PER_TURN = 4
const CORPUS_FILE_CHARS = 57 * 1024
const SIX_CYCLE_CORPUS_FILE_CHARS = 55 * 1024
const CONSECUTIVE_CORPUS_FILE_CHARS = 60 * 1024
// Leave headroom for frozen-prefix growth while keeping the complete provider request above the 446.4K trigger boundary.
const LARGE_TURN_CORPUS_FILE_CHARS = 56 * 1024
const LARGE_TURN_EXTRA_FILE_CHARS = 8 * 1024
const CONSECUTIVE_LARGE_TURN_EXTRA_FILE_CHARS = 512
const CORPUS_USER_CHARS = 120 * 1024
const CORPUS_SOURCE_PATH = "dist/extension.js.map"
const CACHE_SCENARIO_SEED_ENV = "DLINE_E2E_CACHE_SCENARIO_SEED"

type CorpusToolName = "read_file" | "search_files"

interface CorpusToolCall {
	readonly id: string
	readonly name: CorpusToolName
	readonly arguments: Readonly<Record<string, string>>
	readonly expectedResultIncludes: string
}

interface CorpusTurn {
	readonly marker: string
	readonly userText: string
	readonly userContentHash: string
	readonly sourceRange: readonly [number, number]
	readonly files: readonly string[]
	readonly duplicateReadPath?: string
	readonly toolCalls: readonly CorpusToolCall[]
}

interface RuntimeOverrideStep {
	readonly thinkingLabel: string
	readonly reasoningEffort: string
	readonly serviceTierLabel: string
	readonly serviceTier: string
}

interface RandomizedCacheScenario {
	readonly seed: number
	readonly seedHex: string
	readonly runtimeOverrides: readonly RuntimeOverrideStep[]
	readonly turns: readonly CorpusTurn[]
}

const DEFAULT_RUNTIME_OVERRIDE: RuntimeOverrideStep = {
	thinkingLabel: "High",
	reasoningEffort: "high",
	serviceTierLabel: "Default",
	serviceTier: "default",
}

const RUNTIME_OVERRIDE_POOL: readonly RuntimeOverrideStep[] = [
	{ thinkingLabel: "Low", reasoningEffort: "low", serviceTierLabel: "Default", serviceTier: "default" },
	{ thinkingLabel: "High", reasoningEffort: "high", serviceTierLabel: "Flex", serviceTier: "flex" },
	{ thinkingLabel: "Medium", reasoningEffort: "medium", serviceTierLabel: "Ultrafast", serviceTier: "ultrafast" },
	{ thinkingLabel: "High", reasoningEffort: "high", serviceTierLabel: "Priority", serviceTier: "priority" },
	{ thinkingLabel: "Low", reasoningEffort: "low", serviceTierLabel: "Auto", serviceTier: "auto" },
	{ thinkingLabel: "Medium", reasoningEffort: "medium", serviceTierLabel: "Default", serviceTier: "default" },
]

function createSeededRandom(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
		return state / 0x1_0000_0000
	}
}

function randomInteger(random: () => number, minimum: number, maximum: number): number {
	return minimum + Math.floor(random() * (maximum - minimum + 1))
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
	const result = [...values]
	for (let index = result.length - 1; index > 0; index--) {
		const swapIndex = randomInteger(random, 0, index)
		;[result[index], result[swapIndex]] = [result[swapIndex], result[index]]
	}
	return result
}

function randomToken(random: () => number): string {
	return Math.floor(random() * 0x1_0000_0000)
		.toString(16)
		.padStart(8, "0")
}

function resolveScenarioSeed(): number {
	const configured = process.env[CACHE_SCENARIO_SEED_ENV]
	if (configured === undefined || configured.trim() === "") return randomBytes(4).readUInt32LE(0)
	const trimmed = configured.trim()
	const parsed = Number.parseInt(trimmed, trimmed.toLowerCase().startsWith("0x") ? 16 : 10)
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
		throw new Error(`${CACHE_SCENARIO_SEED_ENV} must be an unsigned 32-bit integer`)
	}
	return parsed >>> 0
}

function hashText(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex")
}

function summaryMarker(seedHex: string, cycle: number): string {
	return `E2E_AUTO_CACHE_SUMMARY_${seedHex}_${cycle}`
}

function readyMarker(seedHex: string, turn: number): string {
	return `E2E_AUTO_CACHE_TURN_${seedHex}_${turn}_READY`
}

async function configureProfiles(dlineDir: string, maxOutputTokens = 60_000): Promise<void> {
	const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
	const profiles = JSON.parse(await readFile(profilesPath, "utf8")) as StoredProfile[]
	const target = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!target?.openai?.capabilities) throw new Error("Missing OpenAI Responses target profile")
	target.modelId = "gpt-5.6-sol"
	target.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	target.openai.capabilities.contextWindow = PROVIDER_CONTEXT_WINDOW
	target.openai.capabilities.maxTokens = maxOutputTokens
	target.openai.reasoning = { enableThinking: true, effort: "high", thinkingBudget: 0 }
	target.openai.serviceTierEnabled = true
	target.openai.serviceTier = "default"
	await writeFile(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
	const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
	settings.actModeProfile = E2E_PROFILE_NAMES.mockOpenAiResponses
	settings.planModeProfile = E2E_PROFILE_NAMES.mockOpenAiResponses
	settings.planActSeparateModelsSetting = false
	settings.useAutoCondense = true
	settings.autoCondenseTriggerPercent = AUTO_CONDENSE_TRIGGER_PERCENT
	settings.autoCondenseMinReserveTokens = 5_000
	settings.autoCondenseMaxReserveTokens = 30_000
	settings.autoCondenseMaxContextTokens = AUTO_CONDENSE_MAX_CONTEXT_TOKENS
	settings.clineWebToolsEnabled = false
	settings.enableCheckpointsSetting = false

	const globalStatePath = path.join(dlineDir, "data", "globalState.json")
	const globalState = JSON.parse(await readFile(globalStatePath, "utf8")) as Record<string, unknown>
	globalState.vscodeTerminalExecutionMode = "backgroundExec"
	await Promise.all([
		writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8"),
		writeFile(globalStatePath, `${JSON.stringify(globalState, null, 2)}\n`, "utf8"),
	])
}

async function createPromptResources(workspaceDir: string, mcpUrl: string): Promise<void> {
	const rulesDirectory = path.join(workspaceDir, ".agents", "rules")
	const skillDirectory = path.join(workspaceDir, ".agents", "skills", SKILL_NAME)
	const workflowDirectory = path.join(workspaceDir, ".agents", "workflows")
	const mcpDirectory = path.join(workspaceDir, ".agents", "mcp")
	await Promise.all([
		mkdir(rulesDirectory, { recursive: true }),
		mkdir(skillDirectory, { recursive: true }),
		mkdir(workflowDirectory, { recursive: true }),
		mkdir(mcpDirectory, { recursive: true }),
	])
	const [overviewRules, generalRules, storageRules, architectureRules] = await Promise.all([
		readFile(path.join(E2ETestHelper.CODEBASE_ROOT_DIR, ".agents", "rules", "dline-overview.md"), "utf8"),
		readFile(path.join(E2ETestHelper.CODEBASE_ROOT_DIR, ".agents", "rules", "engineering-guide.md"), "utf8"),
		readFile(path.join(E2ETestHelper.CODEBASE_ROOT_DIR, ".agents", "rules", "storage.md"), "utf8"),
		readFile(path.join(E2ETestHelper.CODEBASE_ROOT_DIR, "docs", "prompt-architecture.md"), "utf8"),
	])
	await Promise.all([
		writeFile(
			path.join(rulesDirectory, "cache-prefix-rules.md"),
			[
				`# ${RULE_MARKER}`,
				"Keep the frozen Rules, Skills, Workflows, MCP catalog, and native tools byte-for-byte stable across every ordinary and compaction request.",
				"A profile transition may replace conversation history only; it must not replace the frozen system/tool prefix.",
				overviewRules,
				generalRules,
				storageRules,
				architectureRules,
			].join("\n\n"),
			"utf8",
		),
		writeFile(
			path.join(skillDirectory, "SKILL.md"),
			[
				"---",
				`name: ${SKILL_NAME}`,
				"description: Cache-prefix E2E skill catalog marker for stable frozen system prompt detection",
				"---",
				"This body is not executed by the test.",
			].join("\n"),
			"utf8",
		),
		writeFile(
			path.join(workflowDirectory, `${WORKFLOW_NAME}.md`),
			[
				"---",
				`name: ${WORKFLOW_NAME}`,
				"description: Cache-prefix E2E workflow catalog marker for stable frozen system prompt detection",
				"---",
				"This procedure is not executed by the test.",
			].join("\n"),
			"utf8",
		),
		writeFile(
			path.join(mcpDirectory, `${MCP_NAME}.json`),
			`${JSON.stringify(
				{
					name: MCP_NAME,
					description: "Cache-prefix E2E MCP catalog marker",
					type: "streamableHttp",
					url: mcpUrl,
				},
				null,
				2,
			)}\n`,
			"utf8",
		),
	])
}

async function prepareScenario(
	workspaceDir: string,
	seed: number,
	corpusFileChars = CORPUS_FILE_CHARS,
): Promise<RandomizedCacheScenario> {
	const destination = path.join(workspaceDir, "cache-prefix-auto-corpus")
	await mkdir(destination, { recursive: true })
	const source = await readFile(path.join(E2ETestHelper.CODEBASE_ROOT_DIR, CORPUS_SOURCE_PATH), "utf8")
	const random = createSeededRandom(seed)
	const seedHex = seed.toString(16).padStart(8, "0")
	const runtimeOverrides = [
		DEFAULT_RUNTIME_OVERRIDE,
		...shuffled(RUNTIME_OVERRIDE_POOL, random).slice(0, ORDINARY_TURN_COUNT - 1),
	]
	const turnPlans = Array.from({ length: ORDINARY_TURN_COUNT }, (_, turnIndex) => {
		const readCallCount = turnIndex === 0 ? FIRST_TURN_READ_CALLS : LATER_TURN_READ_CALLS
		return {
			turnIndex,
			readCallCount,
			uniqueFileCount: turnIndex === 0 ? readCallCount - 1 : readCallCount,
			searchCallCount: randomInteger(random, MIN_SEARCH_CALLS_PER_TURN, MAX_SEARCH_CALLS_PER_TURN),
		}
	})
	const segments = turnPlans.flatMap(({ turnIndex, uniqueFileCount }) => [
		{ key: `user:${turnIndex}`, size: CORPUS_USER_CHARS },
		...Array.from({ length: uniqueFileCount }, (_, fileIndex) => ({
			key: `file:${turnIndex}:${fileIndex}`,
			size: corpusFileChars,
		})),
	])
	const requiredCharacters = segments.reduce((total, segment) => total + segment.size, 0)
	if (source.length < requiredCharacters) {
		throw new Error("Real source map is too small for six randomized automatic compaction cycles")
	}
	const starts = new Map<string, number>()
	let sourceOffset = randomInteger(random, 0, source.length - requiredCharacters)
	for (const segment of shuffled(segments, random)) {
		starts.set(segment.key, sourceOffset)
		sourceOffset += segment.size
	}

	const turns: CorpusTurn[] = []
	for (const { turnIndex, uniqueFileCount, searchCallCount } of turnPlans) {
		const marker = `E2E_AUTO_CACHE_USER_${seedHex}_${turnIndex + 1}`
		const userStart = starts.get(`user:${turnIndex}`)
		if (userStart === undefined) throw new Error(`Missing randomized user segment for turn ${turnIndex + 1}`)
		const userContent = source.slice(userStart, userStart + CORPUS_USER_CHARS)
		const files: string[] = []
		const fileSearchTokens: string[] = []
		for (let fileIndex = 0; fileIndex < uniqueFileCount; fileIndex++) {
			const fileStart = starts.get(`file:${turnIndex}:${fileIndex}`)
			if (fileStart === undefined) throw new Error(`Missing randomized file segment ${turnIndex + 1}:${fileIndex + 1}`)
			const searchToken = `E2E_CACHE_SEARCH_${seedHex}_${turnIndex + 1}_${fileIndex + 1}_${randomToken(random)}`
			const relativePath = path.join(
				"cache-prefix-auto-corpus",
				`seed-${seedHex}-turn-${turnIndex + 1}-part-${fileIndex + 1}.json`,
			)
			await writeFile(
				path.join(workspaceDir, relativePath),
				[
					searchToken,
					`Source: ${CORPUS_SOURCE_PATH}; character range: ${fileStart}-${fileStart + corpusFileChars}`,
					source.slice(fileStart, fileStart + corpusFileChars),
				].join("\n"),
				"utf8",
			)
			files.push(relativePath.replaceAll("\\", "/"))
			fileSearchTokens.push(searchToken)
		}

		const readCalls: CorpusToolCall[] = files.map((filePath, fileIndex) => ({
			id: `call_auto_cache_${seedHex}_turn_${turnIndex + 1}_read_${fileIndex + 1}_${randomToken(random)}`,
			name: "read_file",
			arguments: { path: filePath },
			expectedResultIncludes: fileSearchTokens[fileIndex],
		}))
		let duplicateReadPath: string | undefined
		if (turnIndex === 0) {
			const duplicateIndex = randomInteger(random, 0, readCalls.length - 1)
			const duplicate = readCalls[duplicateIndex]
			duplicateReadPath = duplicate.arguments.path
			readCalls.push({
				...duplicate,
				id: `call_auto_cache_${seedHex}_turn_1_duplicate_${randomToken(random)}`,
			})
		}
		const searchManifestPath = path
			.join("cache-prefix-auto-corpus", `seed-${seedHex}-turn-${turnIndex + 1}-search-markers.txt`)
			.replaceAll("\\", "/")
		await writeFile(
			path.join(workspaceDir, searchManifestPath),
			fileSearchTokens
				.map((token, tokenIndex) => `${token} randomized-search-metadata-${tokenIndex + 1}-${randomToken(random)}`)
				.join("\n"),
			"utf8",
		)
		const searchCalls: CorpusToolCall[] = Array.from({ length: searchCallCount }, (_, searchIndex) => {
			const fileIndex = randomInteger(random, 0, files.length - 1)
			return {
				id: `call_auto_cache_${seedHex}_turn_${turnIndex + 1}_search_${searchIndex + 1}_${randomToken(random)}`,
				name: "search_files",
				arguments: {
					path: "cache-prefix-auto-corpus",
					regex: fileSearchTokens[fileIndex],
					file_pattern: path.basename(searchManifestPath),
				},
				expectedResultIncludes: fileSearchTokens[fileIndex],
			}
		})
		const toolCalls = shuffled([...readCalls, ...searchCalls], random)
		turns.push({
			marker,
			userText: [
				marker,
				`Scenario seed: ${seedHex}; nonce: ${randomToken(random)}`,
				`Source: ${CORPUS_SOURCE_PATH}; character range: ${userStart}-${userStart + CORPUS_USER_CHARS}`,
				userContent,
			].join("\n\n"),
			userContentHash: hashText(userContent),
			sourceRange: [userStart, userStart + CORPUS_USER_CHARS],
			files: turnIndex === 0 && duplicateReadPath ? [...files, duplicateReadPath] : files,
			...(duplicateReadPath ? { duplicateReadPath } : {}),
			toolCalls,
		})
	}
	return { seed, seedHex, runtimeOverrides, turns }
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	return sidebar
}

async function setAutoApproveRead(sidebar: Frame): Promise<void> {
	await sidebar.getByLabel("Open auto-approve settings").click()
	const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: "Read project files" })
	const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if (!(await isChecked())) await sidebar.getByText("Read project files", { exact: true }).click()
	await expect.poll(isChecked).toBe(true)
	await sidebar.getByLabel("Close auto-approve settings").click()
}

async function waitForPromptCatalog(sidebar: Frame): Promise<void> {
	await sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first().click()
	await sidebar.getByRole("button", { name: "Skills", exact: true }).click()
	await expect(sidebar.getByText(SKILL_NAME, { exact: true })).toBeVisible({ timeout: 30_000 })
	await sidebar.getByRole("button", { name: "Workflows", exact: true }).click()
	await expect(sidebar.getByText(`${WORKFLOW_NAME}.md`, { exact: true })).toBeVisible({ timeout: 30_000 })
	await sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first().click()
	await sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).click()
	await expect(sidebar.getByText(MCP_NAME, { exact: true })).toBeVisible({ timeout: 60_000 })
	await sidebar.getByRole("button", { name: "Hide MCP Servers", exact: true }).click()
}

async function selectRuntimeOverrides(sidebar: Frame, step: RuntimeOverrideStep): Promise<void> {
	const thinking = sidebar.getByRole("combobox", { name: "Task thinking override" })
	await expect(thinking).toBeEnabled()
	if (!(await thinking.textContent())?.includes(step.thinkingLabel)) {
		await thinking.click()
		const option = sidebar.getByRole("option", { name: step.thinkingLabel, exact: true })
		await expect(option).toBeVisible()
		await option.press("Enter")
	}
	await expect(thinking).toContainText(step.thinkingLabel)

	const serviceTier = sidebar.getByRole("button", { name: "Task service tier" })
	await expect(serviceTier).toBeEnabled()
	if ((await serviceTier.getAttribute("data-service-tier-label")) !== step.serviceTierLabel) {
		await serviceTier.click()
		const option = sidebar
			.getByRole("listbox", { name: "Task service tier options" })
			.getByRole("option", { name: step.serviceTierLabel, exact: true })
		await expect(option).toBeVisible()
		await option.press("Enter")
	}
	await expect(serviceTier).toHaveAttribute("data-service-tier-label", step.serviceTierLabel)
}

async function send(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	await input.press("Enter")
}

e2e(
	"OpenAI compaction admits a complete randomized 400K+ multi-tool turn before the hard window then terminates above 80 percent",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(300_000)
		await configureProfiles(dlineDir, 1_000)
		await createPromptResources(workspaceDir, getE2EWorkspaceMcpUrl(server.baseUrl))
		const scenario = await prepareScenario(workspaceDir, resolveScenarioSeed(), LARGE_TURN_CORPUS_FILE_CHARS)
		const turn = scenario.turns[1]
		const extraRead = scenario.turns[2].toolCalls.find(({ name }) => name === "read_file")
		if (!extraRead) throw new Error("Missing extra randomized real-file read for the large-turn scenario")
		const extraSource = await readFile(path.join(workspaceDir, extraRead.arguments.path), "utf8")
		const shortenedExtraPath = path
			.join("cache-prefix-auto-corpus", `seed-${scenario.seedHex}-large-turn-extra.json`)
			.replaceAll("\\", "/")
		await writeFile(path.join(workspaceDir, shortenedExtraPath), extraSource.slice(0, LARGE_TURN_EXTRA_FILE_CHARS), "utf8")
		const largeTurnToolCalls = shuffled(
			[
				...turn.toolCalls,
				{
					...extraRead,
					id: `call_large_turn_extra_read_${scenario.seedHex}_${hashText(shortenedExtraPath).slice(0, 8)}`,
					arguments: { path: shortenedExtraPath },
				},
			],
			createSeededRandom(scenario.seed ^ 0xa5a5_5a5a),
		)
		const readCalls = largeTurnToolCalls.filter(({ name }) => name === "read_file")
		expect(readCalls).toHaveLength(LATER_TURN_READ_CALLS + 1)
		expect(new Set(readCalls.map(({ arguments: toolArguments }) => toolArguments.path)).size).toBe(LATER_TURN_READ_CALLS + 1)

		const scenarioPath = e2e.info().outputPath("large-turn-compaction-scenario.json")
		await writeFile(
			scenarioPath,
			`${JSON.stringify({ seed: scenario.seed, seedHex: scenario.seedHex, turn, largeTurnToolCalls }, null, 2)}\n`,
			"utf8",
		)
		await e2e.info().attach("large-turn-compaction-scenario.json", {
			path: scenarioPath,
			contentType: "application/json",
		})

		const summary = `E2E_LARGE_TURN_SUMMARY_${scenario.seedHex} preserves the complete randomized multi-tool round.`
		const completion = `E2E_LARGE_TURN_COMPLETE_${scenario.seedHex}`
		const expectedToolResults = largeTurnToolCalls.map((toolCall) => ({
			callId: toolCall.id,
			contentIncludes: toolCall.expectedResultIncludes,
		}))
		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tools",
				tools: largeTurnToolCalls.map((toolCall) => ({
					id: toolCall.id,
					name: toolCall.name,
					arguments: toolCall.arguments,
				})),
				expectedRequestIncludes: [turn.marker, RULE_MARKER, SKILL_NAME, WORKFLOW_NAME, MCP_TOOL_NAME],
				expectedRequestExcludes: [COMPACTION_MARKER],
				requireCompleteToolPairing: true,
				matchRequestContract: true,
			},
			{
				type: "tool",
				id: `call_large_turn_summary_${scenario.seedHex}`,
				name: "summarize_task",
				arguments: { context: summary },
				expectedRequestIncludes: [
					COMPACTION_MARKER,
					turn.marker,
					RULE_MARKER,
					...largeTurnToolCalls.map(({ expectedResultIncludes }) => expectedResultIncludes),
				],
				expectedToolResults,
				requireCompleteToolPairing: true,
				matchRequestContract: true,
			},
			{
				type: "tool",
				id: `call_large_turn_complete_${scenario.seedHex}`,
				name: "attempt_completion",
				arguments: { result: completion },
				expectedRequestIncludes: [summary],
				expectedRequestExcludes: [COMPACTION_MARKER, turn.marker],
				requireCompleteToolPairing: true,
				matchRequestContract: true,
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const sidebar = await openSidebar(app, helper)
			await waitForPromptCatalog(sidebar)
			await setAutoApproveRead(sidebar)
			await send(sidebar, turn.userText)
			await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 180_000 }).toBe(3)
			await expect(sidebar.getByText(completion, { exact: true })).toBeVisible({ timeout: 60_000 })
			const footer = sidebar.getByRole("contentinfo")
			await expect(footer.getByText("Start New Task", { exact: true })).toBeVisible({ timeout: 60_000 })

			const requests = server.getMockConsumptions("openai-compatible-responses")
			const summaryRequest = requests[1]
			expect(requests.map(({ responseType, toolName }) => toolName ?? responseType)).toEqual([
				"tools",
				"summarize_task",
				"attempt_completion",
			])
			expect(summaryRequest).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
			expect(summaryRequest.contractError).toBeUndefined()
			expect(summaryRequest.requestToolPairing.complete).toBe(true)
			expect(summaryRequest.requestToolResults).toHaveLength(largeTurnToolCalls.length)
			if (!summaryRequest.cacheDiagnostic) throw new Error("Missing large-turn OpenAI cache diagnostic")
			expect(summaryRequest.cacheDiagnostic.totalInputTokens).toBeGreaterThan(446_400)
			expect(summaryRequest.cacheDiagnostic.totalInputTokens).toBeLessThan(PROVIDER_CONTEXT_WINDOW)
			expect(summaryRequest.requestBody).not.toHaveProperty("max_output_tokens")
			expect(summaryRequest.cacheDiagnostic.totalInputTokens).toBeLessThan(PROVIDER_CONTEXT_WINDOW)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"OpenAI compaction keeps a sendable pending-completed latest turn in the first hidden Pass",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(360_000)
		await configureProfiles(dlineDir, 1_000)
		await createPromptResources(workspaceDir, getE2EWorkspaceMcpUrl(server.baseUrl))
		const scenario = await prepareScenario(workspaceDir, resolveScenarioSeed())
		const historyTurn = scenario.turns[0]
		const uniqueReadPaths = new Set<string>()
		const historyReadCalls = historyTurn.toolCalls.filter((toolCall) => {
			if (toolCall.name !== "read_file" || uniqueReadPaths.has(toolCall.arguments.path)) return false
			uniqueReadPaths.add(toolCall.arguments.path)
			return true
		})
		const historySearchCalls = historyTurn.toolCalls.filter(({ name }) => name === "search_files")
		const historyToolCalls = [...historyReadCalls, ...historySearchCalls]
		expect(historyReadCalls).toHaveLength(FIRST_TURN_READ_CALLS - 1)

		const historyReady = `E2E_PENDING_COMPLETED_HISTORY_READY_${scenario.seedHex}`
		const latestUserMarker = `E2E_PENDING_COMPLETED_LATEST_USER_${scenario.seedHex}`
		const summary = `E2E_PENDING_COMPLETED_SUMMARY_${scenario.seedHex} preserves both completed turns.`
		const completed = `E2E_PENDING_COMPLETED_OK_${scenario.seedHex}`
		const latestReadCalls = scenario.turns[1].toolCalls.filter(({ name }) => name === "read_file").slice(0, 3)
		expect(latestReadCalls).toHaveLength(3)
		const latestResultMarkers = latestReadCalls.map(({ expectedResultIncludes }) => expectedResultIncludes)
		const latestResultTexts = await Promise.all(
			latestReadCalls.map(({ arguments: toolArguments }) => readFile(path.join(workspaceDir, toolArguments.path), "utf8")),
		)
		const estimatedLatestTurnTokens = Math.ceil(
			latestResultTexts.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0) / 4,
		)
		const expectedHistoryToolResults = historyToolCalls.map((toolCall) => ({
			callId: toolCall.id,
			contentIncludes: toolCall.expectedResultIncludes,
		}))

		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tools",
				tools: historyToolCalls.map((toolCall) => ({
					id: toolCall.id,
					name: toolCall.name,
					arguments: toolCall.arguments,
				})),
				expectedRequestIncludes: [historyTurn.marker, RULE_MARKER, SKILL_NAME, WORKFLOW_NAME, MCP_TOOL_NAME],
				expectedRequestExcludes: [COMPACTION_MARKER],
				requireCompleteToolPairing: true,
				matchRequestContract: true,
			},
			{
				type: "tool",
				id: `call_pending_completed_history_ready_${scenario.seedHex}`,
				name: "qna_respond",
				arguments: { response: historyReady },
				usage: { inputTokens: 390_000, outputTokens: 100 },
				expectedToolResults: expectedHistoryToolResults,
				requireCompleteToolPairing: true,
				matchRequestContract: true,
			},
			{
				type: "tools",
				tools: latestReadCalls.map((toolCall) => ({
					id: toolCall.id,
					name: toolCall.name,
					arguments: toolCall.arguments,
				})),
				usage: { inputTokens: 405_000, outputTokens: 100 },
				expectedRequestIncludes: [historyTurn.marker, latestUserMarker],
				expectedRequestExcludes: [COMPACTION_MARKER],
				expectedToolResults: [
					{ callId: `call_pending_completed_history_ready_${scenario.seedHex}`, contentIncludes: latestUserMarker },
				],
				requireCompleteToolPairing: true,
				matchRequestContract: true,
			},
			{
				type: "tool",
				id: `call_pending_completed_summary_${scenario.seedHex}`,
				name: "summarize_task",
				arguments: { context: summary },
				expectedRequestIncludes: [COMPACTION_MARKER, historyTurn.marker],
				requireCompleteToolPairing: true,
				matchRequestContract: true,
			},
			{
				type: "tool",
				id: `call_pending_completed_done_${scenario.seedHex}`,
				name: "attempt_completion",
				arguments: { result: completed },
				expectedRequestIncludes: [summary],
				expectedRequestExcludes: [COMPACTION_MARKER, latestUserMarker, ...latestResultMarkers],
				requireCompleteToolPairing: true,
				matchRequestContract: true,
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const sidebar = await openSidebar(app, helper)
			await waitForPromptCatalog(sidebar)
			await setAutoApproveRead(sidebar)
			await send(sidebar, historyTurn.userText)
			await expect(sidebar.getByText(historyReady, { exact: true })).toBeVisible({ timeout: 180_000 })
			await send(sidebar, latestUserMarker)
			await expect(sidebar.getByText(completed, { exact: true })).toBeVisible({ timeout: 180_000 })
			await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 180_000 }).toBe(5)

			const requests = server.getMockConsumptions("openai-compatible-responses")
			const summaryRequest = requests[3]
			const postCompactionRequest = requests[4]
			const summaryRequestText = JSON.stringify(summaryRequest.requestBody)
			const postCompactionRequestText = JSON.stringify(postCompactionRequest.requestBody)
			if (!summaryRequest.cacheDiagnostic) throw new Error("Missing pending-completed-turn cache diagnostic")
			const diagnostic = {
				seed: scenario.seed,
				seedHex: scenario.seedHex,
				historyReadCallCount: historyReadCalls.length,
				historySearchCallCount: historySearchCalls.length,
				estimatedLatestTurnTokens,
				summaryInputTokens: summaryRequest.cacheDiagnostic.totalInputTokens,
				summaryMaxOutputTokens: undefined,
				summaryContainsLatestUser: summaryRequestText.includes(latestUserMarker),
				summaryContainsAllLatestResults: latestResultMarkers.every((marker) => summaryRequestText.includes(marker)),
				postCompactionContainsAllLatestResults: latestResultMarkers.every((marker) =>
					postCompactionRequestText.includes(marker),
				),
				requestSequence: requests.map(({ responseType, toolName }) => toolName ?? responseType),
			}
			const diagnosticPath = e2e.info().outputPath("pending-completed-latest-turn-diagnostic.json")
			await writeFile(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8")
			await e2e.info().attach("pending-completed-latest-turn-diagnostic.json", {
				path: diagnosticPath,
				contentType: "application/json",
			})

			expect(requests.map(({ responseType, toolName }) => toolName ?? responseType)).toEqual([
				"tools",
				"qna_respond",
				"tools",
				"summarize_task",
				"attempt_completion",
			])
			expect(requests.every(({ contractError }) => contractError === undefined)).toBe(true)
			expect(summaryRequest).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
			expect(summaryRequest.cacheDiagnostic.totalInputTokens).toBeGreaterThan(350_000)
			expect(summaryRequest.cacheDiagnostic.totalInputTokens).toBeLessThan(PROVIDER_CONTEXT_WINDOW)
			expect(summaryRequestText).toContain(latestUserMarker)
			for (const marker of latestResultMarkers) expect(summaryRequestText).toContain(marker)
			expect(postCompactionRequestText).toContain(summary)
			expect(postCompactionRequestText).not.toContain(latestUserMarker)
			for (const marker of latestResultMarkers) expect(postCompactionRequestText).not.toContain(marker)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"OpenAI cache prefix stays stable across consecutive automatic compactions in one large ordinary turn",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(420_000)
		await configureProfiles(dlineDir)
		await createPromptResources(workspaceDir, getE2EWorkspaceMcpUrl(server.baseUrl))
		const scenario = await prepareScenario(workspaceDir, resolveScenarioSeed(), CONSECUTIVE_CORPUS_FILE_CHARS)
		const historyTurn = scenario.turns[0]
		const largeTurn = scenario.turns[1]
		const extraReads = scenario.turns[2].toolCalls.filter(({ name }) => name === "read_file").slice(0, 3)
		if (extraReads.length !== 3) throw new Error("Missing extra randomized real-file reads for consecutive compaction")
		const extraSources = await Promise.all(
			extraReads.map((toolCall) => readFile(path.join(workspaceDir, toolCall.arguments.path), "utf8")),
		)
		const shortenedExtraPath = path
			.join("cache-prefix-auto-corpus", `seed-${scenario.seedHex}-consecutive-extra.json`)
			.replaceAll("\\", "/")
		await writeFile(
			path.join(workspaceDir, shortenedExtraPath),
			extraSources.map((source) => source.slice(0, CONSECUTIVE_LARGE_TURN_EXTRA_FILE_CHARS)).join("\n"),
			"utf8",
		)
		const largeTurnToolCalls = shuffled(
			[
				...largeTurn.toolCalls,
				{
					...extraReads[0],
					id: `call_consecutive_extra_read_${scenario.seedHex}_${hashText(shortenedExtraPath).slice(0, 8)}`,
					arguments: { path: shortenedExtraPath },
				},
			],
			createSeededRandom(scenario.seed ^ 0x5a5a_a5a5),
		)
		expect(largeTurnToolCalls.filter(({ name }) => name === "read_file")).toHaveLength(LATER_TURN_READ_CALLS + 1)
		const historyReady = `E2E_CONSECUTIVE_CACHE_HISTORY_READY_${scenario.seedHex}`
		const firstSummary = `E2E_CONSECUTIVE_CACHE_SUMMARY_${scenario.seedHex}_1 preserves the first complete randomized turn.`
		const secondCompactionCarrySummary = `E2E_CONSECUTIVE_CACHE_SUMMARY_${scenario.seedHex}_2_CARRY preserves ${firstSummary} before the large tool turn.`
		const secondSummary = `E2E_CONSECUTIVE_CACHE_SUMMARY_${scenario.seedHex}_2 preserves ${secondCompactionCarrySummary} and the completed large tool turn.`
		const finalReady = `E2E_CONSECUTIVE_CACHE_FINAL_READY_${scenario.seedHex}`
		const historyToolResults = historyTurn.toolCalls.map((toolCall) => ({
			callId: toolCall.id,
			contentIncludes: toolCall.expectedResultIncludes,
		}))
		const largeToolResults = largeTurnToolCalls.map((toolCall) => ({
			callId: toolCall.id,
			contentIncludes: toolCall.expectedResultIncludes,
		}))
		const scenarioPath = e2e.info().outputPath("consecutive-cache-compaction-scenario.json")
		await writeFile(
			scenarioPath,
			`${JSON.stringify({ seed: scenario.seed, seedHex: scenario.seedHex, historyTurn, largeTurn, largeTurnToolCalls }, null, 2)}\n`,
			"utf8",
		)
		await e2e.info().attach("consecutive-cache-compaction-scenario.json", {
			path: scenarioPath,
			contentType: "application/json",
		})

		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tools",
				tools: historyTurn.toolCalls.map((toolCall) => ({
					id: toolCall.id,
					name: toolCall.name,
					arguments: toolCall.arguments,
				})),
				expectedRequestIncludes: [historyTurn.marker, RULE_MARKER, SKILL_NAME, WORKFLOW_NAME, MCP_TOOL_NAME],
				expectedRequestExcludes: [COMPACTION_MARKER],
				requireCompleteToolPairing: true,
				matchRequestContract: true,
			},
			{
				type: "tool",
				id: `call_consecutive_cache_history_ready_${scenario.seedHex}`,
				name: "qna_respond",
				arguments: { response: historyReady },
				usage: { inputTokens: AUTO_COMPACTION_PROVIDER_INPUT_TOKENS, outputTokens: 100 },
				expectedToolResults: historyToolResults,
				expectedRequestExcludes: [COMPACTION_MARKER],
				requireCompleteToolPairing: true,
				matchRequestContract: true,
			},
			{
				type: "tool",
				id: `call_consecutive_cache_summary_${scenario.seedHex}_1`,
				name: "summarize_task",
				arguments: { context: firstSummary },
				expectedRequestIncludes: [
					COMPACTION_MARKER,
					RULE_MARKER,
					SKILL_NAME,
					WORKFLOW_NAME,
					MCP_TOOL_NAME,
					historyTurn.marker,
				],
				expectedRequestExcludes: [largeTurn.marker],
				requireCompleteToolPairing: true,
				matchRequestContract: true,
			},
			{
				type: "tools",
				tools: largeTurnToolCalls.map((toolCall) => ({
					id: toolCall.id,
					name: toolCall.name,
					arguments: toolCall.arguments,
				})),
				expectedRequestIncludes: [largeTurn.marker, firstSummary, RULE_MARKER, SKILL_NAME, WORKFLOW_NAME, MCP_TOOL_NAME],
				expectedRequestExcludes: [COMPACTION_MARKER],
				requireCompleteToolPairing: true,
				matchRequestContract: true,
			},
			{
				type: "tool",
				id: `call_consecutive_cache_summary_${scenario.seedHex}_2_carry`,
				name: "summarize_task",
				arguments: { context: secondCompactionCarrySummary },
				expectedRequestIncludes: [COMPACTION_MARKER, RULE_MARKER, SKILL_NAME, WORKFLOW_NAME, MCP_TOOL_NAME, firstSummary],
				expectedRequestExcludes: [largeTurn.marker],
				requireCompleteToolPairing: true,
				matchRequestContract: true,
			},
			{
				type: "tool",
				id: `call_consecutive_cache_summary_${scenario.seedHex}_2`,
				name: "summarize_task",
				arguments: { context: secondSummary },
				expectedRequestIncludes: [
					COMPACTION_MARKER,
					RULE_MARKER,
					SKILL_NAME,
					WORKFLOW_NAME,
					MCP_TOOL_NAME,
					firstSummary,
					largeTurn.marker,
					...largeTurnToolCalls.map(({ expectedResultIncludes }) => expectedResultIncludes),
				],
				expectedToolResults: largeToolResults,
				requireCompleteToolPairing: true,
				matchRequestContract: true,
			},
			{
				type: "tool",
				id: `call_consecutive_cache_final_ready_${scenario.seedHex}`,
				name: "qna_respond",
				arguments: { response: finalReady },
				expectedRequestIncludes: [secondSummary],
				expectedRequestExcludes: [COMPACTION_MARKER],
				requireCompleteToolPairing: true,
				matchRequestContract: true,
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const sidebar = await openSidebar(app, helper)
			await waitForPromptCatalog(sidebar)
			await setAutoApproveRead(sidebar)
			await send(sidebar, historyTurn.userText)
			await expect(sidebar.getByText(historyReady, { exact: true })).toBeVisible({ timeout: 180_000 })
			await send(sidebar, largeTurn.userText)
			let terminalState: "pending" | "ready" | "compaction_failure" | "error_retry" = "pending"
			await expect
				.poll(
					async () => {
						if (await sidebar.getByText(finalReady, { exact: true }).isVisible()) terminalState = "ready"
						else if ((await sidebar.getByTestId("compaction-failure").count()) > 0)
							terminalState = "compaction_failure"
						else if ((await sidebar.getByTestId("error-retry-box").count()) > 0) terminalState = "error_retry"
						return terminalState
					},
					{ timeout: 180_000 },
				)
				.not.toBe("pending")

			const requests = server.getMockConsumptions("openai-compatible-responses")
			const compactDiagnostics = requests.map((request, requestIndex) => {
				const requestText = JSON.stringify(request.requestBody)
				return {
					requestIndex,
					response: request.toolName ?? request.responseType,
					contractError: request.contractError,
					isCompaction: requestText.includes(COMPACTION_MARKER),
					containsHistoryTurn: requestText.includes(historyTurn.marker),
					containsLargeTurn: requestText.includes(largeTurn.marker),
					containsFirstSummary: requestText.includes(firstSummary),
					containsSecondSummary: requestText.includes(secondSummary),
					toolPairing: request.requestToolPairing,
					toolResultCount: request.requestToolResults.length,
					totalInputTokens: request.cacheDiagnostic?.totalInputTokens,
					stablePrefixTokens: request.cacheDiagnostic?.stablePrefixTokens,
				}
			})
			const compactDiagnosticsPath = e2e.info().outputPath("consecutive-cache-compaction-requests.json")
			await writeFile(
				compactDiagnosticsPath,
				`${JSON.stringify(
					{
						terminalState,
						expectedTrigger: {
							historyProviderInputTokens: AUTO_COMPACTION_PROVIDER_INPUT_TOKENS,
							minimumProjectedUsageTokens: CONSECUTIVE_COMPACTION_TRIGGER_TOKENS,
						},
						requests: compactDiagnostics,
					},
					null,
					2,
				)}\n`,
				"utf8",
			)
			await e2e.info().attach("consecutive-cache-compaction-requests.json", {
				path: compactDiagnosticsPath,
				contentType: "application/json",
			})
			expect(terminalState).toBe("ready")
			expect([6, 7]).toContain(requests.length)
			const requestSequence = requests.map(({ responseType, toolName }) => toolName ?? responseType)
			expect(requestSequence.slice(0, 4)).toEqual(["tools", "qna_respond", "summarize_task", "tools"])
			expect(requestSequence.slice(4, -1).every((response) => response === "summarize_task")).toBe(true)
			expect([1, 2]).toContain(requestSequence.slice(4, -1).length)
			expect(requestSequence.at(-1)).toBe("qna_respond")
			expect(requests.every(({ contractError }) => contractError === undefined)).toBe(true)
			expect(requests.every(({ requestToolPairing }) => requestToolPairing.complete)).toBe(true)
			const summaryRequests = requests.filter(({ toolName }) => toolName === "summarize_task")
			expect([2, 3]).toContain(summaryRequests.length)
			const firstSummaryRequest = summaryRequests[0]
			const secondSummaryRequest = summaryRequests.at(-1)
			const finalRequest = requests.at(-1)
			if (!firstSummaryRequest || !secondSummaryRequest || !finalRequest) {
				throw new Error("Missing consecutive compaction request sequence")
			}
			const firstSummaryRequestText = JSON.stringify(firstSummaryRequest.requestBody)
			const secondSummaryRequestText = JSON.stringify(secondSummaryRequest.requestBody)
			const finalRequestText = JSON.stringify(finalRequest.requestBody)
			expect(firstSummaryRequestText).toContain(historyTurn.marker)
			expect(firstSummaryRequestText).not.toContain(largeTurn.marker)
			if (summaryRequests.length === 3) {
				const carryRequestText = JSON.stringify(summaryRequests[1].requestBody)
				expect(carryRequestText).toContain(firstSummary)
				expect(carryRequestText).not.toContain(largeTurn.marker)
			}
			expect(secondSummaryRequestText).toContain(firstSummary)
			expect(secondSummaryRequestText).toContain(largeTurn.marker)
			for (const marker of largeTurnToolCalls.map(({ expectedResultIncludes }) => expectedResultIncludes)) {
				expect(secondSummaryRequestText).toContain(marker)
			}
			expect(secondSummaryRequest.requestToolResults).toEqual(
				expect.arrayContaining(
					largeTurnToolCalls.map((toolCall) =>
						expect.objectContaining({
							callId: toolCall.id,
							content: expect.stringContaining(toolCall.expectedResultIncludes),
						}),
					),
				),
			)
			expect(finalRequestText).toContain(secondSummary)
			expect(finalRequestText).not.toContain(COMPACTION_MARKER)

			const diagnostics = requests.map(({ cacheDiagnostic }) => {
				if (!cacheDiagnostic) throw new Error("Missing consecutive-compaction OpenAI cache diagnostic")
				return cacheDiagnostic
			})
			const baseline = diagnostics[0]
			const historyProviderDiagnostic = diagnostics[1]
			const baselineRequestBody = requests[0].requestBody as { prompt_cache_key?: string }
			expect(baselineRequestBody.prompt_cache_key).toBeTruthy()
			expect(baseline.stablePrefixTokens).toBeGreaterThanOrEqual(30_000)
			for (const [requestIndex, diagnostic] of diagnostics.entries()) {
				const requestBody = requests[requestIndex].requestBody as { prompt_cache_key?: string }
				expect(requestBody.prompt_cache_key).toBe(baselineRequestBody.prompt_cache_key)
				if (requestIndex > 0) {
					expect(diagnostic.prefixHashMatched).toBe(true)
					expect(diagnostic.actualPrefixHash).toBe(baseline.actualPrefixHash)
					expect(diagnostic.stablePrefixTokens).toBe(baseline.stablePrefixTokens)
					expect(diagnostic.warnings.map(({ code }) => code)).not.toContain("prefix_hash_mismatch")
				}
			}
			expect(historyProviderDiagnostic.totalInputTokens).toBeGreaterThanOrEqual(CONSECUTIVE_COMPACTION_TRIGGER_TOKENS)
			expect(historyProviderDiagnostic.totalInputTokens).toBeLessThan(PROVIDER_CONTEXT_WINDOW)
			for (const summaryRequest of [firstSummaryRequest, secondSummaryRequest]) {
				if (!summaryRequest.cacheDiagnostic) throw new Error("Missing consecutive summary cache diagnostic")
				expect(summaryRequest.cacheDiagnostic.totalInputTokens).toBeGreaterThanOrEqual(MIN_NEAR_TRIGGER_INPUT_TOKENS)
				expect(summaryRequest.cacheDiagnostic.totalInputTokens).toBeLessThanOrEqual(
					CONSECUTIVE_COMPACTION_MAX_TOTAL_INPUT_TOKENS,
				)
				expect(summaryRequest.cacheDiagnostic.totalInputTokens).toBeLessThan(PROVIDER_CONTEXT_WINDOW)
			}
			await expect(sidebar.getByTestId("error-retry-box")).toHaveCount(0)
			await expect(sidebar.getByTestId("compaction-failure")).toHaveCount(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"OpenAI cache prefix stays stable across six randomized automatic compaction operations at 95 percent",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(720_000)
		await configureProfiles(dlineDir)
		await createPromptResources(workspaceDir, getE2EWorkspaceMcpUrl(server.baseUrl))
		const scenario = await prepareScenario(workspaceDir, resolveScenarioSeed(), SIX_CYCLE_CORPUS_FILE_CHARS)
		const { turns, runtimeOverrides } = scenario
		expect(turns).toHaveLength(ORDINARY_TURN_COUNT)
		expect(runtimeOverrides).toHaveLength(ORDINARY_TURN_COUNT)
		expect(turns[0].duplicateReadPath).toBeTruthy()
		expect(turns[0].files.filter((filePath) => filePath === turns[0].duplicateReadPath)).toHaveLength(2)
		for (const [turnIndex, turn] of turns.entries()) {
			const readCallCount = turn.toolCalls.filter(({ name }) => name === "read_file").length
			const searchCallCount = turn.toolCalls.filter(({ name }) => name === "search_files").length
			const expectedReadCalls = turnIndex === 0 ? FIRST_TURN_READ_CALLS : LATER_TURN_READ_CALLS
			expect(readCallCount).toBe(expectedReadCalls)
			expect(searchCallCount).toBeGreaterThanOrEqual(MIN_SEARCH_CALLS_PER_TURN)
			expect(searchCallCount).toBeLessThanOrEqual(MAX_SEARCH_CALLS_PER_TURN)
		}
		const scenarioPath = e2e.info().outputPath("randomized-cache-scenario.json")
		await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, "utf8")
		await e2e.info().attach("randomized-cache-scenario.json", {
			path: scenarioPath,
			contentType: "application/json",
		})

		server.resetOpenAiMock()
		for (let turnIndex = 0; turnIndex < ORDINARY_TURN_COUNT; turnIndex++) {
			if (turnIndex > 0) {
				const cycle = turnIndex
				server.enqueueResponses("openai-compatible-responses", {
					type: "tool",
					id: `call_auto_cache_summary_${scenario.seedHex}_${cycle}`,
					name: "summarize_task",
					arguments: {
						context: `${summaryMarker(scenario.seedHex, cycle)} preserves the stable prefix and completed randomized ordinary turns.`,
					},
					expectedRequestIncludes: [
						COMPACTION_MARKER,
						RULE_MARKER,
						SKILL_NAME,
						WORKFLOW_NAME,
						MCP_TOOL_NAME,
						turns[turnIndex - 1].marker,
					],
					expectedRequestExcludes: [turns[turnIndex].marker],
					matchRequestContract: true,
				})
			}
			const turn = turns[turnIndex]
			server.enqueueResponses(
				"openai-compatible-responses",
				{
					type: "tools",
					tools: turn.toolCalls.map((toolCall) => ({
						id: toolCall.id,
						name: toolCall.name,
						arguments: toolCall.arguments,
					})),
					expectedRequestIncludes: [
						turn.marker,
						...(turnIndex === 0 ? [RULE_MARKER, SKILL_NAME, WORKFLOW_NAME, MCP_TOOL_NAME] : []),
						...(turnIndex > 0 ? [summaryMarker(scenario.seedHex, turnIndex)] : []),
					],
					expectedRequestExcludes: [COMPACTION_MARKER],
					requireCompleteToolPairing: true,
					matchRequestContract: true,
				},
				{
					type: "tool",
					id: `call_auto_cache_${scenario.seedHex}_turn_${turnIndex + 1}_ready`,
					name: "qna_respond",
					arguments: { response: readyMarker(scenario.seedHex, turnIndex + 1) },
					usage: { inputTokens: AUTO_COMPACTION_PROVIDER_INPUT_TOKENS, outputTokens: 100 },
					expectedToolResults: turn.toolCalls.map((toolCall) => ({
						callId: toolCall.id,
						contentIncludes: toolCall.expectedResultIncludes,
					})),
					expectedRequestExcludes: [COMPACTION_MARKER],
					requireCompleteToolPairing: true,
					matchRequestContract: true,
				},
			)
		}

		const app = await openVSCode(workspaceDir)
		try {
			const sidebar = await openSidebar(app, helper)
			await waitForPromptCatalog(sidebar)
			await setAutoApproveRead(sidebar)
			for (let turnIndex = 0; turnIndex < ORDINARY_TURN_COUNT; turnIndex++) {
				if (turnIndex > 0) await selectRuntimeOverrides(sidebar, runtimeOverrides[turnIndex])
				await send(sidebar, turns[turnIndex].userText)
				await expect(sidebar.getByText(readyMarker(scenario.seedHex, turnIndex + 1), { exact: true })).toBeVisible({
					timeout: 180_000,
				})
				if (turnIndex > 0) {
					await expect
						.poll(
							() =>
								server
									.getMockConsumptions("openai-compatible-responses")
									.filter(({ toolName }) => toolName === "summarize_task").length,
							{ timeout: 180_000 },
						)
						.toBe(turnIndex)
				}
			}

			const requests = server.getMockConsumptions("openai-compatible-responses")
			expect(requests).toHaveLength(ORDINARY_TURN_COUNT * 2 + AUTO_COMPACTION_COUNT)
			const expectedRequestSequence = ["tools", "qna_respond"]
			for (let cycleIndex = 0; cycleIndex < AUTO_COMPACTION_COUNT; cycleIndex++) {
				expectedRequestSequence.push("summarize_task", "tools", "qna_respond")
			}
			expect(requests.map(({ responseType, toolName }) => toolName ?? responseType)).toEqual(expectedRequestSequence)
			const diagnostics = requests.map(({ cacheDiagnostic }) => {
				if (!cacheDiagnostic) throw new Error("Missing OpenAI cache diagnostic")
				return cacheDiagnostic
			})
			const baseline = diagnostics[0]
			const baselineRequestBody = requests[0].requestBody as {
				prompt_cache_key?: string
				reasoning?: { effort?: string }
				service_tier?: string
			}
			expect(baselineRequestBody.prompt_cache_key).toBeTruthy()
			expect(baseline.stablePrefixTokens).toBeGreaterThanOrEqual(30_000)
			expect(baseline.componentTexts.system).toContain(RULE_MARKER)
			expect(baseline.componentTexts.system).toContain(SKILL_NAME)
			expect(baseline.componentTexts.system).toContain(WORKFLOW_NAME)
			expect(baseline.componentTexts.system).toContain(MCP_TOOL_NAME)
			for (const [requestIndex, diagnostic] of diagnostics.entries()) {
				const requestBody = requests[requestIndex].requestBody as {
					prompt_cache_key?: string
					reasoning?: { effort?: string }
					service_tier?: string
				}
				expect(requestBody.prompt_cache_key).toBe(baselineRequestBody.prompt_cache_key)
				if (requestIndex > 0) {
					expect(diagnostic.prefixHashMatched).toBe(true)
					expect(diagnostic.actualPrefixHash).toBe(baseline.actualPrefixHash)
					expect(diagnostic.stablePrefixTokens).toBe(baseline.stablePrefixTokens)
					expect(diagnostic.warnings.map(({ code }) => code)).not.toContain("prefix_hash_mismatch")
				}
			}
			for (let turnIndex = 0; turnIndex < ORDINARY_TURN_COUNT; turnIndex++) {
				const toolsRequestIndex = turnIndex === 0 ? 0 : turnIndex * 3
				const relatedRequests =
					turnIndex === 0 ? requests.slice(0, 2) : requests.slice(toolsRequestIndex - 1, toolsRequestIndex + 2)
				const step = runtimeOverrides[turnIndex]
				expect(requests[toolsRequestIndex].responseToolCalls).toHaveLength(turns[turnIndex].toolCalls.length)
				expect(requests[toolsRequestIndex].requestToolPairing.complete).toBe(true)
				for (const request of relatedRequests) {
					const requestBody = request.requestBody as { reasoning?: { effort?: string }; service_tier?: string }
					expect(requestBody.reasoning?.effort).toBe(step.reasoningEffort)
					expect(requestBody.service_tier).toBe(step.serviceTier)
				}
			}
			const summaryRequests = requests.filter(({ toolName }) => toolName === "summarize_task")
			expect(summaryRequests).toHaveLength(AUTO_COMPACTION_COUNT)
			for (let cycleIndex = 0; cycleIndex < AUTO_COMPACTION_COUNT; cycleIndex++) {
				const summaryRequest = requests[cycleIndex * 3 + 2]
				const postCompactionOrdinary = requests[cycleIndex * 3 + 3]
				expect(summaryRequest.toolCallId).toBe(`call_auto_cache_summary_${scenario.seedHex}_${cycleIndex + 1}`)
				expect(postCompactionOrdinary.responseType).toBe("tools")
				if (!summaryRequest.cacheDiagnostic || !postCompactionOrdinary.cacheDiagnostic) {
					throw new Error(`Missing cache diagnostic for automatic compaction cycle ${cycleIndex + 1}`)
				}
				expect(summaryRequest.cacheDiagnostic.prefixHashMatched).toBe(true)
				expect(summaryRequest.cacheDiagnostic.totalInputTokens).toBeGreaterThanOrEqual(MIN_NEAR_TRIGGER_INPUT_TOKENS)
				expect(
					summaryRequest.cacheDiagnostic.totalInputTokens - summaryRequest.cacheDiagnostic.cacheReadTokens,
				).toBeLessThanOrEqual(MAX_COMPACTION_DYNAMIC_TAIL_TOKENS)
				expect(postCompactionOrdinary.cacheDiagnostic.prefixHashMatched).toBe(true)
				expect(postCompactionOrdinary.cacheDiagnostic.cacheReadTokens).toBeGreaterThanOrEqual(30_000)
				expect(postCompactionOrdinary.cacheDiagnostic.cacheReadTokens).toBeGreaterThan(3_500)
			}
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
