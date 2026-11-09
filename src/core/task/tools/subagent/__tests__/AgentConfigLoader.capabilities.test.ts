import { strict as assert } from "node:assert"
import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import { createSubagentFile } from "@core/controller/file/createSubagentFile"
import { CreateSubagentRequest } from "@shared/proto/dline/file"
import fs from "fs/promises"
import os from "os"
import * as path from "path"
import { afterEach, describe, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import { DlineDefaultTool } from "@/shared/tools"
import {
    type AgentBaseConfig,
    AgentConfigLoader,
    type AgentMcpSelection,
    type AgentRuleSelection,
    parseAgentConfigFromYaml,
} from "../AgentConfigLoader"

vi.mock("@core/controller/file/openFile", () => ({
    openFile: vi.fn().mockResolvedValue(undefined),
}))

const capabilityFields = ["rules", "skills", "workflows", "mcp"] as const

function parseCapabilities(frontmatter = ""): AgentBaseConfig {
    return parseAgentConfigFromYaml(`---
name: capability-agent
description: Uses independently selected capabilities
${frontmatter}
---
Prompt body`)
}

function assertEmptyCapabilities(config: AgentBaseConfig): void {
    for (const field of capabilityFields) {
        assert.deepEqual(config[field], [], `${field} must select nothing`)
    }
}

describe("AgentConfigLoader capability selections", () => {
    const temporaryDirectories: string[] = []

    afterEach(async () => {
        await AgentConfigLoader.resetInstanceForTests()
        vi.restoreAllMocks()
        await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
    })

    it("normalizes omitted capabilities to empty selections without changing the tools default", () => {
        const config = parseCapabilities()

        assertEmptyCapabilities(config)
        assert.deepEqual(config.tools, [])
        assert.equal(config.toolsExplicitlyNarrowed, undefined)
        assert.equal(config.profile, undefined)
        assert.equal(config.maxOutputTokens, undefined)
        assert.equal(config.systemPrompt, "Prompt body")
    })

    it("normalizes legacy empty capability arrays without marking empty tools as explicitly narrowed", () => {
        const config = parseCapabilities(`tools: []
rules: []
skills: []
workflows: []
mcp: []`)

        assertEmptyCapabilities(config)
        assert.deepEqual(config.tools, [])
        assert.equal(config.toolsExplicitlyNarrowed, undefined)
    })

    it("parses the non-empty block selection shape alongside tools, profile and output budget", () => {
        const config = parseCapabilities(`tools:
  - read_file
  - load_skill
profile: review-profile
maxOutputTokens: "0.05"
rules:
  - scope: workspace
    path: engineering-guide.md
  - scope: global
    path: review-policy.md
  - scope: remote
    path: Team Review Policy
skills:
  - use-vitest
  - using-shared-network
workflows:
  - e2e-validation
mcp:
  - server: github
    tools:
      - search_issues
    resources:
      - repository://instructions`)

        const rules: AgentRuleSelection[] = [
            { scope: "workspace", path: "engineering-guide.md" },
            { scope: "global", path: "review-policy.md" },
            { scope: "remote", path: "Team Review Policy" },
        ]
        const mcp: AgentMcpSelection[] = [
            { server: "github", tools: ["search_issues"], resources: ["repository://instructions"] },
        ]
        assert.deepEqual(config.rules, rules)
        assert.deepEqual(config.skills, ["use-vitest", "using-shared-network"])
        assert.deepEqual(config.workflows, ["e2e-validation"])
        assert.deepEqual(config.mcp, mcp)
        assert.deepEqual(config.tools, [DlineDefaultTool.FILE_READ, DlineDefaultTool.LOAD_SKILL])
        assert.equal(config.profile, "review-profile")
        assert.equal(config.maxOutputTokens, 0.05)
        assert.equal(config.systemPrompt, "Prompt body")
    })

    it.each([
        ["comma", " alpha, beta, alpha "],
        ["flow", '[" alpha ", beta, alpha]'],
        ["block", '\n  - " alpha "\n  - beta\n  - alpha'],
    ])("reads and deduplicates non-empty %s skills and workflows", (_format, value) => {
        const config = parseCapabilities(`skills: ${value}\nworkflows: ${value}`)

        assert.deepEqual(config.skills, ["alpha", "beta"])
        assert.deepEqual(config.workflows, ["alpha", "beta"])
        assert.deepEqual(config.rules, [])
        assert.deepEqual(config.mcp, [])
    })

    it("preserves case and literal commas inside array names", () => {
        const config = parseCapabilities(`skills: [alpha, Alpha, "alpha,beta", alpha]
workflows: [review, Review, "review,deploy", review]`)

        assert.deepEqual(config.skills, ["alpha", "Alpha", "alpha,beta"])
        assert.deepEqual(config.workflows, ["review", "Review", "review,deploy"])
    })

    it.each(["skills", "workflows"])("rejects empty names and malformed %s rather than selecting all", (field) => {
        const invalidValues = [
            '""',
            '"   "',
            '",alpha"',
            '"alpha,"',
            '"alpha,,beta"',
            '[""]',
            '[alpha, " "]',
            "[alpha, null]",
            "[42]",
            "[true]",
            "null",
            "42",
            "{name: alpha}",
        ]
        for (const value of invalidValues) {
            assert.throws(() => parseCapabilities(`${field}: ${value}`), /skills|workflows|name cannot be empty/, value)
        }
    })

    it("deduplicates rules by scope and normalized root-relative path without rewriting remote names", () => {
        const config = parseCapabilities(`rules:
  - scope: workspace
    path: " ./guides/review.md "
  - scope: workspace
    path: ${JSON.stringify("guides\\review.md")}
  - scope: workspace
    path: guides//review.md
  - scope: workspace
    path: guides/draft/../review.md
  - scope: global
    path: guides/review.md
  - scope: remote
    path: "Team Policy: Security / v1"
  - scope: remote
    path: "Team Policy: Security / v1"
  - scope: remote
    path: "team Policy: Security / v1"`)

        assert.deepEqual(config.rules, [
            { scope: "workspace", path: "guides/review.md" },
            { scope: "global", path: "guides/review.md" },
            { scope: "remote", path: "Team Policy: Security / v1" },
            { scope: "remote", path: "team Policy: Security / v1" },
        ])
    })

    it("accepts flow-form rule and MCP lists without interpreting comma-containing MCP identities", () => {
        const config = parseCapabilities(`rules: [{scope: workspace, path: nested/policy.md}]
mcp: [{server: "server,one", tools: ["tool,one"], resources: ["repo://one?a=b,c"]}]`)

        assert.deepEqual(config.rules, [{ scope: "workspace", path: "nested/policy.md" }])
        assert.deepEqual(config.mcp, [{ server: "server,one", tools: ["tool,one"], resources: ["repo://one?a=b,c"] }])
    })

    it.each(["global", "workspace"])("rejects root, absolute and escaping %s rule paths on every host", (scope) => {
        const invalidPaths = [
            "../outside.md",
            "nested/../../outside.md",
            "nested\\..\\..\\outside.md",
            "/etc/policy.md",
            "C:\\rules\\policy.md",
            "C:policy.md",
            "\\\\server\\share\\policy.md",
            "\\rules\\policy.md",
            "file:///tmp/policy.md",
            ".",
            "./",
            ".//",
            "././",
            ".\\",
            "nested/..",
            "nested/../",
            "nested\\..\\",
            "nested/child/../../",
            "..",
            "",
            "   ",
            "policy\0.md",
        ]
        for (const rulePath of invalidPaths) {
            assert.throws(
                () => parseCapabilities(`rules: [{scope: ${scope}, path: ${JSON.stringify(rulePath)}}]`),
                /rules/,
                rulePath,
            )
        }
    })

    it.each([
        "null",
        '"workspace:policy.md"',
        "{scope: workspace, path: policy.md}",
        "[null]",
        "[{scope: project, path: policy.md}]",
        "[{scope: GLOBAL, path: policy.md}]",
        "[{scope: 42, path: policy.md}]",
        "[{path: policy.md}]",
        "[{scope: workspace}]",
        "[{scope: workspace, path: null}]",
        "[{scope: workspace, path: 42}]",
        "[{scope: workspace, path: true}]",
        '[{scope: remote, path: " "}]',
    ])("rejects malformed rules: %s", (rules) => {
        assert.throws(() => parseCapabilities(`rules: ${rules}`), /rules/)
    })

    it("normalizes omitted or empty MCP child lists to empty exact selections", () => {
        const config = parseCapabilities(`mcp:
  - server: no-children
  - server: empty-children
    tools: []
    resources: []
  - server: tools-only
    tools:
      - inspect
  - server: resources-only
    resources:
      - repo://policy`)

        assert.deepEqual(config.mcp, [
            { server: "no-children", tools: [], resources: [] },
            { server: "empty-children", tools: [], resources: [] },
            { server: "tools-only", tools: ["inspect"], resources: [] },
            { server: "resources-only", tools: [], resources: ["repo://policy"] },
        ])
    })

    it("merges duplicate MCP servers and deduplicates child selections without alias or URI normalization", () => {
        const config = parseCapabilities(`mcp:
  - server: " github "
    tools: [" search_issues ", search_issues, Search_Issues]
    resources: [" repository://instructions ", repository://instructions]
  - server: github
    tools: [read_issue, search_issues]
    resources: [Repository://Instructions, "https://HOST/path/../policy?x=a,b"]
  - server: github
  - server: GitHub
    tools: [search_issues]`)

        assert.deepEqual(config.mcp, [
            {
                server: "github",
                tools: ["search_issues", "Search_Issues", "read_issue"],
                resources: ["repository://instructions", "Repository://Instructions", "https://HOST/path/../policy?x=a,b"],
            },
            { server: "GitHub", tools: ["search_issues"], resources: [] },
        ])
    })

    it.each([
        "null",
        '"github"',
        "{server: github}",
        "[null]",
        "[{}]",
        "[{server: 42}]",
        '[{server: ""}]',
        '[{server: " "}]',
        "[{server: github, tools: null}]",
        "[{server: github, tools: search_issues}]",
        "[{server: github, tools: [42]}]",
        '[{server: github, tools: [" "]}]',
        "[{server: github, resources: null}]",
        "[{server: github, resources: repo://policy}]",
        "[{server: github, resources: [null]}]",
        '[{server: github, resources: [""]}]',
    ])("rejects malformed MCP selections: %s", (mcp) => {
        assert.throws(() => parseCapabilities(`mcp: ${mcp}`), /mcp/)
    })

    it("creates a template with no active capability fields and parses it as unselected", async () => {
        const workspaceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-capability-template-"))
        temporaryDirectories.push(workspaceDirectory)
        vi.spyOn(HostProvider.workspace, "getWorkspacePaths").mockResolvedValue({ paths: [workspaceDirectory] })
        const controller = {
            stateManager: {
                getGlobalSettingsKey: vi.fn().mockReturnValue({}),
                getScopedCapabilityToggles: vi.fn().mockReturnValue({}),
            },
            postStateToWebview: vi.fn().mockResolvedValue(undefined),
        } as never

        await createSubagentFile(controller, CreateSubagentRequest.create({ subagentName: "reviewer", isGlobal: false }))

        const content = await fs.readFile(path.join(workspaceDirectory, ".agents", "subagents", "reviewer.yml"), "utf8")
        const config = parseAgentConfigFromYaml(content)
        const { data } = parseYamlFrontmatter(content)
        for (const field of capabilityFields) {
            assert.equal(Object.hasOwn(data, field), false, `${field} must be omitted, not an empty YAML field`)
        }
        assertEmptyCapabilities(config)
        assert.equal(config.name, "reviewer")
        assert.deepEqual(config.tools, [
            DlineDefaultTool.FILE_READ,
            DlineDefaultTool.SEARCH,
            DlineDefaultTool.LIST_FILES,
            DlineDefaultTool.LIST_CODE_DEF,
        ])
    })

    it("generates a README whose YAML example does not preselect capabilities", async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-capability-readme-"))
        temporaryDirectories.push(directory)
        await AgentConfigLoader.getInstance(directory).ready()

        const readme = await fs.readFile(path.join(directory, "README.md"), "utf8")
        const example = readme.match(/```yaml\r?\n([\s\S]*?)\r?\n```/)
        assert.ok(example, "README must provide a YAML example")
        const config = parseAgentConfigFromYaml(example[1])
        const { data } = parseYamlFrontmatter(example[1])
        for (const field of capabilityFields) {
            assert.equal(Object.hasOwn(data, field), false, `${field} must not be preselected by the README example`)
        }
        assertEmptyCapabilities(config)
    })
})
