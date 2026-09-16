import { strict as assert } from "node:assert"
import fs from "fs/promises"
import os from "os"
import * as path from "path"
import { afterEach, describe, it } from "vitest"
import { ClineDefaultTool, getToolUseNames } from "@/shared/tools"
import {
	AGENTS_CONFIG_DIRECTORY_NAME,
	AgentConfigLoader,
	ensureDefaultSubagentConfigExists,
	parseAgentConfigFromYaml,
	readAgentConfigsFromDisk,
	resolveAgentConfig,
} from "../AgentConfigLoader"

async function createTempHomeDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "agent-config-loader-"))
}

describe("AgentConfigLoader", () => {
	const tempDirs: string[] = []

	afterEach(async () => {
		await AgentConfigLoader.resetInstanceForTests()
		await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
		tempDirs.length = 0
	})

	it("parses a profile frontmatter config and system prompt body", () => {
		const content = `---
name: code-reviewer
description: Reviews code for quality and best practices
tools: read_file, list_files, search_files
profile: subagent-reviewer
maxOutputTokens: 0.05
---

You are a code reviewer.`

		const parsed = parseAgentConfigFromYaml(content)

		assert.equal(parsed.name, "code-reviewer")
		assert.equal(parsed.description, "Reviews code for quality and best practices")
		assert.equal((parsed as { profile?: string }).profile, "subagent-reviewer")
		assert.equal(parsed.maxOutputTokens, 0.05)
		assert.equal("modelId" in parsed, false)
		assert.deepEqual(parsed.tools, [ClineDefaultTool.FILE_READ, ClineDefaultTool.LIST_FILES, ClineDefaultTool.SEARCH])
		assert.equal(parsed.systemPrompt, "You are a code reviewer.")
	})

	it("loads hand-edited config that names turn-ending tools, dropping them instead of failing", () => {
		const content = `---
name: code-reviewer
description: Reviews code for quality and best practices
tools: read_file, ask_followup_question, make_plan, qna_respond, generate_report, new_task
---

You are a code reviewer.`

		const parsed = parseAgentConfigFromYaml(content)

		// Only the readable tool survives; the run would stall on any of the rest.
		assert.deepEqual(parsed.tools, [ClineDefaultTool.FILE_READ])
	})

	it("keeps attempt_completion when the config names it explicitly", () => {
		const content = `---
name: code-reviewer
description: Reviews code for quality and best practices
tools: read_file, attempt_completion
---

You are a code reviewer.`

		const parsed = parseAgentConfigFromYaml(content)

		assert.deepEqual(parsed.tools, [ClineDefaultTool.FILE_READ, ClineDefaultTool.ATTEMPT])
	})

	it("marks a config whose tools were all rejected, so it is not mistaken for an absent list", () => {
		const content = `---
name: code-reviewer
description: Reviews code for quality and best practices
tools: ask_followup_question, make_plan
---

You are a code reviewer.`

		const parsed = parseAgentConfigFromYaml(content)

		// The author asked for a narrow set. Without the marker this is
		// indistinguishable from "no tools field", which inherits the default
		// allowlist and would grant more than was requested.
		assert.deepEqual(parsed.tools, [])
		assert.equal((parsed as { toolsExplicitlyNarrowed?: boolean }).toolsExplicitlyNarrowed, true)
	})

	it("does not mark a config that omits the tools field", () => {
		const content = `---
name: code-reviewer
description: Reviews code for quality and best practices
---

You are a code reviewer.`

		const parsed = parseAgentConfigFromYaml(content)

		assert.deepEqual(parsed.tools, [])
		assert.equal((parsed as { toolsExplicitlyNarrowed?: boolean }).toolsExplicitlyNarrowed, undefined)
	})

	it("parses an absolute maxOutputTokens budget", () => {
		const content = `---
name: detailed-reviewer
description: Returns detailed findings
maxOutputTokens: 10240
---

Prompt body`

		const parsed = parseAgentConfigFromYaml(content)

		assert.equal(parsed.maxOutputTokens, 10_240)
	})

	it.each([0, -0.05, 1.5])("rejects invalid maxOutputTokens value %s", (maxOutputTokens) => {
		const content = `---
name: invalid-budget
description: Invalid output budget
maxOutputTokens: ${maxOutputTokens}
---

Prompt body`

		assert.throws(() => parseAgentConfigFromYaml(content), /maxOutputTokens/)
	})

	it("supports raw Cline tool ids in tools", () => {
		const content = `---
name: cli-agent
description: Uses internal ids
tools:
  - read_file
  - list_files
profile: cli-profile
---

Prompt body`

		const parsed = parseAgentConfigFromYaml(content)
		assert.deepEqual(parsed.tools, [ClineDefaultTool.FILE_READ, ClineDefaultTool.LIST_FILES])
	})

	it("migrates the retired use_skill tool id to load_skill", () => {
		const content = `---
name: legacy-skill-agent
description: Uses the retired skill tool id
tools: use_skill
---

Prompt body`

		const parsed = parseAgentConfigFromYaml(content)

		assert.deepEqual(parsed.tools, [ClineDefaultTool.LOAD_SKILL])
	})

	it("ignores deprecated modelId frontmatter", () => {
		const content = `---
name: legacy-agent
description: legacy
modelId: old-profile
---

Prompt body`

		const parsed = parseAgentConfigFromYaml(content)

		assert.equal((parsed as { profile?: string }).profile, undefined)
		assert.equal("modelId" in parsed, false)
	})

	it("throws for unknown tools", () => {
		const content = `---
name: bad-agent
description: bad
tools: Read, NotARealTool
profile: bad-profile
---

Prompt body`

		assert.throws(() => parseAgentConfigFromYaml(content), /Unknown tool/)
	})

	it("creates default.yml when the global subagent directory has no YAML files", async () => {
		const directoryPath = await createTempHomeDir()
		tempDirs.push(directoryPath)

		const createdPath = await ensureDefaultSubagentConfigExists(directoryPath)
		const content = await fs.readFile(path.join(directoryPath, "default.yml"), "utf8")
		const parsed = parseAgentConfigFromYaml(content)

		assert.equal(createdPath, path.join(directoryPath, "default.yml"))
		assert.equal(parsed.name, "default")
		assert.match(parsed.systemPrompt, /default readonly research subagent/)
	})

	it("does not overwrite or add default.yml when any YAML config already exists", async () => {
		const directoryPath = await createTempHomeDir()
		tempDirs.push(directoryPath)
		const existingPath = path.join(directoryPath, "reviewer.yaml")
		const existingContent = `---
name: reviewer
description: Existing reviewer
---
Keep this prompt unchanged.`
		await fs.writeFile(existingPath, existingContent, "utf8")

		const createdPath = await ensureDefaultSubagentConfigExists(directoryPath)

		assert.equal(createdPath, undefined)
		assert.equal(await fs.readFile(existingPath, "utf8"), existingContent)
		await assert.rejects(fs.stat(path.join(directoryPath, "default.yml")), { code: "ENOENT" })
	})

	it("returns an empty config map when the agents directory does not exist", async () => {
		const tempHome = await createTempHomeDir()
		tempDirs.push(tempHome)

		const result = await readAgentConfigsFromDisk(path.join(tempHome, "Documents", "Dline", AGENTS_CONFIG_DIRECTORY_NAME))
		assert.equal(result.size, 0)
	})

	it("loads all yaml/yml files from homeDir/.cline/data/agents", async () => {
		const tempHome = await createTempHomeDir()
		tempDirs.push(tempHome)

		const directoryPath = path.join(tempHome, "Documents", "Dline", AGENTS_CONFIG_DIRECTORY_NAME)
		await fs.mkdir(directoryPath, { recursive: true })
		await fs.writeFile(
			path.join(directoryPath, "local-agent.yaml"),
			`---
name: local-agent
description: local agent
tools: read_file
profile: local-profile
---

Prompt body`,
			"utf8",
		)
		await fs.writeFile(
			path.join(directoryPath, "reviewer.yml"),
			`---
name: reviewer
description: reviewer agent
tools: list_files
profile: reviewer-profile
---

Reviewer prompt`,
			"utf8",
		)
		await fs.writeFile(path.join(directoryPath, "ignored.txt"), "not yaml", "utf8")

		const loader = AgentConfigLoader.getInstance(directoryPath)
		await loader.load()

		const localAgent = loader.getCachedConfig("local-agent")
		const reviewer = loader.getCachedConfig("reviewer")
		assert.equal(localAgent?.name, "local-agent")
		assert.deepEqual(localAgent?.tools, [ClineDefaultTool.FILE_READ])
		assert.equal(localAgent?.systemPrompt, "Prompt body")
		assert.equal(reviewer?.name, "reviewer")
		assert.deepEqual(reviewer?.tools, [ClineDefaultTool.LIST_FILES])
		assert.equal(loader.getAllCachedConfigs().size, 2)
	})

	it("prefers a local YAML config and preserves its system prompt body", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-loader-cwd-"))
		tempDirs.push(cwd)
		const projectDir = path.join(cwd, ".agents", "subagents")
		await fs.mkdir(projectDir, { recursive: true })
		await fs.writeFile(
			path.join(projectDir, "reviewer.yml"),
			`---
name: reviewer
description: Local reviewer
---
Local reviewer system prompt.`,
			"utf8",
		)

		const resolved = await resolveAgentConfig(cwd, "reviewer")

		assert.equal(resolved?.source, "project")
		assert.equal(resolved?.config.systemPrompt, "Local reviewer system prompt.")
	})

	it("does not resolve disabled project subagents", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-loader-cwd-"))
		tempDirs.push(cwd)
		const directoryPath = path.join(cwd, ".agents", "subagents")
		const filePath = path.join(directoryPath, "disabled.yaml")
		await fs.mkdir(directoryPath, { recursive: true })
		await fs.writeFile(
			filePath,
			`---
name: disabled-agent
description: disabled agent
tools: read_file
profile: reviewer-profile
---

Reviewer prompt`,
			"utf8",
		)

		const resolved = await resolveAgentConfig(cwd, "disabled-agent", { subagentToggles: { [filePath]: false } })

		assert.equal(resolved, undefined)
	})

	it("does not register dynamic subagent tool names after loading configs", async () => {
		const tempHome = await createTempHomeDir()
		tempDirs.push(tempHome)

		const directoryPath = path.join(tempHome, "Documents", "Dline", AGENTS_CONFIG_DIRECTORY_NAME)
		await fs.mkdir(directoryPath, { recursive: true })
		await fs.writeFile(
			path.join(directoryPath, "code-reviewer.yaml"),
			`---
name: code reviewer
description: reviewer agent
tools: read_file
profile: reviewer-profile
---

Reviewer prompt`,
			"utf8",
		)

		const loader = AgentConfigLoader.getInstance(directoryPath)
		await loader.load()

		assert.equal(loader.getCachedConfig("code reviewer")?.name, "code reviewer")
		assert.deepEqual(loader.getAllCachedConfigsWithToolNames(), [])
		assert.equal(loader.resolveSubagentNameForTool("use_subagent_code_reviewer"), undefined)
		assert.equal(loader.isDynamicSubagentTool("use_subagent_code_reviewer"), false)
		assert.ok(getToolUseNames().includes(ClineDefaultTool.USE_SUBAGENT))
		assert.ok(getToolUseNames().includes(ClineDefaultTool.USE_SUBAGENTS))
		assert.equal(
			getToolUseNames().some((toolName) => toolName.startsWith("use_subagent_")),
			false,
		)
	})
})
