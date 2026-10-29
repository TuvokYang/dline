import { describe, expect, it, vi } from "vitest"
import { processUserContentTags } from "../processUserContentTags"

describe("processUserContentTags", () => {
    it("processes only text inside supported user-content tags", async () => {
        const transform = vi.fn(async (text: string) => `expanded(${text})`)
        const source = "Tool result data @/secret.txt\n<feedback>\nPlease inspect @/src/index.ts\n</feedback>\nTail @terminal"

        const result = await processUserContentTags(source, transform)

        expect(result).toBe(
            "Tool result data @/secret.txt\n<feedback>expanded(\nPlease inspect @/src/index.ts\n)</feedback>\nTail @terminal",
        )
        expect(transform).toHaveBeenCalledOnce()
        expect(transform).toHaveBeenCalledWith("\nPlease inspect @/src/index.ts\n")
    })

    it("preserves untagged text without invoking the transform", async () => {
        const transform = vi.fn(async (text: string) => `expanded(${text})`)
        const source = "Untrusted tool data @/secret.txt @https://internal.example @terminal"

        await expect(processUserContentTags(source, transform)).resolves.toBe(source)
        expect(transform).not.toHaveBeenCalled()
    })

    it("supports multiple tags without rescanning transformed values", async () => {
        const transform = vi.fn(async (text: string) => `${text}@/inserted-by-transform`)

        const result = await processUserContentTags("<answer>one</answer> / <user_message>two</user_message>", transform)

        expect(result).toBe(
            "<answer>one@/inserted-by-transform</answer> / <user_message>two@/inserted-by-transform</user_message>",
        )
        expect(transform).toHaveBeenCalledTimes(2)
    })
})
