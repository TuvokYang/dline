import { strict as assert } from "node:assert"
import { DlineDefaultTool } from "@shared/tools"
import { describe, it, vi } from "vitest"
import type { ToolUse } from "../../../../assistant-message"
import { DefaultToolHandlerState } from "../../state/ToolHandlerState"
import type { TaskConfig } from "../../types/TaskConfig"
import { AttemptCompletionHandler } from "../AttemptCompletionHandler"

/**
 * Create a minimal task config for attempt_completion behavior tests.
 * @param taskState Mutable task state used by the handler.
 * @returns TaskConfig with mocked callbacks and services.
 */
function createConfig(
    taskState: DefaultToolHandlerState,
    outcome: { actionId: "reply" | "start_new_task"; text?: string } = { actionId: "start_new_task" },
): TaskConfig {
    const clineMessages: Array<{ type: "say"; say: string; text?: string; ts: number }> = []
    return {
        taskId: "task-1",
        ulid: "ulid-1",
        cwd: "e:\\workspace\\vscode\\dline",
        mode: "act",
        strictPlanModeEnabled: false,
        yoloModeToggled: false,
        doubleCheckCompletionEnabled: false,
        vscodeTerminalExecutionMode: "backgroundExec",
        enableParallelToolCalling: false,
        isSubagentExecution: false,
        taskState,
        interactions: {
            open: vi.fn(async () => ({
                actionId: outcome.actionId,
                draft: { text: outcome.text ?? "", images: [], files: [] },
            })),
            complete: vi.fn(async () => ({
                actionId: outcome.actionId,
                draft: { text: outcome.text ?? "", images: [], files: [] },
            })),
            say: vi.fn(async () => undefined),
        },
        messageState: {
            clineMessages,
            updateClineMessage: vi.fn().mockResolvedValue(undefined),
        } as unknown as TaskConfig["messageState"],
        api: {
            getModel: () => ({ id: "test-model", info: { supportsImages: false } }),
        } as unknown as TaskConfig["api"],
        autoApprovalSettings: { enableNotifications: false } as unknown as TaskConfig["autoApprovalSettings"],
        browserSettings: {} as unknown as TaskConfig["browserSettings"],
        focusChainSettings: { enabled: false } as unknown as TaskConfig["focusChainSettings"],
        services: {
            stateManager: {
                getGlobalSettingsKey: (key: string) => (key === "hooksEnabled" ? false : undefined),
                getApiConfiguration: () => ({ planModeProfile: "openai", actModeProfile: "openai" }),
            } as unknown,
        } as unknown as TaskConfig["services"],
        coordinator: {} as TaskConfig["coordinator"],
        identityFactory: {
            /** Return a stable result item identity for this fixture. */
            nextItemId: () => "dline_item_attempt_completion_test",
            /** Return a stable trace identity for this fixture. */
            nextTraceId: () => "dline_tid_attempt_completion_test",
        },
        callbacks: {
            say: vi.fn(async (type: string, text?: string) => {
                clineMessages.push({ type: "say", say: type, text, ts: Date.now() })
                return Date.now()
            }),
            ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
            saveCheckpoint: vi.fn().mockResolvedValue(undefined),
            doesLatestTaskCompletionHaveNewChanges: vi.fn().mockResolvedValue(false),
            updateFCListFromToolResponse: vi.fn().mockResolvedValue(undefined),
            runUserPromptSubmitHook: vi.fn().mockResolvedValue({}),
        } as unknown as TaskConfig["callbacks"],
    } as unknown as TaskConfig
}

/**
 * Create an attempt_completion tool block for handler execution.
 * @returns Complete attempt_completion tool block.
 */
function createBlock(): ToolUse {
    return {
        type: "tool_use",
        function_id: "completion-function-1",
        name: DlineDefaultTool.ATTEMPT,
        params: { result: "done" },
        partial: false,
        ts: 123,
        dline_tid: "completion-1",
    } as ToolUse
}

/** Hold the completion checkpoint until the returned release is called. */
function holdCheckpoint(config: TaskConfig): () => void {
    const saveCheckpoint = config.callbacks.saveCheckpoint
    if (!saveCheckpoint) throw new Error("The fixture saves checkpoints")
    let release = () => {}
    vi.mocked(saveCheckpoint).mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))
    return () => release()
}

