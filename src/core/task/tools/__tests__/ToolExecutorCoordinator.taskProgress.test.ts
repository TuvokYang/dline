import type { ToolUse } from "@core/assistant-message"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
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
    const saveCheckpoint = vi.fn(async () => {
        log.push("checkpoint")
    })
    const coordinator = new ToolExecutorCoordinator()
    coordinator.register(orderedHandler(name, log))
    const config = { callbacks: { updateFCListFromToolResponse, saveCheckpoint } } as unknown as TaskConfig
    return { coordinator, config, updateFCListFromToolResponse, saveCheckpoint, log }
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
                saveCheckpoint: vi.fn(async () => {}),
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

describe("ToolExecutorCoordinator checkpoint commit", () => {
    it("commits a restore point after a tool that may have changed the workspace", async () => {
        const { coordinator, config, saveCheckpoint, log } = harness(DlineDefaultTool.FILE_EDIT)

        await coordinator.execute(config, block(DlineDefaultTool.FILE_EDIT))

        // After, not before: the restore point must capture the state the call
        // produced, and a checkpoint taken first would record the state the user
        // already had.
        expect(log).toEqual(["handler", "checkpoint"])
        expect(saveCheckpoint).toHaveBeenCalledWith()
    })

    it.each([
        DlineDefaultTool.BASH,
        DlineDefaultTool.MCP_USE,
        DlineDefaultTool.APPLY_PATCH,
    ])("commits per call for %s when the surface has no round boundary", async (tool) => {
        const { coordinator, config, saveCheckpoint } = harness(tool)

        await coordinator.execute(config, block(tool))

        // Without a round to settle the debt, deferring would leave the change
        // without any restore point at all.
        expect(saveCheckpoint).toHaveBeenCalledOnce()
    })

    it.each([
        DlineDefaultTool.BASH,
        DlineDefaultTool.MCP_USE,
        DlineDefaultTool.MCP_ACCESS,
    ])("defers %s to the round's single restore point", async (tool) => {
        const log: string[] = []
        const coordinator = new ToolExecutorCoordinator()
        coordinator.register(orderedHandler(tool, log))
        const saveCheckpoint = vi.fn(async () => {})
        const deferCheckpoint = vi.fn(() => {
            log.push("deferred")
        })
        const config = { callbacks: { saveCheckpoint, deferCheckpoint } } as unknown as TaskConfig

        await coordinator.execute(config, block(tool))

        expect(log).toEqual(["handler", "deferred"])
        expect(saveCheckpoint).not.toHaveBeenCalled()
    })

    it.each([
        DlineDefaultTool.FILE_NEW,
        DlineDefaultTool.FILE_EDIT,
        DlineDefaultTool.APPLY_PATCH,
    ])("still commits %s per call when the round can settle a debt", async (tool) => {
        const coordinator = new ToolExecutorCoordinator()
        coordinator.register(orderedHandler(tool, []))
        const saveCheckpoint = vi.fn(async () => {})
        const deferCheckpoint = vi.fn()
        const config = { callbacks: { saveCheckpoint, deferCheckpoint } } as unknown as TaskConfig

        await coordinator.execute(config, block(tool))

        expect(saveCheckpoint).toHaveBeenCalledOnce()
        expect(deferCheckpoint).not.toHaveBeenCalled()
    })

    it.each([
        DlineDefaultTool.LIST_FILES,
        DlineDefaultTool.FILE_READ,
        DlineDefaultTool.SEARCH,
    ])("skips %s, which leaves nothing to restore", async (tool) => {
        const { coordinator, config, saveCheckpoint } = harness(tool)

        await coordinator.execute(config, block(tool))

        expect(saveCheckpoint).not.toHaveBeenCalled()
    })

    // attempt_completion commits against the completion row it publishes itself.
    // Committing here as well would attach a second checkpoint to the same state.
    it.each([
        DlineDefaultTool.ATTEMPT,
        DlineDefaultTool.QNA_RESPOND,
        DlineDefaultTool.MAKE_PLAN,
    ])("leaves %s to its own completion checkpoint", async (tool) => {
        const { coordinator, config, saveCheckpoint } = harness(tool)

        await coordinator.execute(config, block(tool))

        expect(saveCheckpoint).not.toHaveBeenCalled()
    })

    it("runs a tool on a surface that has neither capability", async () => {
        // The shape a headless task presents: a title generator, reviewer, or
        // approver has no checklist and no workspace history, and must not have
        // to supply stubs for effects it does not have.
        const log: string[] = []
        const coordinator = new ToolExecutorCoordinator()
        coordinator.register(orderedHandler(DlineDefaultTool.FILE_EDIT, log))
        const config = { callbacks: {} } as unknown as TaskConfig

        await expect(
            coordinator.execute(config, block(DlineDefaultTool.FILE_EDIT, { task_progress: "- [ ] ignored" })),
        ).resolves.toBe("done")
        expect(log).toEqual(["handler"])
    })

    it("returns the handler's result when the checkpoint cannot be saved", async () => {
        const coordinator = new ToolExecutorCoordinator()
        coordinator.register(orderedHandler(DlineDefaultTool.FILE_EDIT, []))
        const config = {
            callbacks: {
                updateFCListFromToolResponse: vi.fn(async () => {}),
                saveCheckpoint: vi.fn(async () => {
                    throw new Error("shadow git unavailable")
                }),
            },
        } as unknown as TaskConfig

        await expect(coordinator.execute(config, block(DlineDefaultTool.FILE_EDIT))).resolves.toBe("done")
    })
})
