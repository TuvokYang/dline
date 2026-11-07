import { strict as assert } from "node:assert"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/config", () => import("./SubagentRunner.config.fixture"))

import * as coreApi from "@core/api"
import * as skills from "@core/context/instructions/user-instructions/skills"
import * as profileStore from "@core/controller/file/getApiProfiles"
import { PromptProfile } from "@core/prompts/profiles/types"
import * as systemPromptFacade from "@core/prompts/system-prompt"
import type { SystemPromptContext } from "@core/prompts/system-prompt/context"
import { deferred } from "@core/task/runtime/deferred"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { DlineDefaultTool } from "@/shared/tools"
import { GenerateImageToolHandler } from "../../handlers/GenerateImageToolHandler"
import { ListCodeDefinitionNamesToolHandler } from "../../handlers/ListCodeDefinitionNamesToolHandler"
import { ListFilesToolHandler } from "../../handlers/ListFilesToolHandler"
import { ReadFileToolHandler } from "../../handlers/ReadFileToolHandler"
import { SubagentRunner } from "../SubagentRunner"
import {
    assertFinishTurnReusesRequestShape,
    createTaskConfig,
    initializeHostProvider,
    SUBAGENT_REQUEST_ID,
    stubApiHandler,
    stubSystemPrompt,
    type TestConversationMessage,
    useSubagentRunnerTestLifecycle,
} from "./SubagentRunner.fixtures"

