import type { ApiHandler } from "@core/api"
import * as skills from "@core/context/instructions/user-instructions/skills"
import { PromptProfile } from "@core/prompts/profiles/types"
import * as systemPrompt from "@core/prompts/system-prompt"
import { deferred } from "@core/task/runtime/deferred"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import type { ClineStorageMessage } from "@shared/messages"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiFormat } from "@/shared/proto/dline/models/metadata"
import { createTaskCapabilityToggles } from "@/shared/TaskCapabilityToggles"
import { DlineDefaultTool } from "@/shared/tools"
import { ListFilesToolHandler } from "../../handlers/ListFilesToolHandler"
import { ReadFileToolHandler } from "../../handlers/ReadFileToolHandler"
import { DefaultToolHandlerState } from "../../state/ToolHandlerState"
import { SubagentBuilder } from "../SubagentBuilder"
import { SubagentRunner } from "../SubagentRunner"

const SUMMARY = "<summarize_task><context>Keep investigating the delegated problem.</context></summarize_task>"
const HIGH_USAGE = { type: "usage", inputTokens: 190_000, outputTokens: 1_000 }

function tool(name: string, id: string) {
    return {
        type: "tool_calls",
        function_id: id,
        tool_call: {
            function: { name, arguments: JSON.stringify(name === DlineDefaultTool.ATTEMPT ? { result: "done" } : { path: "." }) },
        },
    }
}

function setup(createMessage: ReturnType<typeof vi.fn>, autoCompact = true, native = true, maxContextTokens?: number) {
    const abort = vi.fn()
    const api = {
        createMessage,
        abort,
        getProviderId: () => "anthropic",
        getModel: () => ({
            // Deliberately not a model-family whitelist entry.
            id: "ordinary-model",
            info: {
                apiFormats: [ApiFormat.ANTHROPIC_CHAT],
                capabilities: { contextWindow: 200_000, maxTokens: 8_000, supportsTools: true },
            },
        }),
    } as unknown as ApiHandler
    vi.spyOn(SubagentBuilder.prototype, "getApiHandler").mockReturnValue(api)
    vi.spyOn(SubagentBuilder.prototype, "getAllowedTools").mockReturnValue([
        DlineDefaultTool.LIST_FILES,
        DlineDefaultTool.FILE_READ,
        DlineDefaultTool.ATTEMPT,
    ])
    vi.spyOn(systemPrompt, "getSystemPrompt").mockResolvedValue({
        systemPrompt: "ordinary system prompt",
        tools: native
            ? [DlineDefaultTool.LIST_FILES, DlineDefaultTool.ATTEMPT].map((name) => ({ type: "function", function: { name } }))
            : undefined,
        profile: PromptProfile.Standard,
        warnings: [],
    })
    vi.spyOn(skills, "discoverAvailableSkills").mockResolvedValue([])
    const list = vi.spyOn(ListFilesToolHandler.prototype, "execute").mockResolvedValue("listed files")
    const config = {
        taskId: "subagent-compaction-test",
        api,
        cwd: "/tmp",
        taskState: new DefaultToolHandlerState(),
        messageState: { clineMessages: [] },
        capabilityToggles: createTaskCapabilityToggles({}),
        browserSettings: {},
        focusChainSettings: {},
        autoApprovalSettings: { actions: { readFiles: true } },
        services: {
            stateManager: {
                getApiConfigurationForTask: () => ({}),
                getGlobalSettingsKey: (key: string) =>
                    key === "useAutoCondense"
                        ? autoCompact
                        : key === "autoCondenseMaxContextTokens"
                          ? maxContextTokens
                          : undefined,
                getGlobalStateKey: () => native,
                getRemoteConfigSettings: () => ({}),
            },
            imageGenerationService: { withProfileResolver: () => ({ hasAvailableProfile: () => false }) },
        },
        callbacks: {},
    } as unknown as TaskConfig
    return { config, abort, list }
}

// Avoid real Profile/storage lookup while retaining the Runner's own provider and tool loop.
vi.mock("../SubagentBuilder", async (importOriginal) => {
    const original = await importOriginal<typeof import("../SubagentBuilder")>()
    return {
        ...original,
        SubagentBuilder: class {
            getApiHandler() {
                throw new Error("Test must provide an API handler")
            }
            getAllowedTools() {
                return [DlineDefaultTool.LIST_FILES, DlineDefaultTool.ATTEMPT]
            }
            getConfiguredSkills() {
                return undefined
            }
            getConfiguredMaxOutputTokens() {
                return undefined
            }
            getProfileId() {
                return undefined
            }
            getProfileName() {
                return undefined
            }
            getReasoningConfig() {
                return undefined
            }
            buildSystemPrompt(prompt: string) {
                return prompt
            }
        },
    }
})

afterEach(() => vi.restoreAllMocks())

