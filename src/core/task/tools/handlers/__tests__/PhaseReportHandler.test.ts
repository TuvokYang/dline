import { describe, expect, it, vi } from "vitest"
import { DlineDefaultTool } from "@/shared/tools"
import { PhaseReportHandler } from "../PhaseReportHandler"

/**
 * Create a minimal task config for phase report handler tests.
 * @param lastToolName The previous tool the task recorded.
 * @returns TaskConfig-compatible test double.
 */
function createConfig(lastToolName = "read_file") {
    return {
        taskState: {
            consecutiveMistakeCount: 0,
            lastToolName,
        },
        interactions: {
            open: vi.fn(),
            say: vi.fn(async () => undefined),
        },
        callbacks: {
            ask: vi.fn(),
            say: vi.fn(async () => undefined),
            sayAndCreateMissingParamError: vi.fn(async () => "missing response"),
        },
    } as any
}

const reportRow = (content: string) => JSON.stringify({ tool: "statusUpdate", content })

describe("PhaseReportHandler", () => {
    const handler = new PhaseReportHandler()

    it("streams a report with the same tool row shape as its final presentation", async () => {
        const say = vi.fn(async () => undefined)

        await handler.handlePartialBlock(
            { name: DlineDefaultTool.PHASE_REPORT, ts: 101, params: { response: "Still working" } } as any,
            { removeClosingTag: () => "Still working", say } as any,
        )

        expect(say).toHaveBeenCalledWith("tool", reportRow("Still working"), undefined, undefined, true, 101)
    })

    it("displays the report and continues without waiting for the user", async () => {
        const config = createConfig()

        const result = await handler.execute(config, {
            name: DlineDefaultTool.PHASE_REPORT,
            ts: 102,
            params: { response: "Phase one done" },
        } as any)

        expect(config.interactions.say).toHaveBeenCalledWith({
            taskSay: "tool",
            presentation: reportRow("Phase one done"),
            existingTs: 102,
        })
        expect(config.interactions.open).not.toHaveBeenCalled()
        expect(String(result)).toContain("[Message displayed.")
    })

    // Recorded calls and models that still send the retired parameter must never block the run.
    it("ignores requires_acknowledgment from a call written for an earlier version", async () => {
        const config = createConfig()
        const say = vi.fn(async () => undefined)
        const block = {
            name: DlineDefaultTool.PHASE_REPORT,
            ts: 103,
            params: { response: "Please confirm", requires_acknowledgment: "true" },
        } as any

        await handler.handlePartialBlock(block, { removeClosingTag: () => "Please confirm", say } as any)
        const result = await handler.execute(config, block)

        expect(say).toHaveBeenCalledWith("tool", reportRow("Please confirm"), undefined, undefined, true, 103)
        expect(config.interactions.open).not.toHaveBeenCalled()
        expect(config.callbacks.ask).not.toHaveBeenCalled()
        expect(config.interactions.say).toHaveBeenCalledWith(
            expect.objectContaining({ presentation: reportRow("Please confirm") }),
        )
        expect(String(result)).toContain("[Message displayed.")
    })

    it.each([
        DlineDefaultTool.PHASE_REPORT,
        DlineDefaultTool.LEGACY_STATUS_UPDATE,
    ])("blocks a report that directly follows %s", async (previous) => {
        const config = createConfig(previous)

        const result = await handler.execute(config, {
            name: DlineDefaultTool.PHASE_REPORT,
            params: { response: "Again" },
        } as any)

        expect(String(result)).toContain("[BLOCKED]")
        expect(config.interactions.say).not.toHaveBeenCalled()
    })
})
