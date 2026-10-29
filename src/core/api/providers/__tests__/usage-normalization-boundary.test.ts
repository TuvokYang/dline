import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const INCLUSIVE_PROMPT_USAGE_ADAPTERS = [
    "doubao.ts",
    "fireworks.ts",
    "groq.ts",
    "hicap.ts",
    "litellm.ts",
    "lmstudio.ts",
    "moonshot.ts",
    "oca.ts",
    "qwen.ts",
    "requesty.ts",
    "xai.ts",
    "zai.ts",
] as const

describe("Provider inclusive prompt usage boundary", () => {
    it.each(INCLUSIVE_PROMPT_USAGE_ADAPTERS)("normalizes %s through the shared non-overlapping usage policy", async (file) => {
        const source = await readFile(path.join(__dirname, "..", file), "utf8")

        expect(source).toContain('import { splitInclusiveInputUsage } from "../transform/usage-normalization"')
        expect(source).toContain("splitInclusiveInputUsage({")
        expect(source).not.toMatch(/inputTokens:\s*[^\n]*(?:prompt_tokens|promptTokens)/)
    })

    it("subtracts both cache reads and writes in the OpenRouter generation fallback", async () => {
        const source = await readFile(path.join(__dirname, "..", "openrouter.ts"), "utf8")

        expect(source).toContain("- cacheReadTokens - cacheWriteTokens")
    })

    it("does not report AskSage credits as USD cost", async () => {
        const source = await readFile(path.join(__dirname, "..", "asksage.ts"), "utf8")

        expect(source).not.toContain("totalCost: result.usage.asksage_tokens")
    })

    it("derives missing Dify completion usage from total minus prompt tokens", async () => {
        const source = await readFile(path.join(__dirname, "..", "dify.ts"), "utf8")

        expect(source).toMatch(
            /parsed\.usage\.completion_tokens\s*\?\?\s*Math\.max\(0,\s*\(parsed\.usage\.total_tokens\s*\?\?\s*inputTokens\)\s*-\s*inputTokens\)/s,
        )
        expect(source).not.toContain("completion_tokens || parsed.usage.total_tokens")
    })
})