describe("SubagentRunner", () => {
    useSubagentRunnerTestLifecycle()

    it("binds image prompt and tool execution to the subagent Profile while reusing the parent service boundary", async () => {
        vi.spyOn(profileStore, "readApiProfiles").mockReturnValue([
            {
                id: "subagent-profile-id",
                name: "subagent-images",
                provider: "openai",
                modelId: "custom-responses-model",
                imageModelId: "gpt-image-2",
                usedFor: ["subagents"],
                enabled: true,
            },
        ] as ReturnType<typeof profileStore.readApiProfiles>)
        let requestRound = 0
        const createMessage = vi.fn().mockImplementation(async function* () {
            requestRound += 1
            yield {
                type: "tool_calls",
                function_id: requestRound === 1 ? "generate-image" : "complete",
                tool_call: {
                    function: {
                        name: requestRound === 1 ? DlineDefaultTool.GENERATE_IMAGE : DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify(requestRound === 1 ? { prompt: "Draw a fox" } : { result: "done" }),
                    },
                },
            }
        })
        let promptContext: SystemPromptContext | undefined
        stubSystemPrompt(false, (context) => {
            promptContext ??= context
        })
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        // The explicit subagent Profile resolves, so the builder takes the
        // Profile-bound handler path; without this double the mock Profile has no
        // credentials and the run fails while constructing a real provider client.
        vi.spyOn(coreApi, "buildApiHandlerFromProfile").mockImplementation(() => coreApi.buildApiHandler({} as never, "act"))
        initializeHostProvider()
        const config = createTaskConfig(false)
        const derivedImageService = { hasAvailableProfile: vi.fn(() => true) }
        const withProfileResolver = vi.fn(() => derivedImageService)
        config.services.imageGenerationService.withProfileResolver = withProfileResolver as never
        const executeGenerateImage = vi
            .spyOn(GenerateImageToolHandler.prototype, "execute")
            .mockImplementation(async (toolConfig) => {
                expect(toolConfig.services.imageGenerationService).toBe(derivedImageService)
                return "generated"
            })
        const runner = new SubagentRunner(config, "image-agent", {
            name: "image-agent",
            description: "image subagent",
            profile: "subagent-images",
            tools: [DlineDefaultTool.GENERATE_IMAGE],
            systemPrompt: "",
        })

        const result = await runner.run("Create an image", () => {})

        expect(result.status).toBe("completed")
        expect(withProfileResolver).toHaveBeenCalledOnce()
        expect(promptContext?.imageGenerationAvailable).toBe(true)
        expect(promptContext?.disableTools).not.toContain(DlineDefaultTool.GENERATE_IMAGE)
        expect(executeGenerateImage).toHaveBeenCalledOnce()
    })

    it("fails closed when inherited subagent approval hits a manual-only external scope", async () => {
        let requestRound = 0
        const createMessage = vi.fn().mockImplementation(async function* () {
            requestRound += 1
            yield {
                type: "tool_calls",
                function_id: requestRound === 1 ? "read-external" : "complete-after-denial",
                tool_call: {
                    function: {
                        name: requestRound === 1 ? DlineDefaultTool.FILE_READ : DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify(requestRound === 1 ? { path: "../outside.txt" } : { result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const executeRead = vi.spyOn(ReadFileToolHandler.prototype, "execute")
        const config = createTaskConfig(false)
        config.cwd = "/workspace"
        config.autoApprovalSettings = {
            ...DEFAULT_AUTO_APPROVAL_SETTINGS,
            actions: {
                ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions,
                readFiles: true,
                readFilesExternally: true,
            },
            ceilings: { read_external: "manual_only" },
        }
        const runner = new SubagentRunner(config, "policy-agent", {
            name: "policy-agent",
            description: "Exercises inherited tool admission.",
            tools: [DlineDefaultTool.FILE_READ, DlineDefaultTool.ATTEMPT],
            systemPrompt: "",
        })

        const result = await runner.run("Read outside the workspace", () => {})

        assert.equal(result.status, "completed", result.error)
        assert.equal(result.result, "done")
        expect(executeRead).not.toHaveBeenCalled()
    })

    it.each([
        [63_999, PromptProfile.Lite],
        [64_000, PromptProfile.Standard],
    ] as const)("resolves context window %s to %s before building the subagent prompt", async (contextWindow, expected) => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "profile-complete",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(false, (context) => {
            assert.equal(context.promptProfile, expected)
        })
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage, contextWindow)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false, { contextWindow })).run("Use profile", () => {})

        assert.equal(result.status, "completed", result.error)
    })

    it("reports cancellation before the first API request as cancelled", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {})
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const config = createTaskConfig(false)
        config.taskState.cancelOperations("test_parent_cancelled_before_request")
        const progress = vi.fn()

        const result = await new SubagentRunner(config).run("Cancel before request", progress)

        assert.equal(result.status, "cancelled")
        assert.equal(result.error, "Subagent run cancelled.")
        assert.equal(createMessage.mock.calls.length, 0)
        assert.equal(progress.mock.calls.at(-1)?.[0].status, "cancelled")
    })

    // A retry reuses the same runner instance. Before the guard, the second run
    // reset `abortRequested` and replaced the abort controllers while the first
    // one was still unwinding, so the two runs cancelled each other's requests.
    it("serializes a retry against a run that has not unwound yet", async () => {
        const runOrder: string[] = []
        let releaseFirstRun: (() => void) | undefined
        const firstRunReachedProvider = new Promise<void>((resolve) => {
            releaseFirstRun = resolve
        })
        let call = 0
        const createMessage = vi.fn().mockImplementation(async function* () {
            call += 1
            const label = `run-${call}`
            runOrder.push(`${label}:start`)
            if (call === 1) {
                await firstRunReachedProvider
            }
            runOrder.push(`${label}:end`)
            yield {
                type: "tool_calls",
                function_id: `${label}-complete`,
                tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: label }) } },
            }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const runner = new SubagentRunner(createTaskConfig(false))

        const first = runner.run("First run", () => {})
        await vi.waitFor(() => {
            assert.equal(runOrder.includes("run-1:start"), true)
        })
        const second = runner.run("Retry run", () => {})
        // The retry must not reach the provider while the first run is in flight.
        assert.equal(createMessage.mock.calls.length, 1)

        releaseFirstRun?.()
        const [firstResult, secondResult] = await Promise.all([first, second])

        assert.deepEqual(runOrder, ["run-1:start", "run-1:end", "run-2:start", "run-2:end"])
        assert.equal(firstResult.status, "completed", firstResult.error)
        assert.equal(firstResult.result, "run-1")
        assert.equal(secondResult.status, "completed", secondResult.error)
        assert.equal(secondResult.result, "run-2")
        assert.equal(createMessage.mock.calls.length, 2)
    })

    // A failed run must not block the next one: the guard waits for the previous
    // run to settle, not for it to succeed.
    it("starts the next run after the previous one rejects", async () => {
        // The first run must exhaust its own backoff sequence before it can fail,
        // so every attempt of that run has to reject.
        let firstRunFinished = false
        const createMessage = vi.fn().mockImplementation(async function* () {
            if (!firstRunFinished) throw new Error("first run exploded")
            yield {
                type: "tool_calls",
                function_id: "after-failure-complete",
                tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "recovered" }) } },
            }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const runner = new SubagentRunner(createTaskConfig(false))

        const failed = await runner.run("Failing run", () => {})
        assert.equal(failed.status, "failed")
        firstRunFinished = true

        const recovered = await runner.run("Recovered run", () => {})
        assert.equal(recovered.status, "completed", recovered.error)
        assert.equal(recovered.result, "recovered")
    })

    it("allows an explicitly restored Activity runner to outlive an inert parent Task", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "restored-activity-complete",
                tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "restored" }) } },
            }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const config = createTaskConfig(false)
        config.taskState.cancelOperations("test_inert_parent")

        const result = await new SubagentRunner(config, "subagent", undefined, { inheritTaskAbort: false }).run(
            "Resume explicit Activity",
            () => {},
        )

        assert.equal(result.status, "completed", result.error)
        assert.equal(result.result, "restored")
        assert.equal(createMessage.mock.calls.length, 1)
    })

    it("reports cancellation between API turns as cancelled", async () => {
        const config = createTaskConfig(false)
        const createMessage = vi.fn().mockImplementation(async function* () {
            config.taskState.cancelOperations("test_cancel_between_turns")
            yield* []
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const progress = vi.fn()

        const result = await new SubagentRunner(config).run("Cancel between turns", progress)

        assert.equal(result.status, "cancelled")
        assert.equal(result.error, "Subagent run cancelled.")
        assert.equal(createMessage.mock.calls.length, 1)
        assert.equal(progress.mock.calls.at(-1)?.[0].status, "cancelled")
    })

    it("reports cancellation after a tool result as cancelled", async () => {
        const config = createTaskConfig(true)
        vi.mocked(ListFilesToolHandler.prototype.execute).mockImplementation(async () => {
            config.taskState.cancelOperations("test_cancel_after_tool_result")
            return "ok"
        })
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "toolu_cancel_after_result",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.LIST_FILES,
                        arguments: JSON.stringify({ path: ".", recursive: false }),
                    },
                },
            }
        })
        stubSystemPrompt(true)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const progress = vi.fn()

        const result = await new SubagentRunner(config).run("Cancel after tool", progress)

        assert.equal(result.status, "cancelled")
        assert.equal(result.error, "Subagent run cancelled.")
        assert.equal(createMessage.mock.calls.length, 1)
        assert.equal(progress.mock.calls.at(-1)?.[0].status, "cancelled")
    })

    it("builds subagent prompts through the stable system prompt facade", async () => {
        const createMessage = vi.fn().mockImplementation(async function* (systemPrompt: string) {
            assert.match(systemPrompt, /^facade system prompt/)
            yield {
                type: "tool_calls",
                function_id: "facade-complete",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        const facade = vi.spyOn(systemPromptFacade, "getSystemPrompt").mockImplementation(async (context) => {
            assert.equal(context.isSubagentRun, true)
            return {
                systemPrompt: "facade system prompt",
                tools: undefined,
                profile: PromptProfile.Standard,
                warnings: [],
            }
        })
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Use facade", () => {})

        // A finish request reuses this one prompt, so the run builds it exactly once.
        assert.equal(facade.mock.calls.length, 1)
        const [context] = facade.mock.calls[0]
        assert.equal(context.isSubagentRun, true)
        assert.equal(result.status, "completed")
        assert.equal(result.result, "done")
    })

    it("keeps platform rules when appending the configured YAML instructions", async () => {
        const createMessage = vi.fn().mockImplementation(async function* (systemPrompt: string) {
            assert.match(systemPrompt, /^generated facade prompt/)
            assert.match(systemPrompt, /# Subagent Custom Instructions/)
            assert.match(systemPrompt, /Local YAML system prompt\./)
            assert.match(systemPrompt, /Plain assistant text cannot complete a subagent run/)
            yield {
                type: "tool_calls",
                function_id: "yaml-prompt-complete",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        vi.spyOn(systemPromptFacade, "getSystemPrompt").mockResolvedValue({
            systemPrompt: "generated facade prompt",
            tools: undefined,
            profile: PromptProfile.Standard,
            warnings: [],
        })
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false), "local-reviewer", {
            name: "local-reviewer",
            description: "Local reviewer",
            tools: [DlineDefaultTool.ATTEMPT],
            systemPrompt: "Local YAML system prompt.",
        }).run("Use local config", () => {})

        assert.equal(result.status, "completed")
        assert.equal(result.result, "done")
        assert.equal(createMessage.mock.calls.length, 1)
    })

    it("stops the current attempt at attempt_completion before executing later tool calls", async () => {
        const executeListFiles = vi.mocked(ListFilesToolHandler.prototype.execute)
        executeListFiles.mockResolvedValue("must not run")
        const createMessage = vi.fn().mockImplementationOnce(async function* () {
            yield {
                type: "tool_calls",
                function_id: "toolu_completion_boundary",
                tool_index: 0,
                tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
            }
            yield {
                type: "tool_calls",
                function_id: "toolu_after_completion",
                tool_index: 1,
                tool_call: { function: { name: DlineDefaultTool.LIST_FILES, arguments: JSON.stringify({ path: "." }) } },
            }
        })
        stubSystemPrompt(true)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const config = createTaskConfig(true)
        const progress = vi.fn()

        const result = await new SubagentRunner(config).run("Complete before later tools", progress)

        assert.equal(result.status, "completed", result.error)
        assert.equal(result.result, "done")
        assert.equal(result.stats.toolCalls, 1)
        assert.equal(executeListFiles.mock.calls.length, 0)
        const completedTools = progress.mock.calls
            .map(([update]) => update.event)
            .filter((event) => event?.kind === "tool_call" && event.toolStatus === "completed")
        assert.deepEqual(
            completedTools.map((event) => event.toolName),
            [DlineDefaultTool.ATTEMPT],
        )
    })

    it("keeps the prompt and tools on a timeout finish turn and only appends a reminder", async () => {
        let runner: SubagentRunner
        const abort = vi.fn()
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            await runner.requestFinish("timeout")
            yield { type: "text", text: "partial findings" }
        })
        createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
            const reminder = conversation.at(-1) as { role: string; content: Array<{ type: string; text?: string }> }
            assert.equal(reminder.role, "user")
            assert.match(reminder.content[0]?.text || "", /time limit/i)
            assert.match(reminder.content[0]?.text || "", /Do not call any other tool/i)
            yield {
                type: "tool_calls",
                function_id: "toolu_timeout_complete",
                tool_index: 0,
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "finished after timeout reminder" }),
                    },
                },
            }
        })
        vi.spyOn(systemPromptFacade, "getSystemPrompt").mockResolvedValue({
            systemPrompt: "system prompt",
            tools: [
                { type: "function", function: { name: DlineDefaultTool.LIST_FILES, description: "List files" } },
                { type: "function", function: { name: DlineDefaultTool.ATTEMPT, description: "Complete" } },
            ] as never,
            profile: PromptProfile.Standard,
            warnings: [],
        })
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage, 200_000, false, abort)
        initializeHostProvider()
        runner = new SubagentRunner(createTaskConfig(true))

        const result = await runner.run("Explore until timeout", () => {})

        assert.equal(result.status, "completed", result.error)
        assert.equal(result.result, "finished after timeout reminder")
        assert.equal(createMessage.mock.calls.length, 2)
        assert.equal(abort.mock.calls.length, 1)
        assertFinishTurnReusesRequestShape(createMessage, [DlineDefaultTool.LIST_FILES, DlineDefaultTool.ATTEMPT])
    })

    it("reports the real provider error when the timeout finish turn itself fails", async () => {
        let runner: SubagentRunner
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            await runner.requestFinish("timeout")
            yield { type: "text", text: "partial findings" }
        })
        createMessage.mockImplementation(async function* () {
            yield* []
            throw new Error("400 e2e_mock_queue_exhausted: no scripted response left")
        })
        vi.spyOn(systemPromptFacade, "getSystemPrompt").mockResolvedValue({
            systemPrompt: "system prompt",
            tools: [{ type: "function", function: { name: DlineDefaultTool.ATTEMPT, description: "Complete" } }] as never,
            profile: PromptProfile.Standard,
            warnings: [],
        })
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage, 200_000, false, vi.fn())
        initializeHostProvider()
        runner = new SubagentRunner(createTaskConfig(true))

        const result = await runner.run("Explore until timeout", () => {})

        assert.equal(result.status, "failed")
        assert.match(result.error ?? "", /e2e_mock_queue_exhausted/)
        assert.doesNotMatch(result.error ?? "", /empty/i)
    })

    it("reports the effective runtime configuration before the first provider request", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "runtime-config-complete",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const progress = vi.fn()

        const result = await new SubagentRunner(createTaskConfig(false), "reviewer-opus", {
            name: "reviewer-opus",
            description: "Review code",
            profile: "anthropic",
            tools: [DlineDefaultTool.ATTEMPT],
            systemPrompt: "Review carefully.",
        }).run("Review", progress)

        assert.equal(result.status, "completed", result.error)
        // A subagent's name is free-form configuration and never selects its Usage role.
        expect(createMessage.mock.calls[0]?.[3]).toMatchObject({
            telemetryRole: "subagent",
            telemetryRequestId: expect.stringMatching(SUBAGENT_REQUEST_ID),
        })
        expect(progress.mock.calls[0]?.[0].runtime).toMatchObject({
            profileName: "anthropic",
            providerId: "anthropic",
            modelId: "anthropic/claude-sonnet-4.5",
            apiFormat: "anthropic_chat",
        })
    })

    it("keeps the prompt and tools on a manual finish turn and rejects non-completion tools", async () => {
        let runner: SubagentRunner
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "tool_calls",
                function_id: "toolu_finish_list",
                tool_index: 0,
                tool_call: {
                    function: {
                        name: DlineDefaultTool.LIST_FILES,
                        arguments: JSON.stringify({ path: ".", recursive: false }),
                    },
                },
            }
        })
        createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
            const reminder = conversation.at(-1) as { role: string; content: Array<{ type: string; text?: string }> }
            assert.equal(reminder.role, "user")
            assert.match(reminder.content[0]?.text || "", /user requested/i)
            assert.match(reminder.content[0]?.text || "", /Do not call any other tool/i)
            // The tool is still declared, so the model may call it; the runner must refuse it.
            yield {
                type: "tool_calls",
                function_id: "toolu_finish_list_again",
                tool_index: 0,
                tool_call: {
                    function: {
                        name: DlineDefaultTool.LIST_FILES,
                        arguments: JSON.stringify({ path: ".", recursive: false }),
                    },
                },
            }
        })
        createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
            const rejection = conversation.at(-1) as {
                role: string
                content: Array<{ type: string; tool_use_id?: string; content?: unknown }>
            }
            assert.equal(rejection.role, "user")
            const rejectionText = JSON.stringify(rejection.content)
            assert.match(rejectionText, /called list_files after you were told to finish/)
            assert.doesNotMatch(rejectionText, /Consecutive failed responses/)
            assert.match(rejectionText, /Call attempt_completion now/)
            yield {
                type: "tool_calls",
                function_id: "toolu_finish_complete",
                tool_index: 0,
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "finished with current findings" }),
                    },
                },
            }
        })
        vi.spyOn(systemPromptFacade, "getSystemPrompt").mockResolvedValue({
            systemPrompt: "system prompt",
            tools: [
                { type: "function", function: { name: DlineDefaultTool.LIST_FILES, description: "List files" } },
                { type: "function", function: { name: DlineDefaultTool.ATTEMPT, description: "Complete" } },
            ] as never,
            profile: PromptProfile.Standard,
            warnings: [],
        })
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const config = createTaskConfig(true)
        vi.mocked(ListFilesToolHandler.prototype.execute).mockImplementation(async () => {
            assert.equal(await runner.requestFinish("user"), true)
            return "ok"
        })
        runner = new SubagentRunner(config)

        const result = await runner.run("Explore then finish", () => {})

        assert.equal(result.status, "completed", result.error)
        assert.equal(result.result, "finished with current findings")
        assert.equal(createMessage.mock.calls.length, 3)
        // Only the pre-finish call ran; the finishing turn's list_files was refused.
        assert.equal(vi.mocked(ListFilesToolHandler.prototype.execute).mock.calls.length, 1)
        assertFinishTurnReusesRequestShape(createMessage, [DlineDefaultTool.LIST_FILES, DlineDefaultTool.ATTEMPT])
    })

    it("requires attempt_completion after a plain assistant response", async () => {
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            yield { type: "text", text: "The review is complete." }
        })
        createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
            const reminder = conversation.at(-1) as { role: string; content: Array<{ type: string; text?: string }> }
            assert.equal(reminder.role, "user")
            assert.match(reminder.content[0]?.text || "", /contained text but no tool call/)
            assert.doesNotMatch(reminder.content[0]?.text || "", /Consecutive failed responses/)
            assert.match(reminder.content[0]?.text || "", /Plain assistant text cannot complete a subagent run/)
            yield {
                type: "tool_calls",
                function_id: "toolu_subagent_plain_text_complete",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Review files", () => {})

        assert.equal(result.status, "completed")
        assert.equal(result.result, "done")
        assert.equal(createMessage.mock.calls.length, 2)
    })

    it("accepts the legacy response field for attempt_completion", async () => {
        const createMessage = vi.fn().mockImplementationOnce(async function* () {
            yield {
                type: "tool_calls",
                function_id: "toolu_subagent_legacy_response",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ response: "legacy done" }),
                    },
                },
            }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Review files", () => {})

        assert.equal(result.status, "completed")
        assert.equal(result.result, "legacy done")
        assert.equal(createMessage.mock.calls.length, 1)
    })

    it("requires a non-empty result after attempt_completion omits it", async () => {
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "tool_calls",
                function_id: "toolu_subagent_missing_result",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({}),
                    },
                },
            }
        })
        createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
            const reminder = conversation.at(-1) as { role: string; content: Array<{ type: string; text?: string }> }
            assert.equal(reminder.role, "user")
            assert.match(reminder.content[0]?.text || "", /attempt_completion/)
            assert.match(reminder.content[0]?.text || "", /non-empty result/)
            yield {
                type: "tool_calls",
                function_id: "toolu_subagent_retry_result",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Review files", () => {})

        assert.equal(result.status, "completed")
        assert.equal(result.result, "done")
    })

    it("bounds repeated empty attempt_completion calls instead of looping until timeout", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "toolu_subagent_missing_result_loop",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({}),
                    },
                },
            }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Review files", () => {})

        assert.equal(result.status, "failed")
        assert.match(result.error || "", /Subagent stopped after repeated responses/)
        assert.match(result.error || "", /- attempt_completion was called without a non-empty result/)
        assert.equal(createMessage.mock.calls.length, 5)
    })

    it("reports the required completion protocol after repeated plain responses", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield { type: "text", text: "I am finished." }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Review files", () => {})

        assert.equal(result.status, "failed")
        assert.equal(createMessage.mock.calls.length, 25)
        assert.match(result.error || "", /Subagent stopped after repeated responses/)
        assert.match(result.error || "", /- The previous response contained text but no tool call/)
        // The run's own reasoning is handed back rather than discarded.
        assert.match(result.error || "", /Partial findings recovered from the run[\s\S]*I am finished\./)
    })

    it("resets warning remainder and promoted mistakes after a tool executes successfully", async () => {
        const createMessage = vi.fn()
        // Twenty-four warnings produce four mistakes plus a remainder of four.
        // A successful tool must clear both before the second sequence starts.
        for (let round = 0; round < 24; round += 1) {
            createMessage.mockImplementationOnce(async function* () {
                yield { type: "text", text: "thinking out loud" }
            })
        }
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "tool_calls",
                function_id: "toolu_subagent_reset_list",
                tool_call: {
                    function: { name: DlineDefaultTool.LIST_FILES, arguments: JSON.stringify({ path: ".", recursive: false }) },
                },
            }
        })
        for (let round = 0; round < 24; round += 1) {
            createMessage.mockImplementationOnce(async function* () {
                yield { type: "text", text: "still thinking" }
            })
        }
        createMessage.mockImplementationOnce(async function* (_s: string, c: unknown[]) {
            const last = c.at(-1) as TestConversationMessage
            assert.doesNotMatch(JSON.stringify(last.content), /Consecutive failed responses/)
            yield {
                type: "tool_calls",
                function_id: "toolu_subagent_reset_complete",
                tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
            }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Review files", () => {})

        assert.equal(result.status, "completed", result.error)
        assert.equal(result.result, "done")
        assert.equal(createMessage.mock.calls.length, 50)
    })

    it("diagnoses an empty turn as user feedback before failing", async () => {
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            yield* []
        })
        createMessage.mockImplementationOnce(async function* (_s: string, c: unknown[]) {
            // No assistant turn is invented; the diagnosis joins the existing user turn.
            assert.equal(c.length, 1)
            const lu = c[0] as TestConversationMessage
            assert.equal(lu.role, "user")
            const feedback = lu.content.map((block) => block.text ?? "").join("\n")
            assert.match(feedback, /The previous response was empty/)
            assert.doesNotMatch(feedback, /Consecutive failed responses/)
            yield {
                type: "tool_calls",
                function_id: "toolu_subagent_complete_3",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const runner = new SubagentRunner(createTaskConfig(false))
        const result = await runner.run("List files", () => {})
        assert.equal(result.status, "completed")
        assert.equal(result.result, "done")
        assert.equal(createMessage.mock.calls.length, 2)
    })

    it("cancels a pending retry wait without issuing another API request", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield* []
            throw new Error('{"code":"stream_initialization_failed","message":"Temporary provider failure"}')
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const runner = new SubagentRunner(createTaskConfig(false))
        const runPromise = runner.run("Cancel the provider retry", () => {})
        await vi.waitFor(() => assert.equal(createMessage.mock.calls.length, 1))
        await runner.abort()
        const result = await runPromise

        assert.equal(result.status, "cancelled")
        assert.equal(createMessage.mock.calls.length, 1)
    })

    it.each(["explicit", "parent"] as const)("cancels the active tool signal on %s cancellation", async (source) => {
        const config = createTaskConfig(true)
        const started = deferred<void>()
        const settled = deferred<string>()
        let toolSignal: AbortSignal | undefined
        vi.mocked(ListFilesToolHandler.prototype.execute).mockImplementation((toolConfig) => {
            toolSignal = toolConfig.taskState.operationSignal
            started.resolve()
            return settled.promise
        })
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "cancellable-tool",
                tool_call: { function: { name: DlineDefaultTool.LIST_FILES, arguments: JSON.stringify({ path: "." }) } },
            }
        })
        stubSystemPrompt(true)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const runner = new SubagentRunner(config)
        const run = runner.run("Cancel active tool", () => {})
        await started.promise
        try {
            if (source === "parent") config.taskState.cancelOperations("parent_cancelled")
            else await runner.abort()
            expect(toolSignal?.aborted).toBe(true)
            // Rearming the parent must not uncancel the run that owned its old signal.
            config.taskState.resetOperationCancellation()
            settled.resolve("late tool result")
            expect((await run).status).toBe("cancelled")
        } finally {
            await runner.abort()
            settled.resolve("late tool result")
        }
        expect(createMessage).toHaveBeenCalledOnce()
    })

    it("interrupts a stalled provider when the captured parent signal is cancelled", async () => {
        const config = createTaskConfig(false)
        const started = deferred<void>()
        const released = deferred<void>()
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield { type: "usage", inputTokens: 10, outputTokens: 2, totalCost: 0.25, currency: "CNY" }
            started.resolve()
            await released.promise
            yield* []
        })
        const abort = vi.fn(() => released.resolve())
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage, 200_000, false, abort)
        initializeHostProvider()
        const runner = new SubagentRunner(config)
        const run = runner.run("Cancel pending provider", () => {})
        await started.promise
        try {
            config.taskState.cancelOperations("parent_cancelled")
            expect(abort).toHaveBeenCalled()
            const result = await run
            expect(result.status).toBe("cancelled")
            expect(result.stats.totalCost).toBe(0.25)
            expect(result.stats.currency).toBe("CNY")
        } finally {
            released.resolve()
            await runner.abort()
        }
        expect(createMessage).toHaveBeenCalledOnce()
    })

    it("keeps independent activity cancellation detached from the parent", async () => {
        const config = createTaskConfig(false)
        const started = deferred<void>()
        const released = deferred<void>()
        const createMessage = vi.fn().mockImplementation(async function* () {
            started.resolve()
            await released.promise
            yield {
                type: "tool_calls",
                function_id: "independent-completion",
                tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
            }
        })
        const abort = vi.fn()
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage, 200_000, false, abort)
        initializeHostProvider()
        const runner = new SubagentRunner(config, "independent", undefined, { inheritTaskAbort: false })
        const run = runner.run("Continue independent activity", () => {})
        await started.promise
        config.taskState.cancelOperations("parent_cancelled")
        expect(abort).not.toHaveBeenCalled()
        released.resolve()
        expect((await run).status).toBe("completed")
    })

    it("gives retries a fresh tool signal without reviving abandoned work", async () => {
        const config = createTaskConfig(true)
        const started = deferred<void>()
        const settled = deferred<string>()
        const signals: AbortSignal[] = []
        vi.mocked(ListFilesToolHandler.prototype.execute).mockImplementation((toolConfig) => {
            signals.push(toolConfig.taskState.operationSignal)
            if (signals.length === 1) {
                started.resolve()
                return settled.promise
            }
            return Promise.resolve("ok")
        })
        const createMessage = vi.fn().mockImplementation(async function* () {
            const completion = signals.length === 2
            yield {
                type: "tool_calls",
                function_id: `retry-call-${createMessage.mock.calls.length}`,
                tool_call: {
                    function: {
                        name: completion ? DlineDefaultTool.ATTEMPT : DlineDefaultTool.LIST_FILES,
                        arguments: JSON.stringify(completion ? { result: "done" } : { path: "." }),
                    },
                },
            }
        })
        stubSystemPrompt(true)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const runner = new SubagentRunner(config)
        const first = runner.run("First attempt", () => {})
        await started.promise
        await runner.abort()
        settled.resolve("late")
        expect((await first).status).toBe("cancelled")
        expect((await runner.run("Retry", () => {})).status).toBe("completed")
        expect(signals).toHaveLength(2)
        expect(signals[0]?.aborted).toBe(true)
        expect(signals[1]?.aborted).toBe(false)
        expect(signals[1]).not.toBe(signals[0])
    })

    it("stops waiting for a hung tool once the run is aborted", async () => {
        // A tool call has no cancellation channel of its own, so a tool that never
        // settles (a shared parser lock, a stuck host request) used to hold the run
        // forever: the abort flag is only polled between tool calls, and that check
        // is never reached. Cancelling must abandon the wait and report cancelled.
        const config = createTaskConfig(true)
        let toolStarted: () => void = () => undefined
        const toolHasStarted = new Promise<void>((resolve) => {
            toolStarted = resolve
        })
        vi.spyOn(ListCodeDefinitionNamesToolHandler.prototype, "execute").mockImplementation(() => {
            toolStarted()
            // Never settles: the tool is wedged.
            return new Promise<string>(() => {})
        })
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "toolu_hung_tool",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.LIST_CODE_DEF,
                        arguments: JSON.stringify({ path: "." }),
                    },
                },
            }
        })
        stubSystemPrompt(true)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const runner = new SubagentRunner(config)
        const runPromise = runner.run("Cancel a wedged tool", () => {})
        await toolHasStarted
        await runner.abort()

        const result = await Promise.race([
            runPromise,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("run did not settle after abort")), 5_000)),
        ])

        assert.equal(result.status, "cancelled")
    })

    it("uses the configured task api handler for subagent requests", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "t1",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(true)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const runner = new SubagentRunner(createTaskConfig(true))
        const result = await runner.run("List files", () => {})
        assert.equal(result.status, "completed")
        assert.equal(createMessage.mock.calls.length, 1)
    })
})
