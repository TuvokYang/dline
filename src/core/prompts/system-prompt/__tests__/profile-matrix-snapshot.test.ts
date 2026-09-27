import * as fs from "node:fs/promises"
import * as path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { GPT_IMAGE_2_MODEL_ID } from "../../../../shared/image-generation"
import { LOCAL_WEB_SEARCH_ROUTING_PLAN } from "../../__tests__/web-search-routing-fixtures"
import { renderCapabilitiesSection } from "../../capabilities/CapabilitiesSection"
import { SystemPromptGenerator } from "../../generators/SystemPromptGenerator"
import { PromptProfile } from "../../profiles/types"
import type { SystemPromptContext } from "../context"
import {
	PROFILE_SNAPSHOT_CASES,
	profileSnapshotName,
	SNAPSHOT_PROFILES,
	SNAPSHOT_TRANSPORTS,
	type SnapshotProfile,
	type SnapshotTransport,
} from "./profile-snapshot-cases"
import { assertPromptContent } from "./snapshot-content"

const UPDATE_NEW_SNAPSHOTS = process.env.UPDATE_NEW_PROMPT_SNAPSHOTS === "true"
const SNAPSHOTS_ROOT = path.join(__dirname, "__snapshots__")
const SNAPSHOTS_DIR = path.join(SNAPSHOTS_ROOT, "profiles")

const BASE_CONTEXT = {
	cwd: "/workspace/project",
	ide: "Test IDE",
	providerInfo: {
		providerId: "cline",
		model: { id: "explicit-profile-snapshot", info: { id: "explicit-profile-snapshot", capabilities: {} } },
		mode: "act",
	},
	supportsBrowserUse: true,
	browserSettings: { viewport: { width: 1280, height: 800 }, disableToolUse: false },
	mcpHub: {
		getServers: () => [
			{
				uid: "snapshot-mcp",
				name: "Snapshot MCP",
				config: "{}",
				status: "connected" as const,
				tools: [
					{
						name: "echo",
						description: "Returns the complete provided text.",
						inputSchema: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
						},
					},
				],
			},
		],
	},
	skills: [
		{ name: "review", description: "Review complete Prompt differences.", path: "/skills/review.md", source: "project" },
	],
	focusChainSettings: { enabled: true, remindClineInterval: 6 },
	globalClineRulesFileInstructions: "Global project rules.",
	localClineRulesFileInstructions: "Local Dline rules.",
	localCursorRulesFileInstructions: "Local Cursor rules.",
	localAgentsRulesFileInstructions: "Local agent rules.",
	preferredLanguageInstructions: "Preferred language: zh-CN.",
	subagentsEnabled: true,
	clineWebToolsEnabled: true,
	webSearchRoutingPlan: LOCAL_WEB_SEARCH_ROUTING_PLAN,
	imageGenerationAvailable: true,
	imageModelId: GPT_IMAGE_2_MODEL_ID,
	enableParallelToolCalling: true,
	yoloModeToggled: false,
	isCliEnvironment: false,
	isTesting: true,
} as SystemPromptContext

async function assertCompleteSnapshot(name: string, content: string): Promise<void> {
	assertPromptContent(name, content)
	const snapshotPath = path.join(SNAPSHOTS_DIR, name)
	if (UPDATE_NEW_SNAPSHOTS) {
		await fs.writeFile(snapshotPath, content, "utf-8")
		return
	}
	expect(await fs.readFile(snapshotPath, "utf-8")).toBe(content)
}

function createContext(
	profile: SnapshotProfile,
	transport: SnapshotTransport,
	overrides: Partial<SystemPromptContext>,
): SystemPromptContext {
	const context = {
		...BASE_CONTEXT,
		...overrides,
		promptProfile: profile === "lite" ? PromptProfile.Lite : PromptProfile.Standard,
		providerInfo: {
			...BASE_CONTEXT.providerInfo,
			...overrides.providerInfo,
		},
		enableNativeToolCalls: transport === "native",
	} as SystemPromptContext
	const capabilities = {
		mcp:
			context.mcpHub?.getServers().some((server) => server.status === "connected" && server.disabled !== true) === true
				? [{ name: "Snapshot MCP.echo", description: "Returns the complete provided text." }]
				: [],
		skills: [{ name: "review", description: "Review complete Prompt differences." }],
		workflows: [{ name: "release", description: "Run the release workflow." }],
		subagents: context.subagentsEnabled === true ? [{ name: "reviewer", description: "Review implementation changes." }] : [],
	}
	return {
		...context,
		capabilities,
		capabilitiesSection: renderCapabilitiesSection(capabilities),
	}
}

function serializeTools(tools: Awaited<ReturnType<SystemPromptGenerator["generate"]>>["tools"]): string {
	return `${JSON.stringify(tools ?? [], null, 2)}\n`
}

function expectedSnapshotNames(): readonly string[] {
	return SNAPSHOT_PROFILES.flatMap((profile) =>
		SNAPSHOT_TRANSPORTS.flatMap((transport) =>
			PROFILE_SNAPSHOT_CASES.flatMap((snapshotCase) => [
				profileSnapshotName(profile, transport, snapshotCase.id, "prompt"),
				...(transport === "native" ? [profileSnapshotName(profile, transport, snapshotCase.id, "tools")] : []),
			]),
		),
	).sort()
}

describe("complete explicit-profile snapshot matrix", () => {
	beforeAll(async () => {
		await fs.mkdir(SNAPSHOTS_DIR, { recursive: true })
		const expectedNames = expectedSnapshotNames()
		const actualNames = (await fs.readdir(SNAPSHOTS_DIR, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && entry.name.endsWith(".snap"))
			.map((entry) => entry.name)
		if (UPDATE_NEW_SNAPSHOTS) {
			await Promise.all(
				actualNames
					.filter((name) => !expectedNames.includes(name))
					.map((name) => fs.unlink(path.join(SNAPSHOTS_DIR, name))),
			)
		}
	})

	afterAll(async () => {
		const generatedNames = (await fs.readdir(SNAPSHOTS_DIR, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && entry.name.endsWith(".snap"))
			.map((entry) => entry.name)
			.sort()
		expect(generatedNames).toEqual(expectedSnapshotNames())
	})

	for (const profile of SNAPSHOT_PROFILES) {
		for (const transport of SNAPSHOT_TRANSPORTS) {
			for (const snapshotCase of PROFILE_SNAPSHOT_CASES) {
				it(`${profile}/${transport}/${snapshotCase.id}`, async () => {
					const generated = await new SystemPromptGenerator().generate(
						createContext(profile, transport, snapshotCase.overrides),
					)

					expect(generated.profile).toBe(profile)
					expect(generated.warnings).toEqual([])
					await assertCompleteSnapshot(
						profileSnapshotName(profile, transport, snapshotCase.id, "prompt"),
						generated.systemPrompt,
					)
					if (transport === "native") {
						await assertCompleteSnapshot(
							profileSnapshotName(profile, transport, snapshotCase.id, "tools"),
							serializeTools(generated.tools),
						)
					}
				})
			}
		}
	}
})
