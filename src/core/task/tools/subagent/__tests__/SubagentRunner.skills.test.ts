import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/config", () => import("./SubagentRunner.config.fixture"))

import * as skills from "@core/context/instructions/user-instructions/skills"
import type { GlobalInstructionsFile } from "@shared/remote-config/schema"
import { Logger } from "@/shared/services/Logger"
import { DlineDefaultTool } from "@/shared/tools"
import { ListFilesToolHandler } from "../../handlers/ListFilesToolHandler"
import type { AgentBaseConfig } from "../AgentConfigLoader"
import * as capabilitySelection from "../SubagentCapabilitySelection"
import { SubagentRunner } from "../SubagentRunner"
import {
    createTaskConfig,
    initializeHostProvider,
    stubApiHandler,
    stubSystemPrompt,
    useSubagentRunnerTestLifecycle,
} from "./SubagentRunner.fixtures"

function createRemoteSkillEntry(
    name: string,
    description: string,
    options: { alwaysEnabled?: boolean } = {},
): GlobalInstructionsFile {
    return {
        name,
        alwaysEnabled: options.alwaysEnabled ?? false,
        contents: `---\nname: ${name}\ndescription: ${description}\n---\nInstructions for ${name}.`,
    }
}

function skillAgent(selectedSkills?: string[]): AgentBaseConfig {
    return {
        name: "skill-agent",
        description: "Exercises the Runner skill catalog.",
        tools: [DlineDefaultTool.LOAD_SKILL, DlineDefaultTool.LIST_FILES, DlineDefaultTool.ATTEMPT],
        ...(selectedSkills === undefined ? {} : { skills: selectedSkills }),
        systemPrompt: "",
    }
}

