import { describe, expect, it } from "vitest"

import { EnvStore } from "../EnvStore"
import { PromptEnvError } from "../errors"
import type { PromptContract, PromptEnvInput } from "../types"

const CONTRACT: PromptContract = {
    variables: {
        BASE_ONLY: { stages: ["base"], required: true },
        SHARED: { stages: ["base", "variant", "runtime"], required: true },
        VARIANT_ONLY: { stages: ["variant"], required: false },
        RUNTIME_ONLY: { stages: ["runtime"], required: false },
    },
}

/** Creates an empty environment store for a stable test template. */
function createStore(): EnvStore {
    return EnvStore.create("test.env", CONTRACT)
}

describe("EnvStore", () => {
    it("returns a new snapshot without mutating the original store", () => {
        const original = createStore()
        const loaded = original.env("base", { BASE_ONLY: "base", SHARED: "first" }, "base-defaults")

        expect(loaded).not.toBe(original)
        expect(original.get("BASE_ONLY")).toBeUndefined()
        expect(original.getTrace()).toEqual([])
        expect(loaded.get("BASE_ONLY")).toBe("base")
        expect(loaded.getLoadedStages()).toEqual(["base"])
    })

    it("uses last-write-wins within the same stage and traces the replaced source", () => {
        const first = createStore().env("base", { SHARED: "first" }, "base-one")
        const second = first.env("base", { SHARED: "second" }, "base-two")

        expect(first.get("SHARED")).toBe("first")
        expect(second.get("SHARED")).toBe("second")
        expect(second.getTrace()).toEqual([
            { key: "SHARED", stage: "base", source: "base-one" },
            { key: "SHARED", stage: "base", source: "base-two", replacedSource: "base-one" },
        ])
    })

    it("uses last-write-wins across allowed stages", () => {
        const base = createStore().env("base", { SHARED: "base" }, "base-source")
        const variant = base.env("variant", { SHARED: "variant" }, "variant-source")
        const runtime = variant.env("runtime", { SHARED: "runtime" }, "runtime-source")

        expect(base.get("SHARED")).toBe("base")
        expect(variant.get("SHARED")).toBe("variant")
        expect(runtime.get("SHARED")).toBe("runtime")
        expect(runtime.getLoadedStages()).toEqual(["base", "variant", "runtime"])
        expect(runtime.getTrace().at(-1)).toEqual({
            key: "SHARED",
            stage: "runtime",
            source: "runtime-source",
            replacedSource: "variant-source",
        })
    })

    it("rejects stage regression", () => {
        const store = createStore().env("variant", { VARIANT_ONLY: "variant" }, "variant-source")

        expect(() => store.env("base", { BASE_ONLY: "base" }, "late-base")).toThrowError(
            expect.objectContaining({
                name: "PromptEnvError",
                templateId: "test.env",
                stage: "base",
                source: "late-base",
                reason: "stage-regression",
            }),
        )
    })

    it("rejects undeclared keys", () => {
        expect(() => createStore().env("base", { NOT_DECLARED: "value" }, "bad-key")).toThrowError(
            expect.objectContaining({
                key: "NOT_DECLARED",
                reason: "undeclared-key",
            }),
        )
    })

    it("rejects keys loaded from a disallowed stage", () => {
        expect(() => createStore().env("runtime", { BASE_ONLY: "value" }, "bad-stage")).toThrowError(
            expect.objectContaining({
                key: "BASE_ONLY",
                stage: "runtime",
                reason: "disallowed-stage",
            }),
        )
    })

    it.each([
        ["null", null],
        ["undefined", undefined],
        ["object", { nested: "value" }],
        ["array", ["value"]],
    ])("rejects the invalid %s runtime value", (_label, value) => {
        const input: PromptEnvInput = { SHARED: value }

        expect(() => createStore().env("base", input, "invalid-value")).toThrowError(PromptEnvError)
        expect(() => createStore().env("base", input, "invalid-value")).toThrowError(
            expect.objectContaining({
                key: "SHARED",
                reason: "invalid-value",
            }),
        )
    })

    it("isolates independent branches created from the same snapshot", () => {
        const base = createStore().env("base", { SHARED: "base" }, "base-source")
        const nativeBranch = base.env("variant", { SHARED: "native" }, "native-profile")
        const liteBranch = base.env("variant", { SHARED: "lite" }, "lite-profile")

        expect(base.get("SHARED")).toBe("base")
        expect(nativeBranch.get("SHARED")).toBe("native")
        expect(liteBranch.get("SHARED")).toBe("lite")
        expect(nativeBranch.getTrace()).not.toBe(liteBranch.getTrace())
    })
})
