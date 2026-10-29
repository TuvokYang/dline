import { describe, expect, it } from "vitest"
import { classifyInputFile } from "@/core/input-semantics/InputResourceClassifier"
import { extractResourceText, UnsupportedResourceMediaTypeError } from "../extract-resource-text"

/** One sample per text-like format the resource classifier admits, keyed by the name that selects it. */
const TEXT_SAMPLES: ReadonlyArray<readonly [string, string]> = [
    ["notes.txt", "plain notes"],
    ["readme.md", "# Title"],
    ["table.csv", "a,b\n1,2"],
    ["data.json", '{"a":1}'],
    ["page.xml", "<a>1</a>"],
    ["lib.rs", "pub fn answer() -> u32 { 42 }"],
    [
        "book.ipynb",
        JSON.stringify({ cells: [{ cell_type: "code", source: ["print(1)"], outputs: [] }], metadata: {}, nbformat: 4 }),
    ],
]

describe("extractResourceText", () => {
    it("decodes plain text exactly from the bytes it was given", async () => {
        const extracted = await extractResourceText("text/markdown", Buffer.from("# Title\n\nbody"))

        expect(extracted.text).toBe("# Title\n\nbody")
        expect(extracted.pageCount).toBeUndefined()
    })

    it("refuses a media type it cannot read rather than decoding it as text", async () => {
        await expect(extractResourceText("application/octet-stream", Buffer.from([0, 1]))).rejects.toBeInstanceOf(
            UnsupportedResourceMediaTypeError,
        )
    })

    it.each(TEXT_SAMPLES)("reads every text media type the classifier assigns (%s)", async (name, content) => {
        const bytes = Buffer.from(content)
        const classified = await classifyInputFile(name, bytes)
        if (!classified.ok) throw new Error(`classifier refused ${name}`)

        const extracted = await extractResourceText(classified.value.mediaType, bytes)

        expect(extracted.text.length).toBeGreaterThan(0)
    })
})
