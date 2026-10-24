import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

describe("production task observability wiring", () => {
    it("connects task turns, durable snapshots, tool spans, and native MCP resolution in composition", async () => {
        const source = await readFile(path.join(__dirname, "..", "composition", "TaskSessionCompositionService.ts"), "utf8")

        expect(source).toMatch(/new TaskTurnTelemetry\(\s*options\.taskId/u)
        expect(source).toContain("taskTelemetry.registerAlias(taskIncarnationId)")
        expect(source).toContain("observeTaskStateVault(persistence.ports.vault, taskTelemetry)")
        expect(source).toContain('taskTelemetry.committed("runtime.state.committed", state)')
        expect(source).toContain("persistence: runtimePersistence")
        expect(source).toContain("taskId: options.taskId")
        expect(source).toContain(
            "resolveMcpTool: (serverKey, toolSegment) => tool.services.mcpHub.resolveNativeTool(serverKey, toolSegment)",
        )
    })
})
