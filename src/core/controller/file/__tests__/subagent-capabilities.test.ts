import { BinaryReader } from "@bufbuild/protobuf/wire"
import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import * as disk from "@core/storage/disk"
import { parseAgentConfigFromYaml } from "@core/task/tools/subagent/AgentConfigLoader"
import {
    GetSubagentCapabilitiesRequest,
    RefreshedSubagents,
    SubagentCapabilitiesResponse,
    SubagentCapabilityInfo,
    SubagentInfo,
    SubagentMcpResourceInfo,
    SubagentMcpSelection,
    SubagentMcpServerInfo,
    SubagentMcpToolInfo,
    SubagentRuleSelection,
    UpdateSubagentConfigRequest,
} from "@shared/proto/dline/file"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import { refreshSubagents } from "../refreshSubagents"
import { patchSubagentConfigDocument } from "../subagent-config-document"
import { updateSubagentConfig } from "../updateSubagentConfig"

function parseDocument(content: string) {
    const parsed = parseYamlFrontmatter(content)
    expect(parsed.hadFrontmatter).toBe(true)
    expect(parsed.parseError).toBeUndefined()
    return parsed
}

/** Inspect wire tags independently of the generated DTO decoder. */
function fieldNumbers(bytes: Uint8Array): number[] {
    const reader = new BinaryReader(bytes)
    const fields: number[] = []
    while (reader.pos < reader.len) {
        const tag = reader.uint32()
        fields.push(tag >>> 3)
        reader.skip(tag & 7)
    }
    return fields
}

const rule = { scope: "workspace", path: "review-policy.md" }
const mcp = { server: "github", tools: ["search_issues"], resources: ["repository://instructions"] }

