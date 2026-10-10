import { describe, expect, it } from "vitest"

import { createPromptGroup, createPromptPack, createPromptRegistry } from "../create-pack"
import { definePromptModule } from "../define-module"
import { PromptPackError } from "../errors"
import { validatePromptPack } from "../validate-pack"

const TEST_CONTRACT = {
    variables: {
        NAME: { stages: ["base"], required: true },
    },
} as const

/** Defines a test prompt module with stable metadata. */
function defineTest(name: string, prompts: Readonly<Record<string, string>>) {
    return definePromptModule({
        name,
        domain: "system",
        prompts,
        contracts: {},
        source: `test/${name}.ts`,
    })
}

describe("prompt pack helpers", () => {
    it("preserves descriptor literals and declaration order", () => {
        const first = definePromptModule({
            name: "first",
            domain: "system",
            prompts: { title: "First @NAME@" },
            contracts: { title: TEST_CONTRACT },
            source: "test/first.ts",
        })
        const second = defineTest("second", { body: "Second" })
        const group = createPromptGroup("system", first, second)
        const pack = createPromptPack(group)

        expect(first.name).toBe("first")
        expect(first.prompts.title).toBe("First @NAME@")
        expect(Object.keys(pack)).toEqual(["first", "second"])
        expect(pack.first).toBe(first.prompts)
    })

    it("rejects duplicate modules within one group", () => {
        const first = defineTest("duplicate", { one: "One" })
        const second = defineTest("duplicate", { two: "Two" })

        expect(() => createPromptGroup("system", first, second)).toThrowError(
            expect.objectContaining({
                name: "PromptPackError",
                reason: "duplicate-module",
                group: "system",
                module: "duplicate",
            }),
        )
    })

    it("rejects duplicate modules across groups", () => {
        const system = createPromptGroup("system", defineTest("shared", { one: "One" }))
        const tools = createPromptGroup(
            "tools",
            definePromptModule({
                name: "shared",
                domain: "tools",
                prompts: { two: "Two" },
                contracts: {},
                source: "test/shared-tool.ts",
            }),
        )

        expect(() => createPromptPack(system, tools)).toThrowError(PromptPackError)
        expect(() => createPromptPack(system, tools)).toThrowError(
            expect.objectContaining({ reason: "duplicate-module", module: "shared" }),
        )
    })

    it("rejects contracts for missing prompt keys", () => {
        expect(() =>
            definePromptModule({
                name: "badContract",
                domain: "system",
                prompts: { title: "Title" },
                contracts: { missing: TEST_CONTRACT },
                source: "test/bad-contract.ts",
            }),
        ).toThrowError(expect.objectContaining({ reason: "contract-key-mismatch", key: "missing" }))
    })

    it("rejects prompt tokens without a matching contract", () => {
        expect(() => defineTest("missingContract", { title: "Hello @NAME@" })).toThrowError(
            expect.objectContaining({ reason: "missing-contract", key: "title" }),
        )
    })

    it("accepts different adjacent tokens in one contract", () => {
        const module = definePromptModule({
            name: "adjacentTokens",
            domain: "system",
            prompts: { title: "@FIRST@@SECOND@" },
            contracts: {
                title: {
                    variables: {
                        FIRST: { stages: ["base"], required: true },
                        SECOND: { stages: ["base"], required: true },
                    },
                },
            },
            source: "test/adjacent-tokens.ts",
        })

        expect(module.prompts.title).toBe("@FIRST@@SECOND@")
    })

    it("rejects unused variables declared by a contract", () => {
        expect(() =>
            definePromptModule({
                name: "unusedContract",
                domain: "system",
                prompts: { title: "Hello" },
                contracts: { title: TEST_CONTRACT },
                source: "test/unused-contract.ts",
            }),
        ).toThrowError(expect.objectContaining({ reason: "unused-contract-variable", key: "title" }))
    })

    it("rejects empty prompts unless the key is explicitly allowed", () => {
        expect(() => defineTest("empty", { intentional: "" })).toThrowError(
            expect.objectContaining({ reason: "empty-prompt", key: "intentional" }),
        )

        const allowed = definePromptModule({
            name: "allowedEmpty",
            domain: "system",
            prompts: { intentional: "" },
            contracts: {},
            source: "test/allowed-empty.ts",
            allowEmptyKeys: ["intentional"],
        })
        expect(allowed.prompts.intentional).toBe("")
    })

    it("automatically registers descriptors into stable domain groups, pack, and store", () => {
        const command = definePromptModule({
            name: "command",
            domain: "commands",
            prompts: { main: "Command" },
            contracts: {},
            source: "test/commands/command.ts",
        })
        const system = defineTest("systemPrompt", { main: "System" })
        const tool = definePromptModule({
            name: "tool",
            domain: "tools",
            prompts: { main: "Tool" },
            contracts: {},
            source: "test/tools/tool.ts",
        })

        const registry = createPromptRegistry(command, system, tool)

        expect(registry.groups.map((group) => group.name)).toEqual(["system", "tools", "commands", "variants"])
        expect(registry.groups.map((group) => group.modules.map((module) => module.name))).toEqual([
            ["systemPrompt"],
            ["tool"],
            ["command"],
            [],
        ])
        expect(Object.keys(registry.pack)).toEqual(["systemPrompt", "tool", "command"])
        expect(registry.store.load("command.main").generate().text).toBe("Command")
    })

    it("reports missing and extra language modules and keys", () => {
        const reference = createPromptPack(createPromptGroup("system", defineTest("alpha", { one: "One", two: "Two" })))
        const candidate = {
            alpha: { one: "Uno", extra: "Extra" },
            extraModule: { value: "Value" },
        }

        expect(validatePromptPack("es", reference, candidate)).toEqual([
            { language: "es", reason: "missing-key", module: "alpha", key: "two" },
            { language: "es", reason: "extra-key", module: "alpha", key: "extra" },
            { language: "es", reason: "extra-module", module: "extraModule" },
        ])
    })
})
