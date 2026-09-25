import { describe, expect, it, vi } from "vitest"
import { LOCAL_WEB_SEARCH_ROUTING_PLAN } from "../../__tests__/web-search-routing-fixtures"
import { PromptProfile } from "../../profiles/types"
import { PromptScanner } from "../../template/PromptScanner"
import { assemblePromptFragments } from "../assembly/prompt-fragment-assembler"
import type { SystemPromptContext } from "../context"
import { assembleSystemPrompt, createSystemPromptConfig, prepareSystemRuntimeEnv, prepareToolUseSection } from "../pipeline"
import { SYSTEM_SECTION_IDS } from "../templates/system-template-registry"
import { createStandardSystemSections } from "../variants/section-content"

const BASE_CONTEXT: SystemPromptContext = {
	promptProfile: PromptProfile.Standard,
	cwd: "/workspace/project",
	ide: "Test IDE",
	providerInfo: {
		providerId: "cline",
		model: {
			id: "test-model",
			info: { id: "test-model", capabilities: { supportsImages: false, supportsPromptCache: false } },
		},
		mode: "act",
	},
	supportsBrowserUse: true,
	browserSettings: {
		viewport: { width: 1280, height: 800 },
		disableToolUse: false,
	},
	capabilitiesSection: "  capability catalog  ",
	focusChainSettings: { enabled: true, remindClineInterval: 6 },
	globalClineRulesFileInstructions: "Global project rules.",
	preferredLanguageInstructions: "Preferred language: zh-CN.",
	skills: [{ name: "review", description: "Review code changes.", path: "/skills/review.md", source: "project" }],
	subagentsEnabled: true,
	clineWebToolsEnabled: true,
	webSearchRoutingPlan: LOCAL_WEB_SEARCH_ROUTING_PLAN,
	enableNativeToolCalls: false,
	enableParallelToolCalling: true,
	yoloModeToggled: false,
	isCliEnvironment: true,
	terminalExecutionMode: "backgroundExec",
	isTesting: true,
}

