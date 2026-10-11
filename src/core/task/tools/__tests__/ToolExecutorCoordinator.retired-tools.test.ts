import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"

/** Minimal validator substitute for registration-only coordinator tests. */
const validator = {} as never

describe("ToolExecutorCoordinator retired tools", () => {
    it("does not register condense as an executable handler", () => {
        const coordinator = new ToolExecutorCoordinator()

        coordinator.registerByName(DlineDefaultTool.CONDENSE, validator)

        expect(coordinator.has(DlineDefaultTool.CONDENSE)).toBe(false)
    })

    it("routes recorded calls under former names to the renamed tools without registering the former names", () => {
        const coordinator = new ToolExecutorCoordinator()

        coordinator.registerByName(DlineDefaultTool.LEGACY_ACT_MODE_RESPOND, validator)
        coordinator.registerByName(DlineDefaultTool.LEGACY_STATUS_UPDATE, validator)
        expect(coordinator.has(DlineDefaultTool.LEGACY_ACT_MODE_RESPOND)).toBe(false)
        expect(coordinator.has(DlineDefaultTool.LEGACY_STATUS_UPDATE)).toBe(false)

        coordinator.registerByName(DlineDefaultTool.WORKING_RESPOND, validator)
        coordinator.registerByName(DlineDefaultTool.PHASE_REPORT, validator)

        expect(coordinator.getRegisteredToolNames()).toEqual([DlineDefaultTool.WORKING_RESPOND, DlineDefaultTool.PHASE_REPORT])
        expect(coordinator.getHandler(DlineDefaultTool.LEGACY_ACT_MODE_RESPOND)?.name).toBe(DlineDefaultTool.WORKING_RESPOND)
        expect(coordinator.getHandler(DlineDefaultTool.LEGACY_STATUS_UPDATE)?.name).toBe(DlineDefaultTool.PHASE_REPORT)
    })
})
