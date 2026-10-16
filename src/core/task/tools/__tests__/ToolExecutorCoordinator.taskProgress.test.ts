import type { ToolUse } from "@core/assistant-message"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { TaskTurnAuthority } from "../../explicit-instructions/TurnAuthority"
import type { IToolHandler } from "../ToolExecutorCoordinator"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"

function block(name: DlineDefaultTool, params: ToolUse["params"] = {}): ToolUse {
    return { type: "tool_use", name, params, partial: false } as ToolUse
}

/** A handler that records when it ran, so ordering against the report is observable. */
function orderedHandler(name: DlineDefaultTool, log: string[]) {
    const handler: IToolHandler = {
        name,
        getDescription: () => `[${name}]`,
        execute: async () => {
            log.push("handler")
            return "done"
        },
    }
    return handler
}

function harness(name: DlineDefaultTool) {
    const log: string[] = []
    const updateFCListFromToolResponse = vi.fn(async () => {
        log.push("report")
    })
    const saveCheckpoint = vi.fn(async () => {})
    const awaitRoundCheckpointBeforeMutation = vi.fn(async () => {})
    const coordinator = new ToolExecutorCoordinator()
    coordinator.register(orderedHandler(name, log))
    const config = {
        callbacks: { updateFCListFromToolResponse, saveCheckpoint, awaitRoundCheckpointBeforeMutation },
    } as unknown as TaskConfig
    return {
        coordinator,
        config,
        updateFCListFromToolResponse,
        saveCheckpoint,
        awaitRoundCheckpointBeforeMutation,
        log,
    }
}

describe("ToolExecutorCoordinator task_progress", () => {
    it("applies the checklist a tool call carries", async () => {
        const { coordinator, config, updateFCListFromToolResponse } = harness(DlineDefaultTool.LIST_FILES)

        await coordinator.execute(config, block(DlineDefaultTool.LIST_FILES, { task_progress: "- [ ] Inspect the tree" }))

        expect(updateFCListFromToolResponse).toHaveBeenCalledWith("- [ ] Inspect the tree")
    })

    // The parameter rides on every tool, so the central path must not be tied to
    // one family of tools.
    it.each([
        DlineDefaultTool.FILE_EDIT,
        DlineDefaultTool.MCP_USE,
        DlineDefaultTool.ATTEMPT,
    ])("applies it for %s as well", async (tool) => {
        const { coordinator, config, updateFCListFromToolResponse } = harness(tool)

        await coordinator.execute(config, block(tool, { task_progress: "- [x] Done" }))

        expect(updateFCListFromToolResponse).toHaveBeenCalledWith("- [x] Done")
    })

    // Chat rows are ordered by a presentation id, and the tool's own row was
    // numbered when the call was planned while this row takes a fresh id. A
    // report emitted first therefore carries a lower id than the row that
    // follows it, and the list stops rendering at that point.
    it("reports after the handler, so the rows stay in order", async () => {
        const { coordinator, config, log } = harness(DlineDefaultTool.LIST_FILES)

        await coordinator.execute(config, block(DlineDefaultTool.LIST_FILES, { task_progress: "- [ ] First" }))

        expect(log).toEqual(["handler", "report"])
    })

    it.each([undefined, "", "   \n\t"])("treats %j as carrying no checklist", async (progress) => {
        const { coordinator, config, updateFCListFromToolResponse } = harness(DlineDefaultTool.LIST_FILES)

        await coordinator.execute(
            config,
            block(DlineDefaultTool.LIST_FILES, progress === undefined ? {} : { task_progress: progress }),
        )

        expect(updateFCListFromToolResponse).not.toHaveBeenCalled()
    })

    it("still runs the handler when applying the checklist fails", async () => {
        const log: string[] = []
        const coordinator = new ToolExecutorCoordinator()
        coordinator.register(orderedHandler(DlineDefaultTool.LIST_FILES, log))
        const config = {
            callbacks: {
                updateFCListFromToolResponse: vi.fn(async () => {
                    throw new Error("focus chain unavailable")
                }),
            },
        } as unknown as TaskConfig

        // Progress reporting is bookkeeping beside the call, not a precondition
        // for it. Letting the failure escape would turn an unwritable checklist
        // into a refused tool.
        await expect(
            coordinator.execute(config, block(DlineDefaultTool.LIST_FILES, { task_progress: "- [ ] First" })),
        ).resolves.toBe("done")
        expect(log).toEqual(["handler"])
    })
})

