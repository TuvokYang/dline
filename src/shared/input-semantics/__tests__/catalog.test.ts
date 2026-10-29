import { describe, expect, it } from "vitest"
import {
    admitDescriptors,
    authorizedTools,
    BUILTIN_INPUT_SEMANTICS,
    establishesLifecycleBarrier,
    findDescriptor,
    type InputSemanticCatalog,
    isCommandTrigger,
    resolveCommandTrigger,
    validateComposition,
} from "../catalog"

function catalog(revision = 1): InputSemanticCatalog {
    return { revision, descriptors: BUILTIN_INPUT_SEMANTICS }
}

describe("admitDescriptors", () => {
    const skill = (id: string, trigger: string, aliases?: string[]) => ({
        id,
        kind: "command" as const,
        trigger,
        ...(aliases ? { aliases } : {}),
        payload: "text" as const,
        composition: "combinable" as const,
        lifecycle: "turn" as const,
        dynamic: true,
    })

    it("admits every built-in descriptor without conflict", () => {
        expect(admitDescriptors(BUILTIN_INPUT_SEMANTICS)).toEqual({ descriptors: BUILTIN_INPUT_SEMANTICS, conflicts: [] })
    })

    it("refuses a later descriptor whose trigger or alias is already taken, keeping the earlier one", () => {
        const admitted = admitDescriptors([
            ...BUILTIN_INPUT_SEMANTICS,
            skill("command.skill.shadow", "/skills:shadow", ["/smol"]),
            skill("command.skill.compact", "/compact"),
        ])

        expect(admitted.descriptors).toEqual(BUILTIN_INPUT_SEMANTICS)
        expect(admitted.conflicts).toEqual([
            { code: "duplicate_trigger", descriptorId: "command.skill.shadow", heldBy: "command.compact", trigger: "/smol" },
            { code: "duplicate_trigger", descriptorId: "command.skill.compact", heldBy: "command.compact", trigger: "/compact" },
        ])
    })

    it("refuses a repeated identity and matches triggers case-sensitively", () => {
        const admitted = admitDescriptors([
            skill("command.skill.a", "/skills:a"),
            skill("command.skill.a", "/skills:other"),
            skill("command.skill.upper", "/Skills:a"),
        ])

        expect(admitted.descriptors.map((descriptor) => descriptor.id)).toEqual(["command.skill.a", "command.skill.upper"])
        expect(admitted.conflicts.map((conflict) => conflict.code)).toEqual(["duplicate_id"])
    })

    it("refuses a capability whose trigger the scanner could never recognize", () => {
        const admitted = admitDescriptors([
            skill("command.skill.spaced", "/skills:my skill"),
            skill("command.mcp.punct", "/mcp:server:prompt!"),
            skill("command.skill.alias", "/skills:ok", ["/skills:bad alias"]),
            skill("command.skill.ok", "/skills:ok"),
        ])

        expect(admitted.descriptors.map((descriptor) => descriptor.id)).toEqual(["command.skill.ok"])
        expect(admitted.conflicts).toEqual([
            { code: "invalid_trigger", descriptorId: "command.skill.spaced", trigger: "/skills:my skill" },
            { code: "invalid_trigger", descriptorId: "command.mcp.punct", trigger: "/mcp:server:prompt!" },
            { code: "invalid_trigger", descriptorId: "command.skill.alias", trigger: "/skills:bad alias" },
        ])
    })
})

describe("command trigger grammar", () => {
    it("accepts exactly one command token", () => {
        expect(isCommandTrigger("/compact")).toBe(true)
        expect(isCommandTrigger("/mcp:server-1:prompt.v2")).toBe(true)
        expect(isCommandTrigger("compact")).toBe(false)
        expect(isCommandTrigger("/")).toBe(false)
        expect(isCommandTrigger("/a b")).toBe(false)
        expect(isCommandTrigger("/a/b")).toBe(false)
    })

    it("resolves a trigger or alias case-sensitively", () => {
        expect(resolveCommandTrigger(catalog(), "/smol")?.id).toBe("command.compact")
        expect(resolveCommandTrigger(catalog(), "/cmd:newtask")?.id).toBe("command.new_task")
        expect(resolveCommandTrigger(catalog(), "/reportbug")?.id).toBe("command.report_bug")
        expect(resolveCommandTrigger(catalog(), "/cmd:reportbug")?.id).toBe("command.report_bug")
        expect(resolveCommandTrigger(catalog(), "/Compact")).toBeUndefined()
        expect(resolveCommandTrigger(catalog(), "@problems")).toBeUndefined()
    })
})

