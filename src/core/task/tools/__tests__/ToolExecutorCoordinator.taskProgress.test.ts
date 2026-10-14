import type { ToolUse } from "@core/assistant-message"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import type { IToolHandler } from "../ToolExecutorCoordinator"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import { NO_TOOL_RESULT } from "../utils/ToolResultUtils"

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
    const ensurePreEditCheckpoint = vi.fn(async () => {
        log.push("checkpoint")
    })
    const saveCheckpoint = vi.fn(async () => {})
    const coordinator = new ToolExecutorCoordinator()
    coordinator.register(orderedHandler(name, log))
    const config = {
        callbacks: { updateFCListFromToolResponse, ensurePreEditCheckpoint, saveCheckpoint },
    } as unknown as TaskConfig
    return { coordinator, config, updateFCListFromToolResponse, ensurePreEditCheckpoint, saveCheckpoint, log }
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
                ensurePreEditCheckpoint: vi.fn(async () => {}),
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

describe("ToolExecutorCoordinator pre-edit checkpoint", () => {
    it.each([
        DlineDefaultTool.FILE_NEW,
        DlineDefaultTool.FILE_EDIT,
        DlineDefaultTool.APPLY_PATCH,
        DlineDefaultTool.REPLACE_TEXT,
        DlineDefaultTool.RENAME,
    ])("adds the file restore point before %s runs", async (tool) => {
        const { coordinator, config, saveCheckpoint, log } = harness(tool)

        await coordinator.execute(config, block(tool))

        // Before, not after: the restore point holds the files as they were
        // before this edit, so the user can undo exactly this step.
        expect(log).toEqual(["checkpoint", "handler"])
        expect(saveCheckpoint).not.toHaveBeenCalled()
    })

    // Whatever else a tool changes is covered by the round checkpoint the next
    // provider request adds, so no other tool owes a restore point of its own.
    it.each([
        DlineDefaultTool.BASH,
        DlineDefaultTool.MCP_USE,
        DlineDefaultTool.MCP_ACCESS,
        DlineDefaultTool.LIST_FILES,
        DlineDefaultTool.FILE_READ,
        DlineDefaultTool.ATTEMPT,
        DlineDefaultTool.QNA_RESPOND,
    ])("adds no restore point around %s", async (tool) => {
        const { coordinator, config, ensurePreEditCheckpoint, saveCheckpoint, log } = harness(tool)

        await coordinator.execute(config, block(tool))

        expect(log).toEqual(["handler"])
        expect(ensurePreEditCheckpoint).not.toHaveBeenCalled()
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

    it("still runs the edit when its restore point cannot be added", async () => {
        const log: string[] = []
        const coordinator = new ToolExecutorCoordinator()
        coordinator.register(orderedHandler(DlineDefaultTool.FILE_EDIT, log))
        const config = {
            callbacks: {
                updateFCListFromToolResponse: vi.fn(async () => {}),
                ensurePreEditCheckpoint: vi.fn(async () => {
                    throw new Error("shadow git unavailable")
                }),
            },
        } as unknown as TaskConfig

        // A checkpoint is a side feature of the task: losing one never refuses the edit.
        await expect(coordinator.execute(config, block(DlineDefaultTool.FILE_EDIT))).resolves.toBe("done")
        expect(log).toEqual(["handler"])
    })

    it("ends the call without editing when the task stops while its restore point waits", async () => {
        const log: string[] = []
        const coordinator = new ToolExecutorCoordinator()
        coordinator.register(orderedHandler(DlineDefaultTool.FILE_EDIT, log))
        const operation = new AbortController()
        // Stands in for a restore point queued behind another commit: the wait
        // gives up only when the task's own operation signal aborts.
        const ensurePreEditCheckpoint = vi.fn(
            (signal?: AbortSignal) =>
                new Promise<void>((_resolve, reject) => {
                    signal?.addEventListener("abort", () => reject(new Error("checkpoint wait aborted")), { once: true })
                }),
        )
        const config = {
            callbacks: { updateFCListFromToolResponse: vi.fn(async () => {}), ensurePreEditCheckpoint },
            taskState: { operationSignal: operation.signal },
        } as unknown as TaskConfig

        const call = coordinator.execute(config, block(DlineDefaultTool.FILE_EDIT))
        await vi.waitFor(() => expect(ensurePreEditCheckpoint).toHaveBeenCalledWith(operation.signal))
        operation.abort()

        await expect(call).resolves.toBe(NO_TOOL_RESULT)
        expect(log).toEqual([])
    })
})
