import { describe, expect, it } from "vitest"

import { createPromptGroup } from "../../i18n/helpers/create-pack"
import { definePromptModule } from "../../i18n/helpers/define-module"
import { TemplateStore, TemplateStoreError } from "../TemplateStore"

const MODULE = definePromptModule({
    name: "greeting",
    domain: "system",
    prompts: {
        plain: "Hello",
        named: "Hello @NAME@",
    },
    contracts: {
        named: {
            variables: {
                NAME: { stages: ["base"], required: true },
            },
        },
    },
    source: "test/greeting.ts",
})

/** Creates a template store with one stable test module. */
function createStore(): TemplateStore {
    return TemplateStore.create(createPromptGroup("system", MODULE))
}

describe("TemplateStore", () => {
    it("loads raw templates with stable module.key IDs", () => {
        expect(createStore().load("greeting.plain").generate()).toEqual({
            text: "Hello",
            warnings: [],
            trace: [],
        })
    })

    it("loads a template contract for environment generation", () => {
        const output = createStore().load("greeting.named").env("base", { NAME: "Dline" }, "test-name").generate()

        expect(output.text).toBe("Hello Dline")
        expect(output.trace).toEqual([{ key: "NAME", stage: "base", source: "test-name" }])
    })

    it("throws a structured error for a missing template ID", () => {
        expect(() => createStore().load("greeting.missing")).toThrowError(TemplateStoreError)
        expect(() => createStore().load("greeting.missing")).toThrowError(
            expect.objectContaining({
                name: "TemplateStoreError",
                templateId: "greeting.missing",
                reason: "missing-template",
            }),
        )
    })

    it("rejects duplicate descriptors across store groups", () => {
        const duplicate = definePromptModule({
            name: "greeting",
            domain: "tools",
            prompts: { plain: "Duplicate" },
            contracts: {},
            source: "test/duplicate.ts",
        })

        expect(() =>
            TemplateStore.create(createPromptGroup("system", MODULE), createPromptGroup("tools", duplicate)),
        ).toThrowError(expect.objectContaining({ reason: "duplicate-template", templateId: "greeting.plain" }))
    })
})
