import { describe, expect, it } from "vitest"
import {
    createTaskCapabilityToggles,
    parseTaskCapabilityToggles,
    reconcileTaskCapabilityToggles,
    serializeTaskCapabilityToggles,
    updateTaskCapabilityToggle,
} from "../TaskCapabilityToggles"

describe("TaskCapabilityToggles", () => {
    it("normalizes and serializes a complete stable snapshot", () => {
        const serialized = serializeTaskCapabilityToggles({
            localSkillsToggles: { zed: false, alpha: true },
        })
        const parsed = parseTaskCapabilityToggles(serialized)

        expect(parsed?.localSkillsToggles).toEqual({ alpha: true, zed: false })
        expect(parsed?.mcpServers).toEqual({})
    })

    it("preserves existing choices and temporarily undiscovered entries while adding discoveries", () => {
        const current = createTaskCapabilityToggles({
            localSkillsToggles: { kept: false, removed: true },
            mcpServers: { existing: false },
        })
        const reconciled = reconcileTaskCapabilityToggles(current, {
            localSkillsToggles: { kept: true, added: true },
            mcpServers: { existing: true, added: false },
        })

        expect(reconciled.localSkillsToggles).toEqual({ kept: false, removed: true, added: true })
        expect(reconciled.mcpServers).toEqual({ existing: false, added: false })
    })

    it("updates one map without mutating the source snapshot", () => {
        const source = createTaskCapabilityToggles({ localWorkflowToggles: { workflow: true } })
        const updated = updateTaskCapabilityToggle(source, "localWorkflowToggles", "workflow", false)

        expect(source.localWorkflowToggles.workflow).toBe(true)
        expect(updated.localWorkflowToggles.workflow).toBe(false)
    })
})
