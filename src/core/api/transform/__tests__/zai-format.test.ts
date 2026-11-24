import { describe, expect, it } from "vitest"
import { createZaiToolMarkup } from "../zai-format"

/** A complete GLM call block for read_file with one argument. */
const READ_ONE = "<tool_call>read_file<arg_key>path</arg_key><arg_value>a.ts</arg_value></tool_call>"
/** The same call restated in Dline markup. */
const READ_ONE_DLINE = "<read_file><path>a.ts</path></read_file>"

describe("createZaiToolMarkup", () => {
    it("enables translation for GLM families, including flash and turbo variants", () => {
        for (const modelId of [
            "glm-5.3",
            "glm-5.3-flash",
            "glm-5.3-flashx",
            "glm-5.2",
            "glm-5",
            "glm-5-turbo",
            "glm-4.7",
            "glm-4.7-flash",
            "glm-4.6",
            "glm-4.5",
            "zai-org/GLM-5.3",
            "z-ai/glm-4.6",
            "GLM 4.6V",
        ]) {
            expect(createZaiToolMarkup(modelId)(READ_ONE), modelId).toBe(READ_ONE_DLINE)
        }
    })

    it("leaves every other model family untouched", () => {
        for (const modelId of ["gpt-5.6", "claude-sonnet-4", "deepseek-v4-pro", "qwen3-coder", "grok-4"]) {
            expect(createZaiToolMarkup(modelId)(READ_ONE, { holdOpenCall: true }), modelId).toBe(READ_ONE)
        }
    })

    it("restates a call written on separate lines, as the 4.6 template writes it", () => {
        const text = "<tool_call>read_file\n<arg_key>path</arg_key>\n<arg_value>a.ts</arg_value>\n</tool_call>"
        expect(createZaiToolMarkup("glm-4.6")(text)).toBe(READ_ONE_DLINE)
    })

    it("restates a call separated by escaped newlines", () => {
        const text = "<tool_call>read_file\\n<arg_key>path</arg_key>\\n<arg_value>a.ts</arg_value>\\n</tool_call>"
        expect(createZaiToolMarkup("glm-5.3")(text)).toBe(READ_ONE_DLINE)
    })

    it("keeps the prose that surrounds a call", () => {
        const text = `Reading the file now.\n${READ_ONE}\nDone.`
        expect(createZaiToolMarkup("glm-5.3")(text)).toBe(`Reading the file now.\n${READ_ONE_DLINE}\nDone.`)
    })

    it("restates several calls in order", () => {
        const second = "<tool_call>search_files<arg_key>path</arg_key><arg_value>src</arg_value></tool_call>"
        const text = `${READ_ONE}${second}`
        expect(createZaiToolMarkup("glm-5.3")(text)).toBe(`${READ_ONE_DLINE}<search_files><path>src</path></search_files>`)
    })

    it("keeps structured argument values as written JSON text", () => {
        const text =
            '<tool_call>use_subagents<arg_key>subagents</arg_key><arg_value>[{"task":"check","context":"ctx"}]</arg_value></tool_call>'
        expect(createZaiToolMarkup("glm-5.3")(text)).toBe(
            '<use_subagents><subagents>[{"task":"check","context":"ctx"}]</subagents></use_subagents>',
        )
    })

    it("keeps a call with an unknown function as text", () => {
        const text = "<tool_call>not_a_dline_tool<arg_key>path</arg_key><arg_value>a.ts</arg_value></tool_call>"
        expect(createZaiToolMarkup("glm-5.3")(text)).toBe(text)
    })

    it("keeps a call with an unknown parameter as text", () => {
        const text = "<tool_call>read_file<arg_key>not_a_param</arg_key><arg_value>a.ts</arg_value></tool_call>"
        expect(createZaiToolMarkup("glm-5.3")(text)).toBe(text)
    })

    it("keeps a call whose value would end the emitted parameter early", () => {
        const text = "<tool_call>read_file<arg_key>path</arg_key><arg_value>a</path>b</arg_value></tool_call>"
        expect(createZaiToolMarkup("glm-5.3")(text)).toBe(text)
    })

    it("keeps an unclosed call as text, and hides it only for the streaming preview", () => {
        const text = `Reading.\n<tool_call>read_file<arg_key>path</arg_key><arg_value>a.ts`
        expect(createZaiToolMarkup("glm-5.3")(text)).toBe(text)
        expect(createZaiToolMarkup("glm-5.3")(text, { holdOpenCall: true })).toBe("Reading.\n")
    })

    it("returns text without calls unchanged", () => {
        const text = "No tools here: <div>markup</div>."
        expect(createZaiToolMarkup("glm-5.3")(text)).toBe(text)
    })

    it("restates a call with no arguments", () => {
        const text = "<tool_call>attempt_completion</tool_call>"
        expect(createZaiToolMarkup("glm-5.3")(text)).toBe("<attempt_completion></attempt_completion>")
    })

    it("does not translate a block whose arguments trail unexpected text", () => {
        const text = "<tool_call>read_file<arg_key>path</arg_key><arg_value>a.ts</arg_value>junk</tool_call>"
        expect(createZaiToolMarkup("glm-5.3")(text)).toBe(text)
    })
})
