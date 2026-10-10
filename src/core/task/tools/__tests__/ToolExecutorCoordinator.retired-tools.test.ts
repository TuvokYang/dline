import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"

/** Minimal validator substitute for registration-only coordinator tests. */
const validator = {} as never

describe("ToolExecutorCoordinator retired tools", () => {
    it("does not register condense as an executable handler", () => {
        const coordinator = new ToolExecutorCoordinator()

        coordinator.registerByName(ClineDefaultTool.CONDENSE, validator)

        expect(coordinator.has(ClineDefaultTool.CONDENSE)).toBe(false)
    })
})