// These use generated codecs intentionally: regenerate ProtoBus before executing.
// There are no hand-written test projections standing in for generated contracts.
describe("subagent capability protobuf contracts", () => {
    it("retains legacy tags and carries independent replacement intent and scoped selections", () => {
        const request = UpdateSubagentConfigRequest.create({
            subagentPath: "/workspace/reviewer.yml",
            tools: ["read_file"],
            skills: ["use-vitest"],
            description: "Review selected code",
            profile: "review-profile",
            replaceTools: true,
            replaceSkills: true,
            rules: [rule],
            workflows: ["e2e-validation"],
            mcp: [mcp],
            replaceRules: true,
            replaceWorkflows: true,
            replaceMcp: true,
        })
        const bytes = UpdateSubagentConfigRequest.encode(request).finish()
        expect(fieldNumbers(bytes)).toEqual([1, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15])
        expect(UpdateSubagentConfigRequest.decode(bytes)).toEqual(request)

        const info = SubagentInfo.create({
            name: "reviewer",
            description: "Review selected code",
            path: "/workspace/reviewer.yml",
            enabled: true,
            tools: ["read_file"],
            skills: ["use-vitest"],
            profile: "review-profile",
            rules: [rule],
            workflows: ["e2e-validation"],
            mcp: [mcp],
        })
        const infoBytes = SubagentInfo.encode(info).finish()
        expect(fieldNumbers(infoBytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 9, 10, 11])
        expect(SubagentInfo.decode(infoBytes)).toEqual(info)
        expect(fieldNumbers(SubagentRuleSelection.encode(rule).finish())).toEqual([1, 2])
        expect(fieldNumbers(SubagentMcpSelection.encode(mcp).finish())).toEqual([1, 2, 3])
    })

    it("distinguishes omitted repeated fields from explicit clearing after protobuf decoding", () => {
        const preserve = UpdateSubagentConfigRequest.decode(
            UpdateSubagentConfigRequest.encode(
                UpdateSubagentConfigRequest.create({ subagentPath: "reviewer.yml", profile: "" }),
            ).finish(),
        )
        expect(preserve.profile).toBe("")
        expect(preserve.skills).toEqual([])
        expect(preserve.rules).toEqual([])
        expect(preserve.workflows).toEqual([])
        expect(preserve.mcp).toEqual([])
        expect([preserve.replaceSkills, preserve.replaceRules, preserve.replaceWorkflows, preserve.replaceMcp]).toEqual([
            false,
            false,
            false,
            false,
        ])

        const clear = UpdateSubagentConfigRequest.create({
            subagentPath: "reviewer.yml",
            replaceSkills: true,
            replaceRules: true,
            replaceWorkflows: true,
            replaceMcp: true,
        })
        const bytes = UpdateSubagentConfigRequest.encode(clear).finish()
        expect(fieldNumbers(bytes)).toEqual([1, 8, 13, 14, 15])
        expect(UpdateSubagentConfigRequest.decode(bytes)).toEqual(clear)
    })

    it("round-trips candidate identities, required status and unavailability without conflating MCP names", () => {
        const request = GetSubagentCapabilitiesRequest.create({ subagentPath: "reviewer.yml" })
        expect(fieldNumbers(GetSubagentCapabilitiesRequest.encode(request).finish())).toEqual([1])
        expect(GetSubagentCapabilitiesRequest.decode(GetSubagentCapabilitiesRequest.encode(request).finish())).toEqual(request)

        const capability = SubagentCapabilityInfo.create({
            name: "review-policy",
            description: "Selected rule metadata",
            scope: "workspace",
            path: "review-policy.md",
            required: true,
            available: true,
            unavailableReason: "retained diagnostic",
        })
        expect(fieldNumbers(SubagentCapabilityInfo.encode(capability).finish())).toEqual([1, 2, 3, 4, 5, 6, 7])
        const tool = SubagentMcpToolInfo.create({ name: "search_issues", description: "Search issues" })
        const resource = SubagentMcpResourceInfo.create({
            uri: "repository://instructions",
            name: "Instructions",
            description: "Repository policy",
        })
        const server = SubagentMcpServerInfo.create({
            name: "workspace-owner:github",
            displayName: "GitHub",
            available: true,
            tools: [tool],
            resources: [resource],
            unavailableReason: "retained diagnostic",
        })
        expect(fieldNumbers(SubagentMcpToolInfo.encode(tool).finish())).toEqual([1, 2])
        expect(fieldNumbers(SubagentMcpResourceInfo.encode(resource).finish())).toEqual([1, 2, 3])
        expect(fieldNumbers(SubagentMcpServerInfo.encode(server).finish())).toEqual([1, 2, 3, 4, 5, 6])
        const response = SubagentCapabilitiesResponse.create({
            rules: [capability],
            skills: [
                {
                    name: "missing-skill",
                    scope: "workspace",
                    path: "skills/missing-skill",
                    available: false,
                    unavailableReason: "missing",
                },
            ],
            workflows: [
                { name: "review", description: "Review changes", scope: "global", path: "workflows/review.md", available: true },
            ],
            mcp: [
                server,
                { name: "other-owner:github", displayName: "GitHub", available: false, unavailableReason: "disconnected" },
            ],
        })
        const bytes = SubagentCapabilitiesResponse.encode(response).finish()
        expect(fieldNumbers(bytes)).toEqual([1, 2, 3, 4, 4])
        const decoded = SubagentCapabilitiesResponse.decode(bytes)
        expect(decoded).toEqual(response)
        expect(decoded.skills[0].available).toBe(false)
        expect(decoded.skills[0].unavailableReason).toBe("missing")
        expect(decoded.mcp.map((entry) => entry.name)).toEqual(["workspace-owner:github", "other-owner:github"])
    })
})

