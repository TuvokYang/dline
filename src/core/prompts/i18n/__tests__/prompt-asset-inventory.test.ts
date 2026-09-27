import * as fs from "node:fs/promises"
import * as path from "node:path"

import { describe, expect, it } from "vitest"

import { englishPromptGroups, englishPrompts } from "../en"

const EXPECTED_NAMESPACES = [
	"accessMcpResource",
	"actModeRespond",
	"agentRole",
	"applyPatch",
	"askFollowupQuestion",
	"attemptCompletion",
	"browserAction",
	"capabilitiesCore",
	"capabilityCatalog",
	"commands",
	"contextManagement",
	"deepPlanning5Step",
	"deepPlanningGeneric",
	"editingFiles",
	"execution",
	"executeCommand",
	"feedback",
	"findReferences",
	"focusChain",
	"generateExplanation",
	"generateImage",
	"generateReport",
	"inputQueue",
	"killCommand",
	"listCodeDefinitionNames",
	"listFiles",
	"loadCapability",
	"loadMcpDocumentation",
	"loadMcpDocumentationTool",
	"makePlan",
	"mcp",
	"newTask",
	"objective",
	"qnaRespond",
	"readFile",
	"rename",
	"replaceInFile",
	"replaceText",
	"responses",
	"resumeProvenance",
	"rules",
	"runtimeEnvironment",
	"searchFiles",
	"skills",
	"spawnTask",
	"statusUpdate",
	"subagent",
	"systemInfo",
	"taskProgress",
	"toolHandlers",
	"toolUseExamples",
	"toolUseFormatting",
	"toolUseGuidelines",
	"toolUseIndex",
	"toolUseTools",
	"useMcpTool",
	"userAuthority",
	"userCommunication",
	"userInstructions",
	"variants.lite",
	"variants.standard",
	"webFetch",
	"webSearch",
	"workflows",
	"writeToFile",
	"xmlProjection",
] as const

const PROMPTS_DIR = path.resolve(__dirname, "../..")

/**
 * Sorts immutable string collections for order-independent inventory assertions.
 *
 * @param values Values to copy and sort.
 * @returns A sorted mutable copy.
 */
function sortValues(values: readonly string[]): string[] {
	return [...values].sort()
}

/**
 * Collects production TypeScript source paths below a prompt directory.
 *
 * @param directory Directory to inspect recursively.
 * @returns Production TypeScript source paths below the directory.
 */
async function collectSources(directory: string): Promise<string[]> {
	const entries = await fs.readdir(directory, { withFileTypes: true })
	const sourcePaths: string[] = []

	for (const entry of entries) {
		if (entry.name === "__tests__") {
			continue
		}

		const entryPath = path.join(directory, entry.name)
		if (entry.isDirectory()) {
			sourcePaths.push(...(await collectSources(entryPath)))
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			sourcePaths.push(entryPath)
		}
	}

	return sourcePaths
}

