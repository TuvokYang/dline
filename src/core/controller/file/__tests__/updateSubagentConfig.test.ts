import { strict as assert } from "node:assert"
import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { parseAgentConfigFromYaml } from "@core/task/tools/subagent/AgentConfigLoader"
import { UpdateSubagentConfigRequest } from "@shared/proto/dline/file"
import * as atomicFile from "@shared/storage/atomic-file"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { updateSubagentConfig } from "../updateSubagentConfig"

const temporaryDirectories: string[] = []

function createController() {
    const flushPromptFreshnessInvalidation = vi.fn().mockResolvedValue(undefined)
    const postStateToWebview = vi.fn().mockResolvedValue(undefined)
    return {
        controller: {
            task: createSessionFixture({ owners: { prompt: { flush: flushPromptFreshnessInvalidation } } }),
            postStateToWebview,
        } as never,
        flushPromptFreshnessInvalidation,
        postStateToWebview,
    }
}

async function createConfig(content: string): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "update-subagent-config-"))
    temporaryDirectories.push(directory)
    const subagentPath = path.join(directory, "reviewer.yml")
    await fs.writeFile(subagentPath, content, "utf8")
    return subagentPath
}

describe("updateSubagentConfig", () => {
    afterEach(async () => {
        vi.restoreAllMocks()
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
        expect(parseAgentConfigFromYaml(content).profile).toBe("own-openai:deepseek-v4-flash")
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
        const parsed = parseYamlFrontmatter(content)
        expect(parsed.parseError).toBeUndefined()
        expect(parsed.data.tools).toEqual([])
        expect(parsed.data).not.toHaveProperty("skills")
        expect(parseAgentConfigFromYaml(content).skills).toEqual([])
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

    it("serializes two concurrent protobuf patches against the latest file without losing either selection", async () => {
        const subagentPath = await createConfig(
            "---\nname: reviewer\ndescription: Research agent\ntools:\n  - read_file\nskills:\n  - old-skill\n---\nPrompt body\n",
        )
        const firstController = createController()
        const secondController = createController()
        const writeFileAtomic = atomicFile.writeFileAtomic
        let markStarted!: () => void
        let releaseWrite!: () => void
        const started = new Promise<void>((resolve) => {
            markStarted = resolve
        })
        const released = new Promise<void>((resolve) => {
            releaseWrite = resolve
        })
        vi.spyOn(atomicFile, "writeFileAtomic").mockImplementationOnce(async (...args) => {
            markStarted()
            await released
            await writeFileAtomic(...args)
        })

        const first = updateSubagentConfig(
            firstController.controller,
            UpdateSubagentConfigRequest.decode(
                UpdateSubagentConfigRequest.encode(
                    UpdateSubagentConfigRequest.create({ subagentPath, skills: ["new-skill"], replaceSkills: true }),
                ).finish(),
            ),
        )
        await Promise.race([
            started,
            first.then(() => {
                throw new Error("The save completed without reaching the atomic writer barrier")
            }),
        ])
        const second = updateSubagentConfig(
            secondController.controller,
            UpdateSubagentConfigRequest.decode(
                UpdateSubagentConfigRequest.encode(
                    UpdateSubagentConfigRequest.create({
                        subagentPath,
                        rules: [{ scope: "workspace", path: "review-policy.md" }],
                        replaceRules: true,
                    }),
                ).finish(),
            ),
        )
        // The second RPC is now enqueued behind the suspended first write.
        releaseWrite()
        await Promise.all([first, second])

        const content = await fs.readFile(subagentPath, "utf8")
        const parsed = parseAgentConfigFromYaml(content)
        expect(parsed.skills).toEqual(["new-skill"])
        expect(parsed.rules).toEqual([{ scope: "workspace", path: "review-policy.md" }])
        expect(parsed.tools).toEqual(["read_file"])
        expect(parsed.systemPrompt).toBe("Prompt body")
        await expect(fs.access(`${subagentPath}.lck`)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("rejects a failed atomic write without publishing success, releases the lock, and permits the next patch", async () => {
        const original = "---\nname: reviewer\ndescription: Research agent\nskills:\n  - old-skill\n---\nPrompt body\n"
        const subagentPath = await createConfig(original)
        const fixture = createController()
        const failure = new Error("injected atomic write failure")
        vi.spyOn(atomicFile, "writeFileAtomic").mockRejectedValueOnce(failure)

        await expect(
            updateSubagentConfig(
                fixture.controller,
                UpdateSubagentConfigRequest.create({ subagentPath, skills: ["not-persisted"], replaceSkills: true }),
            ),
        ).rejects.toMatchObject({ message: `Failed to update subagent config: ${subagentPath}`, cause: failure })
        const unchanged = await fs.readFile(subagentPath, "utf8")
        expect(unchanged).toBe(original)
        expect(parseAgentConfigFromYaml(unchanged).skills).toEqual(["old-skill"])
        expect(fixture.flushPromptFreshnessInvalidation).not.toHaveBeenCalled()
        expect(fixture.postStateToWebview).not.toHaveBeenCalled()
        await expect(fs.access(`${subagentPath}.lck`)).rejects.toMatchObject({ code: "ENOENT" })

        await updateSubagentConfig(
            fixture.controller,
            UpdateSubagentConfigRequest.create({ subagentPath, workflows: ["review-workflow"], replaceWorkflows: true }),
        )
        const recovered = parseAgentConfigFromYaml(await fs.readFile(subagentPath, "utf8"))
        expect(recovered.skills).toEqual(["old-skill"])
        expect(recovered.workflows).toEqual(["review-workflow"])
        expect(fixture.flushPromptFreshnessInvalidation).toHaveBeenCalledOnce()
    })

    it("does not overwrite invalid YAML or report that the rejected patch was saved", async () => {
        const original = "---\nname: reviewer\ndescription: Research agent\nskills: [unterminated\n---\nPrompt body\n"
        const subagentPath = await createConfig(original)
        const fixture = createController()
        await expect(
            updateSubagentConfig(
                fixture.controller,
                UpdateSubagentConfigRequest.create({ subagentPath, skills: [], replaceSkills: true }),
            ),
        ).rejects.toThrow("Failed to update subagent config")
        expect(await fs.readFile(subagentPath, "utf8")).toBe(original)
        expect(parseYamlFrontmatter(original).parseError).toBeDefined()
        expect(fixture.flushPromptFreshnessInvalidation).not.toHaveBeenCalled()
        expect(fixture.postStateToWebview).not.toHaveBeenCalled()
        await expect(fs.access(`${subagentPath}.lck`)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("posts state only after the saved YAML is readable when there is no active task", async () => {
        const subagentPath = await createConfig("---\nname: reviewer\ndescription: Research agent\n---\nPrompt body\n")
        const saved: unknown[] = []
        const postStateToWebview = vi.fn(async () => {
            saved.push(parseAgentConfigFromYaml(await fs.readFile(subagentPath, "utf8")).workflows)
        })
        await updateSubagentConfig(
            { postStateToWebview } as never,
            UpdateSubagentConfigRequest.create({ subagentPath, workflows: ["review-workflow"], replaceWorkflows: true }),
        )
        expect(saved).toEqual([["review-workflow"]])
    })

    it("rejects an invalid rule selection without writing YAML, posting state, or leaving the lock held", async () => {
        const original = "---\nname: reviewer\ndescription: Research agent\nskills:\n  - systematic-debugging\n---\nPrompt body\n"
        const subagentPath = await createConfig(original)
        const fixture = createController()
        const failure = await updateSubagentConfig(
            fixture.controller,
            UpdateSubagentConfigRequest.create({
                subagentPath,
                rules: [{ scope: "workspace", path: "C:\\rules\\policy.md" }],
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
        expect(fixture.flushPromptFreshnessInvalidation).not.toHaveBeenCalled()
        expect(fixture.postStateToWebview).not.toHaveBeenCalled()
        await expect(fs.access(`${subagentPath}.lck`)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("normalizes rule paths on save so the stored document re-reads identically", async () => {
        const subagentPath = await createConfig("---\nname: reviewer\ndescription: Research agent\n---\nPrompt body\n")
        const fixture = createController()
        await updateSubagentConfig(
            fixture.controller,
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
        const content = await fs.readFile(subagentPath, "utf8")
        const expected = [
            { scope: "workspace", path: "guides/review.md" },
            { scope: "remote", path: "Team Policy: Security / v1" },
        ]
        expect(parseAgentConfigFromYaml(content).rules).toEqual(expected)
        expect(content).toContain("rules:\n  - scope: workspace\n    path: guides/review.md\n")
        expect(fixture.flushPromptFreshnessInvalidation).toHaveBeenCalledWith("capability_mutation")
    })
})