describe("SubagentRunner skill catalog", () => {
    useSubagentRunnerTestLifecycle()
    let temp: string
    let cwd: string
    let docs: string

    async function skillFile(name: string, scope: "workspace" | "global" = "workspace"): Promise<string> {
        const root = scope === "workspace" ? path.join(cwd, ".agents", "skills") : path.join(docs, "skills")
        const directory = path.join(root, name)
        await fs.mkdir(directory, { recursive: true })
        const file = path.join(directory, "SKILL.md")
        await fs.writeFile(file, `---\nname: ${name}\ndescription: Instructions for ${name}\n---\nUse ${name}.`, "utf8")
        return file
    }

    beforeEach(async () => {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-runner-skills-"))
        cwd = path.join(temp, "workspace")
        docs = path.join(temp, "documents")
        await fs.mkdir(cwd, { recursive: true })
        await fs.mkdir(docs, { recursive: true })
        vi.stubEnv("DLINE_DOCS_DIR", docs)
    })

    afterEach(async () => {
        vi.unstubAllEnvs()
        await fs.rm(temp, { recursive: true, force: true })
    })

    it("filters available skills to configured skills when subagent skills are configured", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "tsf1",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(false, (context) => {
            assert.deepEqual(
                context.skills?.map((skill) => skill.name),
                ["allowed-skill"],
            )
        })
        stubApiHandler(createMessage)
        initializeHostProvider()
        const config = createTaskConfig(false, {
            remoteGlobalSkills: [createRemoteSkillEntry("allowed-skill", "A"), createRemoteSkillEntry("other-skill", "O")],
            remoteSkillsToggles: { "allowed-skill": false, "other-skill": true },
        })
        config.cwd = cwd
        const runner = new SubagentRunner(config, "skill-agent", skillAgent(["allowed-skill"]))
        const result = await runner.run("Run task", () => {})
        assert.equal(result.status, "completed", result.error)
        assert.equal(createMessage.mock.calls.length, 1)
        expect(config.capabilityToggles.remoteSkillsToggles).toEqual({ "allowed-skill": false, "other-skill": true })
    })

    // The old request-frozen parent-toggle regression now belongs to the child run:
    // parent preferences are not authority, and later edits must not change this run.
    it("freezes child skill selection instead of inheriting changed parent toggle maps", async () => {
        const frozenSkill = await skillFile("frozen-skill")
        const nextSkill = await skillFile("next-run-skill", "global")
        const config = createTaskConfig(false, {
            globalSkillsToggles: { [nextSkill]: true },
            localSkillsToggles: { [frozenSkill]: true },
            taskGlobalSkillsToggles: { [nextSkill]: false },
            taskLocalSkillsToggles: { [frozenSkill]: false },
        })
        config.cwd = cwd
        const agent = skillAgent(["frozen-skill"])
        const resolve = vi.spyOn(capabilitySelection, "resolveSubagentCapabilitySelection")
        const contexts: string[][] = []
        stubSystemPrompt(false, (context) => {
            contexts.push((context.skills ?? []).map((skill) => skill.name))
        })
        const createMessage = vi
            .fn()
            .mockImplementationOnce(async function* () {
                agent.skills = ["next-run-skill"]
                config.capabilityToggles.localSkillsToggles[frozenSkill] = false
                config.capabilityToggles.globalSkillsToggles[nextSkill] = true
                yield {
                    type: "tool_calls",
                    function_id: "frozen-skill-list",
                    tool_call: { function: { name: DlineDefaultTool.LIST_FILES, arguments: JSON.stringify({ path: "." }) } },
                }
            })
            .mockImplementationOnce(async function* () {
                yield {
                    type: "tool_calls",
                    function_id: "frozen-skill-toggle",
                    tool_call: {
                        function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) },
                    },
                }
            })
        stubApiHandler(createMessage)
        initializeHostProvider()
        const runner = new SubagentRunner(config, "skill-agent", agent)

        const result = await runner.run("Use frozen skill selection", () => {})

        assert.equal(result.status, "completed", result.error)
        expect(createMessage).toHaveBeenCalledTimes(2)
        expect(resolve).toHaveBeenCalledOnce()
        expect(resolve.mock.calls[0][0]).toBe(config)
        expect(resolve.mock.calls[0][1].skills).toEqual(["frozen-skill"])
        expect(contexts).toEqual([["frozen-skill"]])
        expect(ListFilesToolHandler.prototype.execute).toHaveBeenCalledOnce()
        const toolConfig = vi.mocked(ListFilesToolHandler.prototype.execute).mock.calls[0][0]
        expect(toolConfig.subagentCapabilitySelection?.skills.map((skill) => skill.name)).toEqual(["frozen-skill"])
        expect(toolConfig.capabilityToggles.localSkillsToggles[frozenSkill]).toBe(true)
        expect(toolConfig.capabilityToggles.globalSkillsToggles[nextSkill]).toBe(false)
    })

    it("uses no optional skills when subagent skills are not configured", async () => {
        const alpha = await skillFile("alpha-skill", "global")
        const beta = await skillFile("beta-skill")
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "tsu1",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(false, (context) => {
            assert.deepEqual(context.skills, [])
        })
        stubApiHandler(createMessage)
        initializeHostProvider()
        const config = createTaskConfig(false, {
            globalSkillsToggles: { [alpha]: true },
            localSkillsToggles: { [beta]: true },
        })
        config.cwd = cwd
        const runner = new SubagentRunner(config, "skill-agent", skillAgent())
        const result = await runner.run("Run task", () => {})
        assert.equal(result.status, "completed", result.error)
        assert.equal(createMessage.mock.calls.length, 1)
    })

    it("logs a warning when a configured skill is not available", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "tsm1",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        const warnStub = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
        stubSystemPrompt(false, (context) => {
            assert.deepEqual(
                context.skills?.map((skill) => skill.name),
                ["present-skill"],
            )
        })
        stubApiHandler(createMessage)
        initializeHostProvider()
        const config = createTaskConfig(false, {
            remoteGlobalSkills: [createRemoteSkillEntry("present-skill", "P")],
        })
        config.cwd = cwd
        const runner = new SubagentRunner(config, "skill-agent", skillAgent(["present-skill", "missing-skill"]))
        const result = await runner.run("Run task", () => {})
        assert.equal(result.status, "completed", result.error)
        assert.equal(createMessage.mock.calls.length, 1)
        assert.ok(
            warnStub.mock.calls.some((c) => c.some((a) => String(a).includes("missing-skill"))),
            "Expected warn about missing skill",
        )
    })

    it("includes enabled remote skills in subagent context and preserves configured remote names", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "trs1",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        const remoteGlobalSkills = [
            createRemoteSkillEntry("remote-enabled", "E"),
            createRemoteSkillEntry("remote-disabled", "D"),
            createRemoteSkillEntry("remote-locked", "L", { alwaysEnabled: true }),
        ]
        stubSystemPrompt(false, (context) => {
            assert.deepEqual(
                context.skills?.map((skill) => skill.name),
                ["remote-enabled", "remote-disabled", "remote-locked"],
            )
        })
        const discover = vi.spyOn(skills, "discoverSkills")
        stubApiHandler(createMessage)
        initializeHostProvider()
        const config = createTaskConfig(false, {
            remoteGlobalSkills,
            remoteSkillsToggles: {
                "remote-disabled": false,
                "remote-locked": false,
            },
        })
        config.cwd = cwd
        // Optional remote-disabled is independently selected despite the parent's false;
        // mandatory remote-locked remains available without an ordinary child selection.
        const runner = new SubagentRunner(config, "skill-agent", skillAgent(["remote-enabled", "remote-disabled"]))
        const result = await runner.run("Run task", () => {})
        assert.equal(result.status, "completed", result.error)
        assert.equal(createMessage.mock.calls.length, 1)
        expect(discover).toHaveBeenCalledWith(cwd, remoteGlobalSkills)
        expect(config.capabilityToggles.remoteSkillsToggles).toEqual({ "remote-disabled": false, "remote-locked": false })
    })
})
