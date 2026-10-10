import { describe, expect, it } from "vitest"

import { PromptTemplate } from "../PromptTemplate"
import { renderRuntime } from "../render-runtime"
import type { PromptContract } from "../types"

const CONTRACT: PromptContract = {
    variables: {
        NAME: { stages: ["base"], required: true },
        COUNT: { stages: ["runtime"], required: false },
        ENABLED: { stages: ["runtime"], required: false },
        OPAQUE: { stages: ["runtime"], required: false },
        MISSING: { stages: ["runtime"], required: false },
    },
}

/** Creates a prompt template with the stable test contract. */
function createTemplate(template: string): PromptTemplate {
    return PromptTemplate.create("test.template", template, CONTRACT)
}

describe("PromptTemplate", () => {
    it("renders repeated and adjacent uppercase tokens", () => {
        const output = createTemplate("Hello @NAME@:@NAME@@NAME@").env("base", { NAME: "Dline" }, "base-name").generate()

        expect(output.text).toBe("Hello Dline:DlineDline")
        expect(output.warnings).toEqual([])
        expect(output.trace).toEqual([{ key: "NAME", stage: "base", source: "base-name" }])
    })

    it("renders escaped tokens as literals without resolving them", () => {
        const output = createTemplate("literal=@@NAME@@ rendered=@NAME@").env("base", { NAME: "Dline" }, "base-name").generate()

        expect(output.text).toBe("literal=@NAME@ rendered=Dline")
    })

    it("preserves shell, template literal, email, mention, and decorator text", () => {
        const template = '$HOME $content "${request.params.uri}" dev@example.com @user @sealed'
        const output = createTemplate(template).generate()

        expect(output.text).toBe(template)
        expect(output.warnings).toEqual([])
    })

    it("preserves invalid token forms", () => {
        const template = "@lower@ @HAS SPACE@ @user.name@ @_LEADING@ @TRAILING_@ @9START@ single@"
        const output = createTemplate(template).generate()

        expect(output.text).toBe(template)
        expect(output.warnings).toEqual([])
    })

    it("retains missing tokens and reports one warning per unique key", () => {
        const output = createTemplate("@MISSING@ then @MISSING@").generate()

        expect(output.text).toBe("@MISSING@ then @MISSING@")
        expect(output.warnings).toEqual([
            {
                templateId: "test.template",
                key: "MISSING",
                rule: { stages: ["runtime"], required: false },
                loadedStages: [],
                trace: [],
            },
        ])
    })

    it("inserts environment values without recursively scanning them", () => {
        const output = createTemplate("value=@OPAQUE@ missing=@MISSING@")
            .env("runtime", { OPAQUE: "external @MISSING@ ${request.params.uri}" }, "external-value")
            .generate()

        expect(output.text).toBe("value=external @MISSING@ ${request.params.uri} missing=@MISSING@")
        expect(output.warnings).toEqual([
            {
                templateId: "test.template",
                key: "MISSING",
                rule: { stages: ["runtime"], required: false },
                loadedStages: ["runtime"],
                trace: [],
            },
        ])
    })

    it("includes the missing key source trace in its warning", () => {
        const output = createTemplate("@NAME@ @MISSING@")
            .env("base", { NAME: "Dline" }, "base-name")
            .env("runtime", { MISSING: "loaded" }, "runtime-missing")
            .env("runtime", { MISSING: "final" }, "runtime-final")
            .generate()

        expect(output.warnings).toEqual([])
        expect(output.trace).toEqual([
            { key: "NAME", stage: "base", source: "base-name" },
            { key: "MISSING", stage: "runtime", source: "runtime-missing" },
            {
                key: "MISSING",
                stage: "runtime",
                source: "runtime-final",
                replacedSource: "runtime-missing",
            },
        ])
    })

    it("converts number and boolean values deterministically", () => {
        const output = createTemplate("count=@COUNT@ enabled=@ENABLED@")
            .env("runtime", { COUNT: 0, ENABLED: false }, "runtime-primitives")
            .generate()

        expect(output.text).toBe("count=0 enabled=false")
    })

    it("returns new template instances and isolates branches", () => {
        const original = createTemplate("@NAME@")
        const first = original.env("base", { NAME: "first" }, "first-source")
        const second = original.env("base", { NAME: "second" }, "second-source")

        expect(original.generate().text).toBe("@NAME@")
        expect(first.generate().text).toBe("first")
        expect(second.generate().text).toBe("second")
    })

    it("rejects runtime-created contracts from template scanning", () => {
        expect(() => renderRuntime("runtime-created", "Hello @NAME@", { NAME: "Dline" })).toThrowError()
    })
})