describe("AttemptCompletionHandler stop behavior", () => {
    it("returns terminal completion when the runtime starts a new task", async () => {
        const taskState = new DefaultToolHandlerState()
        const config = createConfig(taskState)
        const handler = new AttemptCompletionHandler()

        const result = await handler.execute(config, createBlock())

        assert.equal(result, "[attempt_completion] Result: Done")
    })

    it("leaves task_progress updates to the central executor", async () => {
        const taskState = new DefaultToolHandlerState()
        const config = createConfig(taskState)
        config.focusChainSettings = { enabled: true } as TaskConfig["focusChainSettings"]
        const block = createBlock()
        block.params.task_progress = "- [x] Verify result"

        await new AttemptCompletionHandler().execute(config, block)

        expect(config.callbacks.updateFCListFromToolResponse).not.toHaveBeenCalled()
    })

    it("refuses completion while the Focus Chain checklist has unchecked items", async () => {
        const taskState = new DefaultToolHandlerState()
        taskState.currentFocusChainChecklist = "# Plan\n- [x] Inspect\n- [ ] Verify"
        const config = createConfig(taskState)
        config.focusChainSettings = { enabled: true } as TaskConfig["focusChainSettings"]

        const result = await new AttemptCompletionHandler().execute(config, createBlock())

        assert.equal(typeof result, "string")
        assert.match(result as string, /ATTEMPT_COMPLETION BLOCKED/)
        assert.match(result as string, /Current checklist:\n# Plan\n- \[x\] Inspect\n- \[ \] Verify/)
        assert.equal(taskState.consecutiveMistakeCount, 1)
        // The refused call must settle the streamed preview at its original identity.
        expect(config.callbacks.say).toHaveBeenCalledWith("completion_result", "", undefined, undefined, false, 123)
    })

    it("completes once every checklist item is checked", async () => {
        const taskState = new DefaultToolHandlerState()
        taskState.currentFocusChainChecklist = "# Plan\n- [x] Inspect\n- [x] Verify"
        const config = createConfig(taskState)
        config.focusChainSettings = { enabled: true } as TaskConfig["focusChainSettings"]

        const result = await new AttemptCompletionHandler().execute(config, createBlock())

        assert.equal(result, "[attempt_completion] Result: Done")
    })

    it("does not gate completion when the Focus Chain is disabled or the call is a subagent's", async () => {
        for (const [enabled, isSubagentExecution] of [
            [false, false],
            [true, true],
        ] as const) {
            const taskState = new DefaultToolHandlerState()
            taskState.currentFocusChainChecklist = "# Plan\n- [ ] Verify"
            const config = createConfig(taskState)
            config.focusChainSettings = { enabled } as TaskConfig["focusChainSettings"]
            config.isSubagentExecution = isSubagentExecution

            const result = await new AttemptCompletionHandler().execute(config, createBlock())

            assert.equal(result, "[attempt_completion] Result: Done")
        }
    })

    // Input queued while the model worked is delivered when this dialog opens;
    // waiting for the checkpoint first left it unsent for the whole commit.
    it("opens the dialog before the checkpoint settles and goes on only after it", async () => {
        const config = createConfig(new DefaultToolHandlerState(), { actionId: "reply", text: "next" })
        const releaseCheckpoint = holdCheckpoint(config)
        let settled = false

        const execution = new AttemptCompletionHandler().execute(config, createBlock()).then((result) => {
            settled = true
            return result
        })
        await vi.waitFor(() => expect(config.interactions.complete).toHaveBeenCalledOnce())
        await new Promise((resolve) => setTimeout(resolve, 0))

        // Answered already, but the round that answer starts waits for the checkpoint.
        expect(settled).toBe(false)
        expect(config.callbacks.doesLatestTaskCompletionHaveNewChanges).not.toHaveBeenCalled()
        releaseCheckpoint()
        await execution
        expect(config.callbacks.doesLatestTaskCompletionHaveNewChanges).toHaveBeenCalledOnce()
    })

    it("lets the checkpoint finish when a stop ends the dialog", async () => {
        const config = createConfig(new DefaultToolHandlerState())
        const releaseCheckpoint = holdCheckpoint(config)
        vi.mocked(config.interactions.complete).mockRejectedValue(new Error("stopped"))
        let rejected = false

        const execution = new AttemptCompletionHandler().execute(config, createBlock()).catch((error: unknown) => {
            rejected = true
            throw error
        })
        await vi.waitFor(() => expect(config.interactions.complete).toHaveBeenCalledOnce())
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(rejected).toBe(false)
        releaseCheckpoint()
        await expect(execution).rejects.toThrow("stopped")
    })

    it("returns completion feedback when the user replies", async () => {
        const taskState = new DefaultToolHandlerState()
        const config = createConfig(taskState, { actionId: "reply", text: "Please refine the result" })
        const handler = new AttemptCompletionHandler()

        const result = await handler.execute(config, createBlock())

        assert.deepEqual(result, [
            { type: "text", text: "[attempt_completion] Result: Done" },
            {
                type: "text",
                text: "The user has provided feedback on the results. Consider their input to continue the task, and then attempt completion again.",
            },
            { type: "text", text: "<feedback>\nPlease refine the result\n</feedback>" },
        ])
    })
})
