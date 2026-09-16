import { CLINE_MCP_TOOL_IDENTIFIER } from "@shared/mcp"
import { hashStableJson } from "@shared/stable-json"
import { ClineDefaultTool } from "@shared/tools"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect, it, vi } from "vitest"
import { DEFAULT_SUBAGENT_ALLOWED_TOOLS } from "../../../task/tools/subagent/DefaultSubagentConfig"
import { hashPromptContent } from "../../system-prompt-cache/hash"
import { collectCapabilities } from "../CapabilitiesAggregator"

vi.mock("@core/context/instructions/user-instructions/skills", () => ({
	discoverAvailableSkills: vi.fn(async () => [{ name: "writer", description: "Write text", path: "skill", source: "project" }]),
	getSkillContent: vi.fn(async () => ({
		name: "writer",
		description: "Write text",
		path: "skill",
		source: "project",
		instructions: "PRIVATE_SKILL_INSTRUCTIONS",
	})),
}))

describe("collectCapabilities", () => {
	it("collects MCP and skill capabilities with only name and description", async () => {
		const snapshot = await collectCapabilities({
			cwd: process.cwd(),
			mcpHub: {
				getServers: () => [
					{
						name: "server",
						config: "{}",
						status: "connected" as const,
						tools: [
							{
								name: "tool",
								description: "Run tool",
								inputSchema: { type: "object", properties: { privateMarker: { type: "string" } } },
							},
						],
					},
				],
			},
		})

		expect(snapshot.mcp).toEqual([
			{
				name: "server.tool",
				description: "Run tool",
				contentHash: hashStableJson({ type: "object", properties: { privateMarker: { type: "string" } } }),
				nativeToolHash: hashPromptContent(`server${CLINE_MCP_TOOL_IDENTIFIER}tool`),
			},
		])
		expect(snapshot.skills).toEqual([
			{
				name: "writer",
				description: "Write text",
				contentHash: hashPromptContent("PRIVATE_SKILL_INSTRUCTIONS"),
			},
		])
		expect(JSON.stringify(snapshot)).not.toContain("inputSchema")
		expect(JSON.stringify(snapshot)).not.toContain("privateMarker")
		expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_SKILL_INSTRUCTIONS")
	})

	it("collects workflow and subagent capabilities from project files", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dline-capabilities-"))
		try {
			const workflowDir = path.join(cwd, ".agents", "workflows")
			const subagentDir = path.join(cwd, ".agents", "subagents")
			await fs.mkdir(workflowDir, { recursive: true })
			await fs.mkdir(subagentDir, { recursive: true })
			await fs.writeFile(
				path.join(workflowDir, "release.md"),
				"---\nname: release\ndescription: Release flow\n---\nbody",
				"utf8",
			)
			await fs.writeFile(
				path.join(subagentDir, "reviewer.yaml"),
				"---\nname: reviewer\ndescription: Review code\ntools: []\n---\nReview system prompt",
				"utf8",
			)
			await fs.writeFile(
				path.join(subagentDir, "default.yml"),
				"---\nname: default\ndescription: Customized default research\ntools: []\n---\nCustom default prompt",
				"utf8",
			)

			const snapshot = await collectCapabilities({ cwd })

			expect(snapshot.workflows).toEqual([
				{
					name: "release",
					description: "Release flow",
					contentHash: hashPromptContent("---\nname: release\ndescription: Release flow\n---\nbody"),
				},
			])
			expect(snapshot.subagents).toEqual([
				{
					name: "default",
					description: "Customized default research",
					contentHash: hashPromptContent(
						"---\nname: default\ndescription: Customized default research\ntools: []\n---\nCustom default prompt",
					),
					// An empty list inherits the default allowlist, minus the command
					// tool the built-in default never receives.
					tools: DEFAULT_SUBAGENT_ALLOWED_TOOLS.filter((tool) => tool !== ClineDefaultTool.BASH),
				},
				{
					name: "reviewer",
					description: "Review code",
					contentHash: hashPromptContent(
						"---\nname: reviewer\ndescription: Review code\ntools: []\n---\nReview system prompt",
					),
					tools: DEFAULT_SUBAGENT_ALLOWED_TOOLS,
				},
			])
			expect(JSON.stringify(snapshot)).not.toContain("Review system prompt")
			expect(JSON.stringify(snapshot)).not.toContain("Custom default prompt")
		} finally {
			await fs.rm(cwd, { recursive: true, force: true })
		}
	})

	it("collects enabled remote workflows while preserving local precedence", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dline-capabilities-"))
		try {
			const workflowDir = path.join(cwd, ".agents", "workflows")
			await fs.mkdir(workflowDir, { recursive: true })
			await fs.writeFile(
				path.join(workflowDir, "shared.md"),
				"---\nname: shared\ndescription: Local workflow wins\n---\nbody",
				"utf8",
			)

			const snapshot = await collectCapabilities({
				cwd,
				remoteWorkflowEntries: [
					{
						name: "shared",
						alwaysEnabled: true,
						contents: "---\ndescription: Remote duplicate\n---\nbody",
					},
					{
						name: "remote-enabled",
						alwaysEnabled: false,
						contents: "---\ndescription: Remote enabled workflow\n---\nbody",
					},
					{
						name: "remote-disabled",
						alwaysEnabled: false,
						contents: "---\ndescription: Remote disabled workflow\n---\nbody",
					},
				],
				remoteWorkflowToggles: {
					"remote-enabled": true,
					"remote-disabled": false,
				},
			})

			expect(snapshot.workflows).toEqual([
				{
					name: "remote-enabled",
					description: "Remote enabled workflow",
					contentHash: hashPromptContent("---\ndescription: Remote enabled workflow\n---\nbody"),
				},
				{
					name: "shared",
					description: "Local workflow wins",
					contentHash: hashPromptContent("---\nname: shared\ndescription: Local workflow wins\n---\nbody"),
				},
			])
			expect(JSON.stringify(snapshot)).not.toContain("Remote duplicate")
			expect(JSON.stringify(snapshot)).not.toContain("Remote disabled workflow")
		} finally {
			await fs.rm(cwd, { recursive: true, force: true })
		}
	})

	it("changes the Subagent content fingerprint when only its execution config changes", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dline-capabilities-"))
		try {
			const subagentDir = path.join(cwd, ".agents", "subagents")
			const subagentPath = path.join(subagentDir, "reviewer.yaml")
			await fs.mkdir(subagentDir, { recursive: true })
			await fs.writeFile(
				subagentPath,
				"---\nname: reviewer\ndescription: Review code\ntools: []\n---\nPrivate prompt version one",
				"utf8",
			)
			const first = await collectCapabilities({ cwd })

			await fs.writeFile(
				subagentPath,
				"---\nname: reviewer\ndescription: Review code\ntools: []\n---\nPrivate prompt version two",
				"utf8",
			)
			const second = await collectCapabilities({ cwd })

			const firstReviewer = first.subagents.find((entry) => entry.name === "reviewer")
			const secondReviewer = second.subagents.find((entry) => entry.name === "reviewer")
			expect(firstReviewer?.description).toBe(secondReviewer?.description)
			expect(firstReviewer?.contentHash).not.toBe(secondReviewer?.contentHash)
			expect(JSON.stringify(second)).not.toContain("Private prompt version two")
		} finally {
			await fs.rm(cwd, { recursive: true, force: true })
		}
	})

	it("excludes invalid subagent yaml from capabilities", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dline-capabilities-"))
		try {
			const subagentDir = path.join(cwd, ".agents", "subagents")
			await fs.mkdir(subagentDir, { recursive: true })
			await fs.writeFile(
				path.join(subagentDir, "invalid.yaml"),
				"---\nname: invalid\ndescription: Missing body\ntools: []\n---\n",
				"utf8",
			)

			const snapshot = await collectCapabilities({ cwd })

			expect(snapshot.subagents).toEqual([
				{
					name: "default",
					description: "Built-in readonly research subagent",
					tools: DEFAULT_SUBAGENT_ALLOWED_TOOLS.filter((tool) => tool !== ClineDefaultTool.BASH),
				},
			])
		} finally {
			await fs.rm(cwd, { recursive: true, force: true })
		}
	})

	it("carries the advertised tool allowlist through to the collected snapshot", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dline-capabilities-"))
		try {
			const subagentDir = path.join(cwd, ".agents", "subagents")
			await fs.mkdir(subagentDir, { recursive: true })
			await fs.writeFile(
				path.join(subagentDir, "reviewer.yaml"),
				"---\nname: reviewer\ndescription: Review code\ntools:\n  - read_file\n  - search_files\n---\nReview system prompt",
				"utf8",
			)

			const snapshot = await collectCapabilities({ cwd })

			// Asserted on the aggregator's own output rather than a hand-built
			// entry: normalisation rebuilds every entry, so a renderer-level test
			// cannot prove the list survives collection.
			const reviewer = snapshot.subagents.find((entry) => entry.name === "reviewer")
			expect(reviewer?.tools).toEqual([ClineDefaultTool.FILE_READ, ClineDefaultTool.SEARCH, ClineDefaultTool.ATTEMPT])
		} finally {
			await fs.rm(cwd, { recursive: true, force: true })
		}
	})
})