describe("SubagentRunner automatic compaction", () => {
    it.each([true, false])("summarizes and continues exploration without the 80% stop (native=%s)", async (native) => {
        const createMessage = vi.fn()
        const sendTool = (name: string, id: string) =>
            native
                ? tool(name, id)
                : {
                      type: "text",
                      text:
                          name === DlineDefaultTool.ATTEMPT
                              ? "<attempt_completion><result>done</result></attempt_completion>"
                              : "<list_files><path>.</path></list_files>",
                  }
        createMessage.mockImplementationOnce(async function* () {
            yield HIGH_USAGE
            yield sendTool(DlineDefaultTool.LIST_FILES, "before")
        })
        createMessage.mockImplementationOnce(async function* () {
            yield { type: "text", text: SUMMARY }
            yield { type: "usage", inputTokens: 100, outputTokens: 10 }
        })
        createMessage.mockImplementationOnce(async function* () {
            yield sendTool(DlineDefaultTool.LIST_FILES, "after")
        })
        createMessage.mockImplementationOnce(async function* () {
            yield sendTool(DlineDefaultTool.ATTEMPT, "done")
        })
        const { config, list } = setup(createMessage, true, native)
        const result = await new SubagentRunner(config).run("Investigate thoroughly", () => {})

        expect(result.status, result.error).toBe("completed")
        expect(result.result).toBe("done")
        expect(list).toHaveBeenCalledTimes(2)
        expect(createMessage).toHaveBeenCalledTimes(4)
        const [ordinarySystem, , ordinaryTools] = createMessage.mock.calls[0]
        expect(createMessage.mock.calls[1][0]).toBe(ordinarySystem)
        expect(createMessage.mock.calls[1][2]).toEqual(ordinaryTools)
        expect(createMessage.mock.calls[1][3]).toMatchObject({ generation: { purpose: "compaction" } })
        const resumed = createMessage.mock.calls[2][1] as ClineStorageMessage[]
        expect(JSON.stringify(resumed)).toContain("Keep investigating the delegated problem.")
        expect(JSON.stringify(resumed)).not.toContain('"function_id":"before"')
        expect(JSON.stringify(resumed)).not.toContain("Call attempt_completion before usage reaches 80%")
        expect(result.stats.contextUsagePercentage).toBeLessThan(80)
    })

    it("retains the old convergence behavior when automatic compaction is off", async () => {
        const createMessage = vi
            .fn()
            .mockImplementationOnce(async function* () {
                yield HIGH_USAGE
                yield tool(DlineDefaultTool.LIST_FILES, "before")
            })
            .mockImplementationOnce(async function* () {
                yield tool(DlineDefaultTool.ATTEMPT, "done")
            })
        const { config } = setup(createMessage, false)
        const result = await new SubagentRunner(config).run("Investigate", () => {})
        expect(result.status, result.error).toBe("completed")
        expect(createMessage).toHaveBeenCalledTimes(2)
        expect(createMessage.mock.calls.every((call) => call[3]?.generation?.purpose !== "compaction")).toBe(true)
    })

    it("reports a failed summary instead of sending the oversized ordinary request", async () => {
        const createMessage = vi
            .fn()
            .mockImplementationOnce(async function* () {
                yield HIGH_USAGE
                yield tool(DlineDefaultTool.LIST_FILES, "before")
            })
            .mockImplementationOnce(async function* () {
                yield { type: "usage", inputTokens: 100, outputTokens: 0 }
                throw Object.assign(new Error("compaction refused"), { status: 400 })
            })
        const { config } = setup(createMessage)
        const result = await new SubagentRunner(config).run("Investigate", () => {})
        expect(result.status).toBe("failed")
        expect(createMessage).toHaveBeenCalledTimes(2)
    })

    it("cancels the hidden compaction request with the run", async () => {
        const started = deferred<void>()
        const stopped = deferred<void>()
        const createMessage = vi
            .fn()
            .mockImplementationOnce(async function* () {
                yield HIGH_USAGE
                yield tool(DlineDefaultTool.LIST_FILES, "before")
            })
            .mockImplementationOnce(async function* () {
                started.resolve()
                await stopped.promise
                yield { type: "text", text: SUMMARY }
            })
        const { config, abort } = setup(createMessage)
        abort.mockImplementation(() => stopped.resolve())
        const runner = new SubagentRunner(config)
        const running = runner.run("Investigate", () => {})
        await started.promise
        await runner.abort()
        expect((await running).status).toBe("cancelled")
        expect(abort).toHaveBeenCalled()
        expect(createMessage).toHaveBeenCalledTimes(2)
    })

    it("compacts large new tool results even when the provider reports no usage", async () => {
        const createMessage = vi
            .fn()
            .mockImplementationOnce(async function* () {
                yield tool(DlineDefaultTool.LIST_FILES, "large-result-1")
            })
            .mockImplementationOnce(async function* () {
                yield tool(DlineDefaultTool.LIST_FILES, "large-result-2")
            })
            .mockImplementationOnce(async function* () {
                yield tool(DlineDefaultTool.LIST_FILES, "large-result-3")
            })
            .mockImplementationOnce(async function* () {
                yield { type: "text", text: SUMMARY }
            })
            .mockImplementationOnce(async function* () {
                yield tool(DlineDefaultTool.ATTEMPT, "done")
            })
        const { config, list } = setup(createMessage, true, true, 50_000)
        list.mockResolvedValue("x".repeat(1_000_000))
        const result = await new SubagentRunner(config).run("Inspect a large tree", () => {})
        expect(result.status, result.error).toBe("completed")
        expect(createMessage).toHaveBeenCalledTimes(5)
        expect(createMessage.mock.calls[3][3]).toMatchObject({ generation: { purpose: "compaction" } })
    })

    it("can compact again without reattaching pre-compaction round guidance", async () => {
        const createMessage = vi
            .fn()
            .mockImplementationOnce(async function* () {
                yield HIGH_USAGE
                yield tool(DlineDefaultTool.LIST_FILES, "first")
            })
            .mockImplementationOnce(async function* () {
                yield { type: "text", text: SUMMARY }
            })
            .mockImplementationOnce(async function* () {
                yield HIGH_USAGE
                yield tool(DlineDefaultTool.LIST_FILES, "second")
            })
            .mockImplementationOnce(async function* () {
                yield { type: "text", text: "<summarize_task><context>Latest cumulative findings.</context></summarize_task>" }
            })
            .mockImplementationOnce(async function* () {
                yield tool(DlineDefaultTool.ATTEMPT, "done")
            })
        const { config } = setup(createMessage)
        const result = await new SubagentRunner(config).run("Keep investigating", () => {})
        expect(result.status, result.error).toBe("completed")
        expect(createMessage).toHaveBeenCalledTimes(5)
        const resumed = createMessage.mock.calls[4][1] as ClineStorageMessage[]
        const content = resumed.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        expect(content.filter((block) => block.type === "text" && block.text.includes("# Context Window Usage"))).toHaveLength(1)
        expect(JSON.stringify(resumed)).toContain("Latest cumulative findings.")
        expect(JSON.stringify(resumed)).not.toContain("Keep investigating the delegated problem.")
    })

    it("does not apply old file-read replacements to reindexed messages after summarizing", async () => {
        const read = { type: "text", text: "<read_file><path>a.ts</path></read_file>" }
        const list = { type: "text", text: "<list_files><path>.</path></list_files>" }
        const createMessage = vi
            .fn()
            .mockImplementationOnce(async function* () {
                yield read
            })
            .mockImplementationOnce(async function* () {
                yield read
            })
            .mockImplementationOnce(async function* () {
                yield { type: "usage", inputTokens: 0, outputTokens: 0 }
                throw Object.assign(new Error("context length exceeded"), { status: 400 })
            })
            .mockImplementationOnce(async function* () {
                yield HIGH_USAGE
                yield list
            })
            .mockImplementationOnce(async function* () {
                yield { type: "text", text: SUMMARY }
            })
            .mockImplementationOnce(async function* () {
                yield list
            })
            .mockImplementationOnce(async function* () {
                yield { type: "text", text: "<attempt_completion><result>done</result></attempt_completion>" }
            })
        const { config, list: executeList } = setup(createMessage, true, false)
        const executeRead = vi.spyOn(ReadFileToolHandler.prototype, "execute").mockResolvedValue("file contents")
        executeList.mockResolvedValue("FRESH_LIST_RESULT_AFTER_SUMMARY")
        const result = await new SubagentRunner(config).run("Inspect files", () => {})
        expect(result.status, result.error).toBe("completed")
        expect(executeRead).toHaveBeenCalledTimes(2)
        expect(createMessage).toHaveBeenCalledTimes(7)
        const finalConversation = createMessage.mock.calls[6][1] as ClineStorageMessage[]
        expect(JSON.stringify(finalConversation.at(-1))).toContain("FRESH_LIST_RESULT_AFTER_SUMMARY")
        // Old file-read overlays must not turn an assistant tool call into a user result.
        expect(JSON.stringify(finalConversation.filter((message) => message.role === "assistant"))).not.toContain(
            "[read_file for",
        )
    })

    it("honors a manual finish while compaction is running", async () => {
        const started = deferred<void>()
        const stopped = deferred<void>()
        const createMessage = vi
            .fn()
            .mockImplementationOnce(async function* () {
                yield HIGH_USAGE
                yield tool(DlineDefaultTool.LIST_FILES, "first")
            })
            .mockImplementationOnce(async function* () {
                started.resolve()
                await stopped.promise
                yield { type: "text", text: SUMMARY }
            })
            .mockImplementationOnce(async function* () {
                yield tool(DlineDefaultTool.ATTEMPT, "done")
            })
        const { config, abort } = setup(createMessage)
        abort.mockImplementation(() => stopped.resolve())
        const runner = new SubagentRunner(config)
        const running = runner.run("Investigate", () => {})
        await started.promise
        expect(await runner.requestFinish("user")).toBe(true)
        expect((await running).status).toBe("completed")
        expect(createMessage).toHaveBeenCalledTimes(3)
        // A cancelled summary never replaces the ordinary conversation.
        expect(JSON.stringify(createMessage.mock.calls[2][1])).not.toContain("Keep investigating the delegated problem.")
    })
})