describe("prompt asset inventory", () => {
	it("locks the final English namespace inventory", () => {
		expect(sortValues(Object.keys(englishPrompts))).toEqual(sortValues(EXPECTED_NAMESPACES))
		expect(EXPECTED_NAMESPACES).toHaveLength(66)
	})

	it("locks the static domain group order and coverage", () => {
		expect(englishPromptGroups.map((group) => group.name)).toEqual(["system", "tools", "commands", "variants"])
		expect(englishPromptGroups.map((group) => group.modules.length)).toEqual([27, 34, 3, 2])
		expect(englishPromptGroups.flatMap((group) => group.modules)).toHaveLength(66)
		expect(englishPromptGroups[3].modules.map((module) => module.name)).toEqual(["variants.standard", "variants.lite"])
		for (const group of englishPromptGroups) {
			for (const module of group.modules) {
				expect(module.source).toContain(`/en/${group.name}/`)
			}
		}
	})

	it("provides system prompt modules from the system domain", async () => {
		const systemEntries = [
			"agentRole.ts",
			"capabilitiesCore.ts",
			"contextManagement.ts",
			"editingFiles.ts",
			"execution.ts",
			"feedback.ts",
			"focusChain.ts",
			"inputQueue.ts",
			"mcp.ts",
			"objective.ts",
			"responses.ts",
			"resumeProvenance.ts",
			"rules.ts",
			"skills.ts",
			"systemInfo.ts",
			"taskProgress.ts",
			"toolUseExamples.ts",
			"toolUseFormatting.ts",
			"toolUseGuidelines.ts",
			"toolUseIndex.ts",
			"toolUseTools.ts",
			"userAuthority.ts",
			"userCommunication.ts",
			"userInstructions.ts",
			"workflows.ts",
		]

		await Promise.all(
			systemEntries.map((entry) => expect(fs.stat(path.resolve(__dirname, "../en/system", entry))).resolves.toBeDefined()),
		)
	})

	it("keeps the English root free of legacy prompt sources", async () => {
		const rootEntries = await fs.readdir(path.resolve(__dirname, "../en"), { withFileTypes: true })
		const rootSources = rootEntries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts")).map((entry) => entry.name)

		expect(rootSources).toEqual(["index.ts"])
	})

	it("keeps physical ownership in all four domains", async () => {
		const domainDirectories = ["system", "tools", "commands", "variants"] as const
		const domainSources = (
			await Promise.all(domainDirectories.map((directory) => collectSources(path.resolve(__dirname, "../en", directory))))
		).flat()

		await Promise.all(
			domainSources.map(async (sourcePath) => {
				const source = await fs.readFile(sourcePath, "utf-8")
				expect(source, path.relative(PROMPTS_DIR, sourcePath)).not.toMatch(
					/^export \{ default \} from "\.\.\/[^"]+"\s*$/m,
				)
			}),
		)

		const englishIndex = await fs.readFile(path.resolve(__dirname, "../en/index.ts"), "utf-8")
		const localDomainImports = [...englishIndex.matchAll(/^import .* from "(\.\/[^"]+)"$/gm)].map(
			([, modulePath]) => modulePath,
		)

		expect(localDomainImports).toEqual(["./commands/index", "./system/index", "./tools/index", "./variants/index"])
	})

	it("provides tool prompt modules from the tools domain", async () => {
		const toolEntries = [
			"accessMcpResource.ts",
			"actModeRespond.ts",
			"applyPatch.ts",
			"askFollowupQuestion.ts",
			"attemptCompletion.ts",
			"browserAction.ts",
			"executeCommand.ts",
			"findReferences.ts",
			"generateExplanation.ts",
			"generateReport.ts",
			"listCodeDefinitionNames.ts",
			"listFiles.ts",
			"loadCapability.ts",
			"loadMcpDocumentation.ts",
			"loadMcpDocumentationTool.ts",
			"makePlan.ts",
			"newTask.ts",
			"qnaRespond.ts",
			"readFile.ts",
			"rename.ts",
			"replaceInFile.ts",
			"replaceText.ts",
			"searchFiles.ts",
			"spawnTask.ts",
			"statusUpdate.ts",
			"subagent.ts",
			"toolHandlers.ts",
			"useMcpTool.ts",
			"webFetch.ts",
			"webSearch.ts",
			"writeToFile.ts",
		]

		await Promise.all(
			toolEntries.map((entry) => expect(fs.stat(path.resolve(__dirname, "../en/tools", entry))).resolves.toBeDefined()),
		)
	})

	it("registers four physical domain entry points", async () => {
		const domainEntries = ["system/index.ts", "tools/index.ts", "commands/index.ts", "variants/index.ts"]

		await Promise.all(
			domainEntries.map((entry) => expect(fs.stat(path.resolve(__dirname, "../en", entry))).resolves.toBeDefined()),
		)
	})
})