describe("subagent configuration document patching", () => {
    it("replaces a final block list without retaining stale items or swallowing the adjacent list", () => {
        const source =
            "---\nname: reviewer\ndescription: Review changes\ntools:\n  - read_file\nskills:\n  - old-skill\n  - another-old-skill\n---\nPrompt body\n"
        const updated = patchSubagentConfigDocument(source, { skills: ["use-vitest"] })
        const parsed = parseDocument(updated)
        expect(parsed.data.tools).toEqual(["read_file"])
        expect(parsed.data.skills).toEqual(["use-vitest"])
        expect(parsed.body).toBe("Prompt body\n")
        expect(parseAgentConfigFromYaml(updated).skills).toEqual(["use-vitest"])
    })

    it("retains comments, blank lines, unknown nested fields, neighboring lists and exact prompt bytes", () => {
        const unknown =
            '"x-extra":\n  nested:\n    skills:\n      - never-touch\n    tools: [write_to_file]\n  literal: |-\n    # literal data, not a comment\n    skills: literal value\n'
        const body = "\nCustom instructions.\n---\nskills: body text\n\n"
        const source =
            "---\n# Author-owned configuration\nname: reviewer\ndescription: Review changes\ntools:\n  - read_file # tool comment\n\nskills: [old-skill] # selection comment\n# Comment belonging to the next field\n\n" +
            unknown +
            "workflows:\n- review-workflow\n# End note\n\n---\n" +
            body
        const updated = patchSubagentConfigDocument(source, { skills: ["use-vitest"] })
        const parsed = parseDocument(updated)
        expect(parsed.data.skills).toEqual(["use-vitest"])
        expect(parsed.data.tools).toEqual(["read_file"])
        expect(parsed.data.workflows).toEqual(["review-workflow"])
        expect(parsed.data["x-extra"]).toEqual({
            nested: { skills: ["never-touch"], tools: ["write_to_file"] },
            literal: "# literal data, not a comment\nskills: literal value",
        })
        expect(updated).toContain(unknown)
        expect(updated).toContain("tools:\n  - read_file # tool comment\n\n")
        expect(updated).toContain("# selection comment\n# Comment belonging to the next field\n\n")
        expect(updated).toContain("workflows:\n- review-workflow\n# End note\n\n")
        expect(parsed.body).toBe(body)
    })

    it("targets a quoted mapping key rather than similarly named text inside a scalar", () => {
        const source =
            "---\nname: reviewer\ndescription: |- # keep this comment\n  Review: --- is not a delimiter\n  skills: not a key\n  # old scalar data\n'skills': [old-skill] # keep selection note\ncustom:\n  skills: [untouched]\n---\nPrompt body\n"
        const updated = patchSubagentConfigDocument(source, {
            description: "Review #1: selected code",
            skills: ["skill #1", "skill: two"],
        })
        const parsed = parseDocument(updated)
        expect(parsed.data.description).toBe("Review #1: selected code")
        expect(parsed.data.skills).toEqual(["skill #1", "skill: two"])
        expect(parsed.data.custom).toEqual({ skills: ["untouched"] })
        expect(updated).toContain("# keep this comment")
        expect(updated).toContain("# keep selection note")
        expect(updated).not.toContain("# old scalar data")
        expect(parsed.body).toBe("Prompt body\n")
    })

    it("does not turn retained indented comments into a replacement block scalar's content", () => {
        const source =
            "---\nname: reviewer\ndescription: \"Old\n  description\" # keep suffix note\nskills:\n  - 'old # scalar value' # keep item note\n---\nPrompt body\n"
        const updated = patchSubagentConfigDocument(source, {
            description: "New\nmultiline description",
            skills: ["use-vitest"],
        })
        const parsed = parseDocument(updated)
        expect(parsed.data.description).toBe("New\nmultiline description")
        expect(parsed.data.skills).toEqual(["use-vitest"])
        expect(updated).toContain("# keep suffix note")
        expect(updated).toContain("# keep item note")
        expect(updated).not.toContain("# scalar value")
    })

    it("keeps comments on scalar node properties while discarding the replaced scalar data", () => {
        const source =
            "---\nname: reviewer\ndescription: &old |- # keep header note\n  Old # scalar text\nskills:\n  - &old-skill # keep anchor note\n    old-skill\n---\nPrompt body\n"
        expect(parseDocument(source).data.skills).toEqual(["old-skill"])
        const updated = patchSubagentConfigDocument(source, { description: "New description", skills: ["use-vitest"] })
        const parsed = parseDocument(updated)
        expect(parsed.data.description).toBe("New description")
        expect(parsed.data.skills).toEqual(["use-vitest"])
        expect(updated).toContain("# keep header note")
        expect(updated).toContain("# keep anchor note")
        expect(updated).not.toContain("# scalar text")
    })

    it("distinguishes a flow collection's trailing comment from a hash inside an anchor or selected value", () => {
        const source =
            "---\nname: reviewer\ndescription: Review changes\nskills: &selected#old [old-skill]# keep flow note\n---\nPrompt body\n"
        expect(parseDocument(source).data.skills).toEqual(["old-skill"])
        const updated = patchSubagentConfigDocument(source, { skills: ["new#selected"] })
        expect(parseDocument(updated).data.skills).toEqual(["new#selected"])
        expect(updated).toContain("# keep flow note")
        expect(updated).not.toContain("#old")
    })

    it.each([
        ["flow", "skills: [old-skill, another-skill]"],
        ["comma", "skills: old-skill, another-skill"],
        ["block", "skills:\n  - old-skill\n  - another-skill"],
    ])("replaces and clears a historical %s list using real YAML semantics", (_shape, field) => {
        const source = `---\nname: reviewer\ndescription: Review changes\n${field}\n---\nPrompt body\n`
        const replaced = patchSubagentConfigDocument(source, { skills: ["use-vitest", "using-shared-network"] })
        expect(parseDocument(replaced).data.skills).toEqual(["use-vitest", "using-shared-network"])
        expect(replaced).toContain("skills:\n  - use-vitest\n  - using-shared-network\n")
        const cleared = patchSubagentConfigDocument(replaced, { skills: [] })
        expect(parseDocument(cleared).data).not.toHaveProperty("skills")
        expect(parseAgentConfigFromYaml(cleared).skills).toEqual([])
    })

    it("omits empty capability fields and empty MCP descendants without changing the Tools empty-list policy", () => {
        const source =
            "---\nname: reviewer\ndescription: Review changes\ntools: []\nrules: []\nskills: []\nworkflows: []\nmcp: []\n---\nPrompt body\n"
        const selected = patchSubagentConfigDocument(source, {
            rules: [rule],
            skills: ["use-vitest"],
            workflows: ["review-workflow"],
            mcp: [
                { server: "empty", tools: [], resources: [] },
                { server: "tools-only", tools: ["search_issues"], resources: [] },
                { server: "resources-only", tools: [], resources: ["repository://instructions#exact"] },
                { server: "omitted-lists" },
                { server: "", tools: [], resources: [] },
            ],
        })
        expect(parseDocument(selected).data).toMatchObject({
            tools: [],
            rules: [rule],
            skills: ["use-vitest"],
            workflows: ["review-workflow"],
            mcp: [
                { server: "tools-only", tools: ["search_issues"] },
                { server: "resources-only", resources: ["repository://instructions#exact"] },
            ],
        })
        const cleared = patchSubagentConfigDocument(selected, { rules: [], skills: [], workflows: [], mcp: [] })
        expect(parseDocument(cleared).data).toEqual({ name: "reviewer", description: "Review changes", tools: [] })
        const emptyServers = patchSubagentConfigDocument(selected, { mcp: [{ server: "empty", tools: [], resources: [] }] })
        expect(parseDocument(emptyServers).data).not.toHaveProperty("mcp")
        expect(parseDocument(emptyServers).data.skills).toEqual(["use-vitest"])
    })

    it("leaves unpatched legacy empty fields untouched instead of bulk-normalizing a user file", () => {
        const source =
            "---\nname: reviewer\ndescription: Review changes\nskills: [] # legacy value\nrules: []\nworkflows: []\nmcp: []\n---\nPrompt body\n"
        const updated = patchSubagentConfigDocument(source, { profile: "review-profile" })
        expect(updated).toContain("skills: [] # legacy value\nrules: []\nworkflows: []\nmcp: []\n")
        expect(parseDocument(updated).data.profile).toBe("review-profile")
        const config = parseAgentConfigFromYaml(updated)
        expect([config.rules, config.skills, config.workflows, config.mcp]).toEqual([[], [], [], []])
    })

    it("preserves CRLF, blank lines, inline comments and the prompt suffix when clearing a field", () => {
        const suffix = "---\r\n\r\nPrompt body\r\n---\r\n# body text\r\n"
        const source =
            "---\r\nname: reviewer\r\ndescription: Review changes\r\nskills: [old-skill] # keep note\r\n\r\ncustom:\r\n  nested: true\r\n\r\n" +
            suffix
        const updated = patchSubagentConfigDocument(source, { skills: [] })
        expect(updated.endsWith(suffix)).toBe(true)
        expect(updated).toContain("# keep note\r\n\r\ncustom:\r\n  nested: true\r\n\r\n")
        expect(updated.replace(/\r\n/g, "")).not.toContain("\n")
        expect(parseDocument(updated).data).toEqual({ name: "reviewer", description: "Review changes", custom: { nested: true } })
    })

    it("rejects malformed YAML, duplicate keys and removal of an anchor required by an untouched field", () => {
        expect(() => patchSubagentConfigDocument("---\nname: [unterminated\n---\nPrompt\n", { skills: [] })).toThrow()
        expect(() => patchSubagentConfigDocument("---\nname: reviewer\nname: duplicate\n---\nPrompt\n", { skills: [] })).toThrow()
        const source =
            "---\nname: reviewer\ndescription: Review changes\nskills: &selected [use-vitest]\ncustom: *selected\n---\nPrompt body\n"
        expect(parseDocument(source).data.custom).toEqual(["use-vitest"])
        expect(() => patchSubagentConfigDocument(source, { skills: [] })).toThrow()
    })

    it("sanitizes legacy comma Tools on an unrelated save while retaining neighboring capabilities", () => {
        const source =
            "---\nname: reviewer\ndescription: Review changes\ntools: read_file, make_plan, attempt_completion, not_a_tool\nskills:\n  - use-vitest\nworkflows:\n  - review-workflow\n---\nPrompt body\n"
        const updated = patchSubagentConfigDocument(source, { profile: "review-profile" })
        expect(parseDocument(updated).data.tools).toEqual(["read_file"])
        expect(parseAgentConfigFromYaml(updated).skills).toEqual(["use-vitest"])
        expect(parseDocument(updated).data.workflows).toEqual(["review-workflow"])
    })

    it.each([
        ["../outside.md"],
        ["nested/../../outside.md"],
        ["nested\\..\\..\\outside.md"],
        ["/etc/policy.md"],
        ["C:\\rules\\policy.md"],
        ["C:policy.md"],
        ["\\\\server\\share\\policy.md"],
        ["\\rules\\policy.md"],
        ["file:///tmp/policy.md"],
        ["."],
        ["./"],
        [".//"],
        ["././"],
        [".\\"],
        ["nested/.."],
        ["nested/../"],
        ["nested\\..\\"],
        ["nested/child/../../"],
        [".."],
    ])("rejects a %s rule path the loader would refuse to read back", (rulePath) => {
        const source = "---\nname: reviewer\ndescription: Review changes\n---\nPrompt body\n"
        expect(() => patchSubagentConfigDocument(source, { rules: [{ scope: "workspace", path: rulePath }] })).toThrow(
            /Rule path must be relative and stay within its rule root/,
        )
    })

    it("rejects empty, blank and null-containing rule paths the loader would refuse to read back", () => {
        const source = "---\nname: reviewer\ndescription: Review changes\n---\nPrompt body\n"
        expect(() => patchSubagentConfigDocument(source, { rules: [{ scope: "workspace", path: "" }] })).toThrow(
            /at least 1 character/,
        )
        expect(() => patchSubagentConfigDocument(source, { rules: [{ scope: "workspace", path: "   " }] })).toThrow(
            /at least 1 character/,
        )
        expect(() => patchSubagentConfigDocument(source, { rules: [{ scope: "workspace", path: "policy\0.md" }] })).toThrow(
            /null character/,
        )
    })

    it("rejects rule scopes the loader would refuse to read back", () => {
        const source = "---\nname: reviewer\ndescription: Review changes\n---\nPrompt body\n"
        for (const scope of ["project", "GLOBAL", ""]) {
            expect(() => patchSubagentConfigDocument(source, { rules: [{ scope, path: "policy.md" }] })).toThrow(
                /Invalid enum value/,
            )
        }
    })

    it("normalizes and deduplicates rule selections exactly as the loader reads them, leaving remote names untouched", () => {
        const source = "---\nname: reviewer\ndescription: Review changes\n---\nPrompt body\n"
        const updated = patchSubagentConfigDocument(source, {
            rules: [
                { scope: "workspace", path: " ./guides/review.md " },
                { scope: "workspace", path: "guides\\review.md" },
                { scope: "workspace", path: "guides//review.md" },
                { scope: "workspace", path: "guides/draft/../review.md" },
                { scope: "global", path: "guides/review.md" },
                { scope: "remote", path: "Team Policy: Security / v1" },
                { scope: "remote", path: "Team Policy: Security / v1" },
            ],
        })
        const expected = [
            { scope: "workspace", path: "guides/review.md" },
            { scope: "global", path: "guides/review.md" },
            { scope: "remote", path: "Team Policy: Security / v1" },
        ]
        expect(parseDocument(updated).data.rules).toEqual(expected)
        expect(parseAgentConfigFromYaml(updated).rules).toEqual(expected)
    })
})

