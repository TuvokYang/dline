import { languageOptions } from "@shared/Languages"
import { describe, expect, it } from "vitest"
import { buildPreferredLanguageInstructions } from "../preferred-language"

const languageDirective = (preference?: string) => {
    const instruction = buildPreferredLanguageInstructions(preference)
    const [, heading, body] = /^(# Preferred Language)\n\n([\s\S]+)$/.exec(instruction) ?? []
    expect(heading).toBe("# Preferred Language")
    expect(body).toBeTruthy()
    expect(instruction).not.toMatch(/@[A-Z_]+@/)
    return body
}

describe("model response language instruction", () => {
    it.each(languageOptions)("preserves the saved $key choice and emits its fixed language", ({ key, display }) => {
        expect(languageDirective(display)).toBe(`Speak in ${key}.`)
    })

    it("makes English explicit for the existing default and unknown legacy values", () => {
        for (const preference of [undefined, "", "unknown", "<script>not a language</script>"]) {
            expect(languageDirective(preference)).toBe("Speak in en.")
        }
    })

    it("expresses dynamic following of the user's own prose without guessing from UI, code or logs", () => {
        const body = languageDirective("auto")
        expect(body).toMatch(/most recent message/)
        expect(body).toMatch(/own prose/)
        expect(body).toMatch(/code, logs, or quoted material/)
        expect(body).toMatch(/explicit language instruction/)
        expect(body).not.toMatch(/Speak in (en|zh-CN)\./)
    })
})
