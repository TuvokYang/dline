import { describe, expect, it } from "vitest"
import { BUILTIN_INPUT_SEMANTICS, resolveCommandTrigger } from "../catalog"
import { capabilityCommandIdentity, commandNamespaceOf, namespacedCommandTrigger } from "../command-namespace"

describe("command namespaces", () => {
    it("spells a capability's identity and trigger from one rule", () => {
        expect(capabilityCommandIdentity({ namespace: "skill", name: "lint" })).toEqual({
            id: "command.skill.lint",
            trigger: "/skills:lint",
        })
        expect(capabilityCommandIdentity({ namespace: "workflow", name: "release" })).toEqual({
            id: "command.workflow.release",
            trigger: "/workflow:release",
        })
        expect(capabilityCommandIdentity({ namespace: "mcp", server: "s", prompt: "p" })).toEqual({
            id: "command.mcp.s.p",
            trigger: "/mcp:s:p",
        })
    })

    it("reads a namespace back from the identity it produced", () => {
        expect(commandNamespaceOf(capabilityCommandIdentity({ namespace: "skill", name: "x" }).id)).toBe("skill")
        expect(commandNamespaceOf(capabilityCommandIdentity({ namespace: "workflow", name: "x" }).id)).toBe("workflow")
        expect(commandNamespaceOf(capabilityCommandIdentity({ namespace: "mcp", server: "s", prompt: "p" }).id)).toBe("mcp")
        expect(commandNamespaceOf("command.compact")).toBe("cmd")
    })

    it("spells built-in namespaced triggers the catalog admits as aliases", () => {
        const catalog = { revision: 0, descriptors: BUILTIN_INPUT_SEMANTICS }

        expect(resolveCommandTrigger(catalog, namespacedCommandTrigger("cmd", "newtask"))?.id).toBe("command.new_task")
        expect(resolveCommandTrigger(catalog, namespacedCommandTrigger("cmd", "smol"))?.id).toBe("command.compact")
    })
})