describe("protobuf → YAML → refresh capability projection", () => {
    let directory: string
    let subagentPath: string

    beforeEach(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-capabilities-"))
        subagentPath = path.join(directory, "reviewer.yml")
        vi.spyOn(HostProvider, "workspace", "get").mockReturnValue({
            getWorkspacePaths: vi.fn().mockResolvedValue({ paths: [directory] }),
        } as never)
        vi.spyOn(disk, "getSubagentsScanDirectories").mockReturnValue([{ path: directory, source: "project" }])
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await fs.rm(directory, { recursive: true, force: true })
    })

    function controller() {
        return {
            stateManager: {
                getScopedCapabilityToggles: () => ({}),
                mutateScopedCapabilityToggles: vi.fn(),
            },
            postStateToWebview: vi.fn().mockResolvedValue(undefined),
        } as never
    }

    async function save(request: UpdateSubagentConfigRequest) {
        const decoded = UpdateSubagentConfigRequest.decode(UpdateSubagentConfigRequest.encode(request).finish())
        await updateSubagentConfig(controller(), decoded)
        return parseDocument(await fs.readFile(subagentPath, "utf8"))
    }

    async function refresh() {
        const response = await refreshSubagents(controller())
        const decoded = RefreshedSubagents.decode(RefreshedSubagents.encode(response).finish())
        expect(decoded.globalSubagents).toEqual([])
        expect(decoded.localSubagents).toHaveLength(1)
        return decoded.localSubagents[0]
    }

    it("persists block selections, preserves them without replacement, and reopens cleared capabilities as unselected", async () => {
        const source =
            "---\nname: reviewer\ndescription: Review changes\ntools:\n  - read_file\nskills: old-skill, another-skill\ncustom:\n  nested: [one, two]\n# Keep end note\n---\nPrompt body\n"
        await fs.writeFile(subagentPath, source, "utf8")
        const selected = await save(
            UpdateSubagentConfigRequest.create({
                subagentPath,
                rules: [rule],
                skills: ["use-vitest"],
                workflows: ["review-workflow"],
                mcp: [mcp, { server: "empty", tools: [], resources: [] }],
                replaceRules: true,
                replaceSkills: true,
                replaceWorkflows: true,
                replaceMcp: true,
            }),
        )
        expect(selected.data).toMatchObject({ rules: [rule], skills: ["use-vitest"], workflows: ["review-workflow"], mcp: [mcp] })
        expect(selected.data.custom).toEqual({ nested: ["one", "two"] })
        expect(selected.body).toBe("Prompt body\n")
        const text = await fs.readFile(subagentPath, "utf8")
        expect(text).toContain("rules:\n  - scope: workspace\n    path: review-policy.md\n")
        expect(text).toContain("skills:\n  - use-vitest\n")
        expect(text).toContain("workflows:\n  - review-workflow\n")
        expect(text).toContain(
            "mcp:\n  - server: github\n    tools:\n      - search_issues\n    resources:\n      - repository://instructions\n",
        )
        expect(await refresh()).toMatchObject({
            rules: [rule],
            skills: ["use-vitest"],
            workflows: ["review-workflow"],
            mcp: [mcp],
        })

        // Even a nonempty list payload is not intent without its replacement flag.
        await save(
            UpdateSubagentConfigRequest.create({
                subagentPath,
                profile: "review-profile",
                skills: ["ignored-skill"],
                rules: [{ scope: "global", path: "ignored-rule.md" }],
                workflows: ["ignored-workflow"],
                mcp: [{ server: "ignored", tools: ["ignored-tool"], resources: [] }],
            }),
        )
        expect(await refresh()).toMatchObject({
            profile: "review-profile",
            rules: [rule],
            skills: ["use-vitest"],
            workflows: ["review-workflow"],
            mcp: [mcp],
        })

        const cleared = await save(
            UpdateSubagentConfigRequest.create({
                subagentPath,
                replaceRules: true,
                replaceSkills: true,
                replaceWorkflows: true,
                replaceMcp: true,
            }),
        )
        for (const field of ["rules", "skills", "workflows", "mcp"]) expect(cleared.data).not.toHaveProperty(field)
        expect(cleared.data.tools).toEqual(["read_file"])
        expect(cleared.data.custom).toEqual({ nested: ["one", "two"] })
        expect(cleared.body).toBe("Prompt body\n")
        const config = parseAgentConfigFromYaml(await fs.readFile(subagentPath, "utf8"))
        expect([config.rules, config.skills, config.workflows, config.mcp]).toEqual([[], [], [], []])
        expect(await refresh()).toMatchObject({ rules: [], skills: [], workflows: [], mcp: [], profile: "review-profile" })
    })

    it("projects omitted historical MCP descendants as empty lists without writing them back to YAML", async () => {
        const source =
            "---\nname: reviewer\ndescription: Review changes\nrules:\n  - scope: global\n    path: policy.md\n  - scope: remote\n    path: enterprise-policy\nskills: [use-vitest]\nworkflows: review-workflow, second-workflow\nmcp:\n  - server: tools-only\n    tools: [search_issues]\n  - server: resources-only\n    resources: [repository://instructions]\n---\nPrompt body\n"
        await fs.writeFile(subagentPath, source, "utf8")
        expect(await refresh()).toMatchObject({
            rules: [
                { scope: "global", path: "policy.md" },
                { scope: "remote", path: "enterprise-policy" },
            ],
            skills: ["use-vitest"],
            workflows: ["review-workflow", "second-workflow"],
            mcp: [
                { server: "tools-only", tools: ["search_issues"], resources: [] },
                { server: "resources-only", tools: [], resources: ["repository://instructions"] },
            ],
        })
        expect(await fs.readFile(subagentPath, "utf8")).toBe(source)
    })

    it("rejects a rule path the loader would refuse to read back without touching the YAML or reporting success", async () => {
        const original = "---\nname: reviewer\ndescription: Review changes\nskills:\n  - use-vitest\n---\nPrompt body\n"
        await fs.writeFile(subagentPath, original, "utf8")
        const postStateToWebview = vi.fn().mockResolvedValue(undefined)
        // The failure happens before any state push, so the fake supplies only
        // the members this handler can reach on that path.
        const failure = await updateSubagentConfig(
            { postStateToWebview } as never,
            UpdateSubagentConfigRequest.create({
                subagentPath,
                rules: [{ scope: "workspace", path: "../outside.md" }],
                replaceRules: true,
            }),
        ).then(
            () => undefined,
            (error: unknown) => error,
        )
        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toBe(`Failed to update subagent config: ${subagentPath}`)
        expect(String((failure as Error).cause)).toContain("Rule path must be relative and stay within its rule root")
        expect(await fs.readFile(subagentPath, "utf8")).toBe(original)
        expect(postStateToWebview).not.toHaveBeenCalled()
    })

    it("persists normalized rule paths so the saved YAML re-reads identically", async () => {
        await fs.writeFile(subagentPath, "---\nname: reviewer\ndescription: Review changes\n---\nPrompt body\n", "utf8")
        const saved = await save(
            UpdateSubagentConfigRequest.create({
                subagentPath,
                rules: [
                    { scope: "workspace", path: " ./guides/review.md " },
                    { scope: "workspace", path: "guides\\review.md" },
                    { scope: "remote", path: "Team Policy: Security / v1" },
                ],
                replaceRules: true,
            }),
        )
        const expected = [
            { scope: "workspace", path: "guides/review.md" },
            { scope: "remote", path: "Team Policy: Security / v1" },
        ]
        expect(saved.data.rules).toEqual(expected)
        expect(parseAgentConfigFromYaml(await fs.readFile(subagentPath, "utf8")).rules).toEqual(expected)
        expect(await refresh()).toMatchObject({ rules: expected })
    })
})