describe("canonical system prompt pipeline", () => {
	it("projects the complete immutable SystemPromptConfig from typed PromptProfile input", () => {
		const context = {
			...BASE_CONTEXT,
			promptProfile: PromptProfile.Lite,
		}
		const config = createSystemPromptConfig(context)

		expect(config).toEqual({
			templateId: "integrated",
			variant: PromptProfile.Lite,
			transport: "xml",
			parallelTools: true,
			mcpEnabled: false,
			browserEnabled: false,
			focusChainEnabled: false,
			subagentsEnabled: false,
			subagentRun: false,
			yoloModeEnabled: false,
			cliEnvironment: true,
			webToolsEnabled: false,
			localWebSearchEnabled: false,
			serverWebSearchEnabled: false,
			userInstructionsEnabled: true,
		})
		expect(Object.isFrozen(config)).toBe(true)
	})

	it("prepares one frozen complete runtime env before unresolved content preparation", () => {
		const config = createSystemPromptConfig(BASE_CONTEXT)
		const env = prepareSystemRuntimeEnv(BASE_CONTEXT, config)

		expect(Object.isFrozen(env)).toBe(true)
		expect(env).toMatchObject({
			WORKSPACE_NAMES: "\n- project",
			WORKSPACE_PATH_RULE: "Use `path` for the default workspace or `@workspace:path` to target a named workspace.",
			PARALLEL_TOOLS_RULE: expect.stringContaining("multiple tools"),
			MCP_RULE: "",
			CLARIFY_PERMISSION: expect.stringContaining("ask the user clarifying questions"),
			PARALLEL_TOOL_POLICY: expect.stringContaining("multiple independent tools"),
			CUSTOM_INSTRUCTIONS: "Preferred language: zh-CN.\n\nGlobal project rules.",
			OS: "macOS",
			IDE: "TestIde",
			SUBAGENT_TIMEOUT_SECONDS: "1200",
		})
		expect(Reflect.set(env, "WORKSPACE_NAMES", "\n- mutated")).toBe(false)
		expect(env).not.toHaveProperty("CWD")
		expect(env).not.toHaveProperty("HOME_DIR")
		expect(env).not.toHaveProperty("XML_TOOLS_SECTION")
		expect(env).not.toHaveProperty("SUBAGENTS_GUIDANCE")
		expect(env).not.toHaveProperty("FOCUS_CHAIN_EXAMPLE_BASH")

		const sections = createStandardSystemSections(config)
		const sectionIds: readonly string[] = [...sections.keys()]
		expect(sectionIds).toEqual(SYSTEM_SECTION_IDS)
		expect(sections.get("system-info")).toContain("@WORKSPACE_NAMES@")
		expect(sections.get("execution")).toContain("@CLARIFY_RULE@")
		expect(sections.get("objective")).toBeTruthy()
		expect(sections.get("user-communication")).toBeTruthy()
		expect(sectionIds.indexOf("user-communication")).toBe(sectionIds.indexOf("act-vs-plan") + 1)
		expect(sectionIds.indexOf("tool-use")).toBe(sectionIds.indexOf("user-communication") + 1)
		expect(sectionIds.indexOf("feedback")).toBe(sectionIds.indexOf("user-instructions") - 1)
		expect(sectionIds).not.toContain("rules")
		expect(sectionIds).not.toContain("todo")
	})

	it("reports PowerShell as the Windows default terminal shell", () => {
		const originalPlatform = process.platform
		try {
			Object.defineProperty(process, "platform", { value: "win32" })
			const context = {
				...BASE_CONTEXT,
				defaultTerminalProfile: "default",
				isTesting: false,
			}
			const config = createSystemPromptConfig(context)

			const env = prepareSystemRuntimeEnv(context, config)

			expect(env.SHELL).toBe("powershell")
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform })
		}
	})

	it("assembles the stable unresolved template with exact-empty omission and no trimming", () => {
		const sections = new Map<string, string>(SYSTEM_SECTION_IDS.map((sectionId) => [sectionId, ""] as const))
		sections.set("agent-role", "  role @WORKSPACE_NAMES@  ")
		sections.set("tool-use", "@XML_TOOLS_SECTION@")
		sections.set("todo", "\n")

		expect(assembleSystemPrompt(SYSTEM_SECTION_IDS, sections, "|")).toBe("  role @WORKSPACE_NAMES@  |# @XML_TOOLS_SECTION@")
	})

	it("assembles tool content after env preparation without leaving structural slots", () => {
		const config = createSystemPromptConfig(BASE_CONTEXT)
		const section = prepareToolUseSection(config, "unused native section", "XML @WORKSPACE_PATH_RULE@ TOOLS")

		expect(section).toContain("XML @WORKSPACE_PATH_RULE@ TOOLS")
		expect(section).toContain("@PARALLEL_TOOL_POLICY@")
		expect(section).toContain("<task_progress>")
		expect(section).not.toMatch(/@(TOOL_USE_[A-Z_]+|TOOLS_SECTION|FOCUS_[A-Z_]+|XML_TOOLS_SECTION|SUBAGENTS_GUIDANCE)@/)
	})

	it("expands only declared structural slots and preserves nested runtime tokens unresolved", () => {
		expect(
			assemblePromptFragments("before @STRUCTURE@ @RUNTIME@ after", {
				STRUCTURE: "fragment @RUNTIME@ @NESTED_STRUCTURE@",
				NESTED_STRUCTURE: "must-not-expand",
			}),
		).toBe("before fragment @RUNTIME@ @NESTED_STRUCTURE@ @RUNTIME@ after")
	})

	it("rejects env keys outside the static complete-template contract", () => {
		expect(() =>
			assembleSystemPrompt(["agent-role"], new Map([["agent-role", "@WORKSPACE_NAMES@"]]), "|", {
				WORKSPACE_NAMES: "\n- project",
				RUNTIME_ONLY_SURPRISE: "not contracted",
			}),
		).toThrowError(/undeclared-key/)
	})

	it("performs one global non-recursive replacement after complete assembly", () => {
		const renderSpy = vi.spyOn(PromptScanner.prototype, "render")
		const output = assembleSystemPrompt(
			["agent-role", "tool-use"],
			new Map([
				["agent-role", "@WORKSPACE_NAMES@"],
				["tool-use", "@CUSTOM_INSTRUCTIONS@"],
			]),
			"|",
			{
				WORKSPACE_NAMES: "\n- project",
				CUSTOM_INSTRUCTIONS: "literal @WORKSPACE_NAMES@",
			},
		)

		expect(output.text).toBe("\n- project|# literal @WORKSPACE_NAMES@")
		expect(output.warnings).toEqual([])
		expect(renderSpy).toHaveBeenCalledTimes(1)
	})
})