describe("ToolExecutorCoordinator checkpoint ownership", () => {
    it.each([
        DlineDefaultTool.FILE_NEW,
        DlineDefaultTool.FILE_EDIT,
        DlineDefaultTool.APPLY_PATCH,
        DlineDefaultTool.REPLACE_TEXT,
        DlineDefaultTool.RENAME,
    ])("waits for the admitted round baseline before %s without creating a tool-local checkpoint", async (tool) => {
        const { coordinator, config, saveCheckpoint, awaitRoundCheckpointBeforeMutation, log } = harness(tool)

        await coordinator.execute(config, block(tool))

        expect(awaitRoundCheckpointBeforeMutation).toHaveBeenCalledOnce()
        expect(log).toEqual(["handler"])
        expect(saveCheckpoint).not.toHaveBeenCalled()
    })

    it("waits before an explicitly authorized new_rule mutation", async () => {
        const { coordinator, config, awaitRoundCheckpointBeforeMutation, log } = harness(DlineDefaultTool.NEW_RULE)
        const authority = new TaskTurnAuthority()
        authority.grant("turn-1", [{ type: "new_rule", source: "slash_command", targetTool: DlineDefaultTool.NEW_RULE }])
        config.explicitInstructions = authority.read("turn-1")

        await coordinator.execute(config, block(DlineDefaultTool.NEW_RULE))

        expect(awaitRoundCheckpointBeforeMutation).toHaveBeenCalledOnce()
        expect(log).toEqual(["handler"])
    })

    it("does not enter a file barrier for a non-mutating tool", async () => {
        const { coordinator, config, awaitRoundCheckpointBeforeMutation, log } = harness(DlineDefaultTool.LIST_FILES)

        await coordinator.execute(config, block(DlineDefaultTool.LIST_FILES))

        expect(awaitRoundCheckpointBeforeMutation).not.toHaveBeenCalled()
        expect(log).toEqual(["handler"])
    })

    it.each([DlineDefaultTool.REPLACE_TEXT, DlineDefaultTool.RENAME])("does not wait for a dry-run %s", async (tool) => {
        const { coordinator, config, awaitRoundCheckpointBeforeMutation } = harness(tool)

        await coordinator.execute(config, block(tool, { dry_run: "true" }))

        expect(awaitRoundCheckpointBeforeMutation).not.toHaveBeenCalled()
    })

    it("does not let a degraded checkpoint barrier block the admitted file mutation", async () => {
        const { coordinator, config, awaitRoundCheckpointBeforeMutation, log } = harness(DlineDefaultTool.FILE_NEW)
        awaitRoundCheckpointBeforeMutation.mockRejectedValueOnce(new Error("checkpoint unavailable"))

        await expect(coordinator.execute(config, block(DlineDefaultTool.FILE_NEW))).resolves.toBe("done")

        expect(log).toEqual(["handler"])
    })

    it("does not start the handler until the existing round checkpoint settles", async () => {
        const { coordinator, config, awaitRoundCheckpointBeforeMutation, log } = harness(DlineDefaultTool.FILE_EDIT)
        let release!: () => void
        awaitRoundCheckpointBeforeMutation.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))

        const execution = coordinator.execute(config, block(DlineDefaultTool.FILE_EDIT))
        await vi.waitFor(() => expect(release).toBeDefined())
        expect(log).toEqual([])

        release()
        await execution
        expect(log).toEqual(["handler"])
    })
})