describe("input semantic catalog", () => {
    it("keeps every descriptor identity unique and free of user-facing text", () => {
        const ids = BUILTIN_INPUT_SEMANTICS.map((descriptor) => descriptor.id)
        expect(new Set(ids).size).toBe(ids.length)
        for (const descriptor of BUILTIN_INPUT_SEMANTICS) {
            expect(descriptor.id).toMatch(/^(command|mention)\.[a-z0-9_]+$/)
            expect(descriptor.id.startsWith(`${descriptor.kind}.`)).toBe(true)
        }
    })

    it("accepts several combinable mentions in one submission", () => {
        const violations = validateComposition(catalog(), ["mention.file", "mention.problems", "mention.terminal"])

        expect(violations).toEqual([])
        expect(establishesLifecycleBarrier(catalog(), ["mention.file"])).toBe(false)
    })

    it("refuses an exclusive command that shares a submission", () => {
        const violations = validateComposition(catalog(), ["command.compact", "mention.file"])

        expect(violations).toEqual([{ code: "exclusive_node_combined", nodeId: "command.compact" }])
    })

    it("reports an unknown node instead of silently dropping it", () => {
        expect(validateComposition(catalog(), ["command.does_not_exist"])).toEqual([
            { code: "unknown_node", nodeId: "command.does_not_exist" },
        ])
    })

    it("derives the manual compaction authorization and its lifecycle barrier from the node identity", () => {
        expect(authorizedTools(catalog(), ["command.compact"])).toEqual(["summarize_task"])
        expect(establishesLifecycleBarrier(catalog(), ["command.compact"])).toBe(true)
    })

    it("keeps the legacy triggers of a renamed command resolvable through aliases", () => {
        const compact = findDescriptor(catalog(), "command.compact")

        expect(compact?.trigger).toBe("/compact")
        expect(resolveCommandTrigger(catalog(), "/smol")?.id).toBe("command.compact")
    })

    // The composer menu inserts the cmd-namespaced spelling of whatever built-in
    // the user picked; each must resolve to the same command as its bare trigger.
    it.each([
        ["/cmd:compact", "command.compact"],
        ["/cmd:smol", "command.compact"],
        ["/cmd:newtask", "command.new_task"],
        ["/cmd:newrule", "command.new_rule"],
        ["/cmd:reportbug", "command.report_bug"],
        ["/cmd:deep-planning", "command.deep_planning"],
        ["/cmd:explain-changes", "command.explain_changes"],
    ])("resolves the namespaced built-in %s", (trigger, id) => {
        expect(resolveCommandTrigger(catalog(), trigger)?.id).toBe(id)
    })

    it("gives every built-in command a namespaced spelling of each bare trigger", () => {
        for (const descriptor of BUILTIN_INPUT_SEMANTICS.filter((candidate) => candidate.kind === "command")) {
            for (const bare of [descriptor.trigger, ...(descriptor.aliases ?? [])]) {
                expect(resolveCommandTrigger(catalog(), `/cmd:${bare.slice(1)}`)?.id).toBe(descriptor.id)
            }
        }
    })

    it("does not invent a cmd spelling for a discovered capability", () => {
        const skill = {
            id: "command.skill.lint",
            kind: "command" as const,
            trigger: "/skills:lint",
            payload: "text" as const,
            composition: "combinable" as const,
            lifecycle: "turn" as const,
            discovered: true,
        }
        const withSkill: InputSemanticCatalog = { revision: 1, descriptors: [...BUILTIN_INPUT_SEMANTICS, skill] }

        expect(resolveCommandTrigger(withSkill, "/skills:lint")?.id).toBe("command.skill.lint")
        expect(resolveCommandTrigger(withSkill, "/cmd:skills:lint")).toBeUndefined()
    })
})
