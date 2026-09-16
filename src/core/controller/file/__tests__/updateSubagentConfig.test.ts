import { strict as assert } from "node:assert"
import { parseAgentConfigFromYaml } from "@core/task/tools/subagent/AgentConfigLoader"
import { UpdateSubagentConfigRequest } from "@shared/proto/dline/file"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { updateSubagentConfig } from "../updateSubagentConfig"

const temporaryDirectories: string[] = []

function createController() {
	const flushPromptFreshnessInvalidation = vi.fn().mockResolvedValue(undefined)
	return {
		controller: {
			task: { flushPromptFreshnessInvalidation },
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		} as never,
		flushPromptFreshnessInvalidation,
	}
}

describe("updateSubagentConfig", () => {
	afterEach(async () => {
		await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
	})

	it("preserves tools and skills when a profile-only protobuf patch omits list replacement", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "update-subagent-config-"))
		temporaryDirectories.push(directory)
		const subagentPath = path.join(directory, "reviewer.yml")
		await fs.writeFile(
			subagentPath,
			"---\nname: reviewer\ndescription: Research agent\ntools:\n  - read_file\n  - search_files\nskills:\n  - systematic-debugging\nprofile: old-profile\n---\nCustom reviewer instructions.\n",
			"utf8",
		)

		const request = UpdateSubagentConfigRequest.decode(
			UpdateSubagentConfigRequest.encode(
				UpdateSubagentConfigRequest.create({
					subagentPath,
					profile: "own-openai:deepseek-v4-flash",
				}),
			).finish(),
		)
		const fixture = createController()
		await updateSubagentConfig(fixture.controller, request)

		const content = await fs.readFile(subagentPath, "utf8")
		assert.match(content, /tools:\n\s{2}- read_file\n\s{2}- search_files/)
		assert.match(content, /skills:\n\s{2}- systematic-debugging/)
		assert.match(content, /description: Research agent/)
		assert.match(content, /profile: "own-openai:deepseek-v4-flash"/)
		assert.match(content, /Custom reviewer instructions\./)
		expect(fixture.flushPromptFreshnessInvalidation).toHaveBeenCalledWith("capability_mutation")
	})

	it("clears tools and skills only when replacement intent is explicit", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "update-subagent-config-"))
		temporaryDirectories.push(directory)
		const subagentPath = path.join(directory, "reviewer.yml")
		await fs.writeFile(
			subagentPath,
			"---\nname: reviewer\ndescription: Research agent\ntools:\n  - read_file\nskills:\n  - systematic-debugging\n---\nPrompt body\n",
			"utf8",
		)

		const fixture = createController()
		await updateSubagentConfig(
			fixture.controller,
			UpdateSubagentConfigRequest.create({
				subagentPath,
				tools: [],
				skills: [],
				replaceTools: true,
				replaceSkills: true,
			}),
		)

		const content = await fs.readFile(subagentPath, "utf8")
		assert.match(content, /tools: \[\]/)
		assert.match(content, /skills: \[\]/)
		assert.match(content, /Prompt body/)
		expect(fixture.flushPromptFreshnessInvalidation).toHaveBeenCalledOnce()
	})

	it("drops turn-ending tools when the request bypasses the selection UI", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "update-subagent-config-"))
		temporaryDirectories.push(directory)
		const subagentPath = path.join(directory, "reviewer.yml")
		await fs.writeFile(
			subagentPath,
			"---\nname: reviewer\ndescription: Research agent\ntools:\n  - read_file\n---\nPrompt body\n",
			"utf8",
		)

		const fixture = createController()
		await updateSubagentConfig(
			fixture.controller,
			UpdateSubagentConfigRequest.create({
				subagentPath,
				tools: ["read_file", "ask_followup_question", "make_plan", "new_task", "attempt_completion"],
				replaceTools: true,
			}),
		)

		const content = await fs.readFile(subagentPath, "utf8")
		assert.match(content, /tools:\n\s{2}- read_file/)
		assert.doesNotMatch(content, /ask_followup_question/)
		assert.doesNotMatch(content, /make_plan/)
		assert.doesNotMatch(content, /new_task/)
		// Granted unconditionally at resolution, so it is not a stored choice.
		assert.doesNotMatch(content, /attempt_completion/)
	})

	it("drops act_mode_respond, which opens an interaction a subagent has no user for", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "update-subagent-config-"))
		temporaryDirectories.push(directory)
		const subagentPath = path.join(directory, "reviewer.yml")
		await fs.writeFile(subagentPath, "---\nname: reviewer\ndescription: Research agent\n---\nPrompt body\n", "utf8")

		const fixture = createController()
		await updateSubagentConfig(
			fixture.controller,
			UpdateSubagentConfigRequest.create({
				subagentPath,
				tools: ["read_file", "act_mode_respond"],
				replaceTools: true,
			}),
		)

		const content = await fs.readFile(subagentPath, "utf8")
		assert.doesNotMatch(content, /act_mode_respond/)
		assert.match(content, /- read_file/)
	})

	it("stores only what was selected, leaving the always-granted tool out of the document", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "update-subagent-config-"))
		temporaryDirectories.push(directory)
		const subagentPath = path.join(directory, "reviewer.yml")
		await fs.writeFile(subagentPath, "---\nname: reviewer\ndescription: Research agent\n---\nPrompt body\n", "utf8")

		const fixture = createController()
		// The UI keeps attempt_completion checked, so it arrives in the request;
		// persisting it would present an unconditional grant as a stored choice.
		await updateSubagentConfig(
			fixture.controller,
			UpdateSubagentConfigRequest.create({
				subagentPath,
				tools: ["read_file", "attempt_completion"],
				replaceTools: true,
			}),
		)

		const content = await fs.readFile(subagentPath, "utf8")
		assert.match(content, /tools:\n\s{2}- read_file/)
		assert.doesNotMatch(content, /attempt_completion/)
	})

	it("rejects an unknown tool name the loader would refuse to read back", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "update-subagent-config-"))
		temporaryDirectories.push(directory)
		const subagentPath = path.join(directory, "reviewer.yml")
		await fs.writeFile(subagentPath, "---\nname: reviewer\ndescription: Research agent\n---\nPrompt body\n", "utf8")

		const fixture = createController()
		await updateSubagentConfig(
			fixture.controller,
			UpdateSubagentConfigRequest.create({ subagentPath, tools: ["read_file", "not_a_tool"], replaceTools: true }),
		)

		const content = await fs.readFile(subagentPath, "utf8")
		assert.doesNotMatch(content, /not_a_tool/)
		// The document must stay loadable; parseAgentConfigFromYaml throws on
		// an unknown tool, which would remove the subagent entirely.
		assert.doesNotThrow(() => parseAgentConfigFromYaml(content))
	})

	it("removes a forbidden tool already in the document even when the update targets another field", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "update-subagent-config-"))
		temporaryDirectories.push(directory)
		const subagentPath = path.join(directory, "reviewer.yml")
		await fs.writeFile(
			subagentPath,
			"---\nname: reviewer\ndescription: Research agent\ntools:\n  - read_file\n  - make_plan\n---\nPrompt body\n",
			"utf8",
		)

		const fixture = createController()
		// A profile-only update carries no tool intent, but leaving the stored
		// list untouched would let a hand-edited document keep a tool no save
		// would ever produce.
		await updateSubagentConfig(
			fixture.controller,
			UpdateSubagentConfigRequest.create({ subagentPath, profile: "reviewer-profile" }),
		)

		const content = await fs.readFile(subagentPath, "utf8")
		assert.doesNotMatch(content, /make_plan/)
		assert.match(content, /- read_file/)
	})

	it("keeps an explicit empty tool list empty so it still inherits the default allowlist", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "update-subagent-config-"))
		temporaryDirectories.push(directory)
		const subagentPath = path.join(directory, "reviewer.yml")
		await fs.writeFile(subagentPath, "---\nname: reviewer\ndescription: Research agent\n---\nPrompt body\n", "utf8")

		const fixture = createController()
		await updateSubagentConfig(
			fixture.controller,
			UpdateSubagentConfigRequest.create({ subagentPath, tools: [], replaceTools: true }),
		)

		const content = await fs.readFile(subagentPath, "utf8")
		assert.match(content, /tools: \[\]/)
		assert.doesNotMatch(content, /attempt_completion/)
	})

	it("keeps YAML frontmatter delimiters on separate lines when updating fields", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "update-subagent-config-"))
		temporaryDirectories.push(directory)
		const subagentPath = path.join(directory, "reviewer.yml")
		await fs.writeFile(
			subagentPath,
			"---\nname: reviewer\ndescription: Research and exploration subagent\ntools: []\nskills: []\nprofile: old-profile\n---\nPrompt body\n",
			"utf8",
		)

		const fixture = createController()
		await updateSubagentConfig(fixture.controller, {
			subagentPath,
			profile: "deepseek:deepseek-v4-pro",
			tools: [],
			skills: [],
			description: "Research and exploration subagent",
		} as never)

		const content = await fs.readFile(subagentPath, "utf8")
		assert.match(content, /^---\nname: reviewer\n/)
		assert.doesNotMatch(content, /^---name:/)
		assert.match(content, /\n---\nPrompt body/)
		expect(fixture.flushPromptFreshnessInvalidation).toHaveBeenCalledOnce()
	})
})
