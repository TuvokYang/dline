/**
 * Encoding tests for CommandOutputRow control character handling.
 *
 * Tests that the splitMessage function correctly handles:
 * - CJK multi-byte UTF-8 characters
 * - ANSI escape sequences
 * - Control character replacements (tab, backspace, form feed, vertical tab)
 * - Emoji / surrogate pairs
 * - Mixed content
 */

import { describe, expect, it } from "vitest"
import {
    getCommandEnvironmentLabel,
    getCommandOutputSummary,
    sanitizeCommandOutput,
    stripCommandPromptArtifacts,
} from "../command-output"

const sanitizeControlChars = sanitizeCommandOutput

describe("CommandOutputRow encoding — control char sanitization", () => {
    describe("CJK and Unicode preservation", () => {
        it("should preserve CJK Chinese characters unchanged", () => {
            const input = "文件路径: C:\\用户\\文档\\测试.txt"
            expect(sanitizeControlChars(input)).toBe(input)
        })

        it("should preserve Japanese characters unchanged", () => {
            const input = "テストファイル: /home/user/ドキュメント/テスト.txt"
            expect(sanitizeControlChars(input)).toBe(input)
        })

        it("should preserve Korean characters unchanged", () => {
            const input = "파일 경로: /home/user/문서/테스트.txt"
            expect(sanitizeControlChars(input)).toBe(input)
        })

        it("should preserve emoji unchanged", () => {
            const input = "✅ Success 🎉✨🚀"
            expect(sanitizeControlChars(input)).toBe(input)
        })

        it("should preserve mixed CJK + ASCII content", () => {
            const input = "运行测试: npm run test -- --coverage (共15个测试)"
            expect(sanitizeControlChars(input)).toBe(input)
        })

        it("should preserve zero-width characters", () => {
            const input = "test\u200Bzero\u200Cwidth\u200Djoiner"
            expect(sanitizeControlChars(input)).toBe(input)
        })
    })

    describe("Control character replacement", () => {
        it("should replace tab (\\x09) with visual arrow", () => {
            const input = "col1\x09col2\x09col3"
            const expected = "col1→   col2→   col3"
            expect(sanitizeControlChars(input)).toBe(expected)
        })

        it("should replace backspace (\\x08) with erase symbol", () => {
            const input = "type\x08\x08\x08\x08text"
            const expected = "type⌫⌫⌫⌫text"
            expect(sanitizeControlChars(input)).toBe(expected)
        })

        it("should replace form feed (\\x0C) with eject symbol", () => {
            const input = "page1\x0Cpage2"
            const expected = "page1⏏page2"
            expect(sanitizeControlChars(input)).toBe(expected)
        })

        it("should replace vertical tab (\\x0B) with arrow symbol", () => {
            const input = "line1\x0Bline2"
            const expected = "line1⇳line2"
            expect(sanitizeControlChars(input)).toBe(expected)
        })

        it("should handle all control chars together", () => {
            const input = "a\x09b\x08c\x0Cd\x0Be"
            const expected = "a→   b⌫c⏏d⇳e"
            expect(sanitizeControlChars(input)).toBe(expected)
        })

        it("should NOT insert symbols at word boundaries (regression: \\b regex bug)", () => {
            const input = "Features: alt-svc AsynchDNS HSTS"
            // \b word-boundary regex bug would produce: "⌫Features⌫:⌫ ⌫alt⌫-⌫svc⌫ ..."
            // This should remain unchanged
            expect(sanitizeControlChars(input)).toBe(input)
        })
    })

    describe("ANSI escape sequence preservation", () => {
        it("should preserve ANSI color sequences unchanged", () => {
            const input = "\x1b[32mGREEN\x1b[0m"
            expect(sanitizeControlChars(input)).toBe(input)
        })

        it("should preserve ANSI bold/bright sequences", () => {
            const input = "\x1b[1mBOLD\x1b[0m"
            expect(sanitizeControlChars(input)).toBe(input)
        })

        it("should preserve complex ANSI combinations", () => {
            const input = "\x1b[1;31mERROR:\x1b[0m \x1b[33mWarning message\x1b[0m"
            expect(sanitizeControlChars(input)).toBe(input)
        })

        it("should preserve 256-color ANSI sequences", () => {
            const input = "\x1b[38;5;208mOrange text\x1b[0m"
            expect(sanitizeControlChars(input)).toBe(input)
        })

        it("should preserve ANSI mixed with CJK", () => {
            const input = "\x1b[32m✓ 成功\x1b[0m \x1b[31m✗ 失败\x1b[0m"
            expect(sanitizeControlChars(input)).toBe(input)
        })
    })

    describe("UTF-8 byte sequences not corrupted", () => {
        it("should not corrupt 2-byte UTF-8 sequences", () => {
            // ¢ (U+00A2) = C2 A2 in UTF-8
            const input = "Price: ¢100"
            expect(sanitizeControlChars(input)).toBe(input)
        })

        it("should not corrupt 3-byte UTF-8 sequences (common CJK)", () => {
            // 一 (U+4E00) = E4 B8 80 in UTF-8
            // Note: 0x80 is a continuation byte that overlaps with old [\x7F-\x9F] bug range
            const input = "一 二 三 中 文"
            expect(sanitizeControlChars(input)).toBe(input)
        })

        it("should not corrupt 4-byte UTF-8 sequences (emoji, rare chars)", () => {
            // 🎉 (U+1F389) = F0 9F 8E 89 in UTF-8
            const input = "Party! 🎉🎊🎈"
            expect(sanitizeControlChars(input)).toBe(input)
        })
    })

    describe("collapsed output summary", () => {
        it("uses the final visible carriage-return segment and strips ANSI without losing Unicode", () => {
            const input =
                "first line\r\nold progress\r\x1b[31m最终_🚀\x1b[0m\tCOLUMN\b\n📋 Output is being logged to: C:\\Temp\\command.log\n"

            expect(getCommandOutputSummary(input)).toBe("最终_🚀→   COLUMN⌫")
        })

        it("returns undefined when output has no visible line", () => {
            expect(getCommandOutputSummary("\r\n \r\n")).toBeUndefined()
        })

        it("moves the latest terminal environment prompt out of command output", () => {
            const basePrompt = "\x1b]0;C:\\Windows\\powershell.exe\x1b\\\x1b[0m(base) \x1b[0m"
            const projectPrompt = "\u009d0;C:\\Windows\\powershell.exe\u009c\x1b[0m(project) \x1b[0m"
            const output = `first\n${basePrompt}\nresult\n${projectPrompt}\n`

            expect(getCommandEnvironmentLabel(output)).toBe("project")
            expect(stripCommandPromptArtifacts(output)).toBe("first\nresult\n")
            expect(getCommandOutputSummary(output)).toBe("result")
        })

        it("preserves ordinary parenthesized command output", () => {
            const output = "result\n(project)\n"

            expect(getCommandEnvironmentLabel(output)).toBeUndefined()
            expect(stripCommandPromptArtifacts(output)).toBe(output)
            expect(getCommandOutputSummary(output)).toBe("(project)")
        })
    })
})
