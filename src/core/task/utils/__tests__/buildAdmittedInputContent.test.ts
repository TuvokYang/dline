import { MAX_ATTACHED_BASE64_TEXT_BYTES } from "@shared/attachments"
import type { AdmittedInputPart, AdmittedResourcePart } from "@shared/input-semantics/admitted-parts"
import type { SemanticResourceRef } from "@shared/input-semantics/document"
import { describe, expect, it, vi } from "vitest"
import { type AdmittedResourceReader, buildAdmittedInputContent } from "../admittedInputContent"

vi.mock("pdf-parse/lib/pdf-parse", () => ({
    default: async (bytes: Buffer) => {
        if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Invalid PDF structure")
        return { text: `parsed ${bytes.byteLength} bytes`, numpages: 2 }
    },
}))

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const PDF_BYTES = Buffer.from("%PDF-1.7\nfrozen", "latin1")

function ref(resourceId: string, mediaType: string): SemanticResourceRef {
    return {
        resourceId,
        expectedContentHash: "0".repeat(64),
        mediaType,
        byteLength: 1,
        owner: { kind: "task", taskId: "task-1" },
        generation: 1,
    }
}

function resource(resourceId: string, mediaType: string, displayName: string): AdmittedResourcePart {
    return {
        kind: "resource",
        entityId: `entity-${resourceId}`,
        nodeKind: mediaType.startsWith("image/") ? "image" : "file",
        ref: ref(resourceId, mediaType),
        displayName,
    }
}

/** A reader backed by fixed bytes; ids it does not know fail like a changed resource. */
function reader(entries: Record<string, { mediaType: string; bytes: Buffer }>): AdmittedResourceReader & { reads: string[] } {
    const reads: string[] = []
    return {
        reads,
        readBytes: async (resourceRef) => {
            reads.push(resourceRef.resourceId)
            const entry = entries[resourceRef.resourceId]
            if (!entry) return { ok: false, failure: { code: "semantic_input_resource_changed" } }
            return { ok: true, value: { record: { mediaType: entry.mediaType }, bytes: entry.bytes } }
        },
    }
}

const text = (value: string): AdmittedInputPart => ({ kind: "text", text: value })

describe("buildAdmittedInputContent", () => {
    it("references an image where it was inserted and sends its pixels as a separate block after the message", async () => {
        const content = await buildAdmittedInputContent(
            { parts: [text("before "), resource("img", "image/png", "shot.png"), text(" after")], opensTask: false },
            reader({ img: { mediaType: "image/png", bytes: PNG_BYTES } }),
        )

        expect(content).toEqual([
            {
                type: "text",
                text: '<user_message>\nbefore <image_ref name="shot.png" id="img" /> after\n</user_message>\n<image name="shot.png" id="img">\n',
            },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BYTES.toString("base64") } },
            { type: "text", text: "\n</image>" },
        ])
    })

    it("sends an image referenced twice once, and each image after the whole message in reference order", async () => {
        const content = await buildAdmittedInputContent(
            {
                parts: [
                    resource("a", "image/png", "a.png"),
                    text(" and "),
                    resource("b", "image/png", "b.png"),
                    text(" again "),
                    resource("a", "image/png", "a.png"),
                ],
                opensTask: true,
                context: "hook context",
            },
            reader({ a: { mediaType: "image/png", bytes: PNG_BYTES }, b: { mediaType: "image/png", bytes: PNG_BYTES } }),
        )

        const texts = content.flatMap((block) => (block.type === "text" ? [block.text] : []))
        expect(texts[0]).toBe(
            '<task>\n<image_ref name="a.png" id="a" /> and <image_ref name="b.png" id="b" /> again <image_ref name="a.png" id="a" />\n</task>\n<image name="a.png" id="a">\n',
        )
        expect(texts.slice(1)).toEqual([
            '\n</image>\n<image name="b.png" id="b">\n',
            "\n</image>",
            "<context>\nhook context\n</context>",
        ])
        expect(content.filter((block) => block.type === "image")).toHaveLength(2)
    })

    it("sends a PDF natively and as fallback text derived from the same frozen bytes", async () => {
        const content = await buildAdmittedInputContent(
            { parts: [text("read "), resource("pdf", "application/pdf", "report.pdf")], opensTask: false },
            reader({ pdf: { mediaType: "application/pdf", bytes: PDF_BYTES } }),
        )

        expect(content[1]).toEqual({
            type: "attached_document",
            path: "report.pdf",
            media_type: "application/pdf",
            data: PDF_BYTES.toString("base64"),
            byte_length: PDF_BYTES.byteLength,
            page_count: 2,
            fallback_text: `<attached_resource name="report.pdf" id="pdf">\nparsed ${PDF_BYTES.byteLength} bytes\n</attached_resource>`,
        })
    })

    it("reads a text file from its bytes and names it by display name, never a path", async () => {
        const content = await buildAdmittedInputContent(
            { parts: [resource("md", "text/markdown", 'notes "v2".md')], opensTask: false },
            reader({ md: { mediaType: "text/markdown", bytes: Buffer.from("# Title\n") } }),
        )

        expect(content).toEqual([
            {
                type: "text",
                text: '<user_message>\n<attached_resource name="notes &quot;v2&quot;.md" id="md">\n# Title\n\n</attached_resource>\n</user_message>',
            },
        ])
    })

    it("uses the media type recorded for the bytes, not the one the reference claims", async () => {
        const claimedImage = resource("swap", "image/png", "swap.png")
        const content = await buildAdmittedInputContent(
            { parts: [claimedImage], opensTask: false },
            reader({ swap: { mediaType: "text/plain", bytes: Buffer.from("plain") } }),
        )

        expect(content.some((block) => block.type === "image")).toBe(false)
        expect(content[0]).toMatchObject({ type: "text", text: expect.stringContaining("plain") })
    })

    it("replaces a resource that can no longer be read with an explicit marker", async () => {
        const missing = reader({})
        const content = await buildAdmittedInputContent(
            { parts: [text("see "), resource("gone", "image/png", "gone.png")], opensTask: false },
            missing,
        )

        expect(missing.reads).toEqual(["gone"])
        expect(content).toEqual([
            {
                type: "text",
                text: '<user_message>\nsee <attached_resource name="gone.png" id="gone">\n[The attached resource is unavailable: semantic_input_resource_changed]\n</attached_resource>\n</user_message>',
            },
        ])
    })

    // Context management folds repeated `<file_content path>` reads into a notice;
    // two attachments that only share a display name must both reach the model.
    it("tags each attachment by its own identity, not a workspace path", async () => {
        const content = await buildAdmittedInputContent(
            {
                parts: [
                    resource("first", "text/plain", "notes.txt"),
                    text(" vs "),
                    resource("second", "text/plain", "notes.txt"),
                ],
                opensTask: false,
            },
            reader({
                first: { mediaType: "text/plain", bytes: Buffer.from("ONE") },
                second: { mediaType: "text/plain", bytes: Buffer.from("TWO") },
            }),
        )

        const [block] = content
        expect(block?.type).toBe("text")
        const rendered = block?.type === "text" ? block.text : ""
        expect(rendered).not.toContain("<file_content")
        expect(rendered).toContain('<attached_resource name="notes.txt" id="first">\nONE\n</attached_resource>')
        expect(rendered).toContain('<attached_resource name="notes.txt" id="second">\nTWO\n</attached_resource>')
    })

    it("reports a recorded media type no extractor reads instead of guessing how to send it", async () => {
        const content = await buildAdmittedInputContent(
            { parts: [resource("svg", "image/svg+xml", "logo.svg")], opensTask: false },
            reader({ svg: { mediaType: "image/svg+xml", bytes: Buffer.from("<svg/>") } }),
        )

        expect(content.some((block) => block.type === "image")).toBe(false)
        expect(content[0]).toMatchObject({ type: "text", text: expect.stringContaining("semantic_input_resource_invalid_mime") })
    })

    it("sends opaque binary whole as base64 text in its own tag", async () => {
        const bytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0xff])
        const content = await buildAdmittedInputContent(
            { parts: [resource("exe", "application/octet-stream", "tool.exe")], opensTask: false },
            reader({ exe: { mediaType: "application/octet-stream", bytes } }),
        )

        expect(content).toEqual([
            {
                type: "text",
                text: `<user_message>\n<attached_resource media_type="application/octet-stream" encoding="base64" name="tool.exe" id="exe">\n${bytes.toString("base64")}\n</attached_resource>\n</user_message>`,
            },
        ])
    })

    // pdf-parse rejects some valid PDFs; a native endpoint may still read them.
    it("keeps the native path for a PDF the extractor rejects, with its base64 as the fallback", async () => {
        const unparsed = Buffer.from("not parseable by the extractor")
        const content = await buildAdmittedInputContent(
            { parts: [resource("pdf", "application/pdf", "locked.pdf")], opensTask: false },
            reader({ pdf: { mediaType: "application/pdf", bytes: unparsed } }),
        )

        expect(content[1]).toEqual({
            type: "attached_document",
            path: "locked.pdf",
            media_type: "application/pdf",
            data: unparsed.toString("base64"),
            byte_length: unparsed.byteLength,
            fallback_text: `<attached_resource media_type="application/pdf" encoding="base64" name="locked.pdf" id="pdf">\n${unparsed.toString("base64")}\n</attached_resource>`,
        })
    })

    it("sends a document the extractor rejects as base64 text, or marks it unavailable beyond the budget", async () => {
        const small = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])
        const large = Buffer.alloc(Math.floor(MAX_ATTACHED_BASE64_TEXT_BYTES / 4) * 3 + 1)
        const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        const content = await buildAdmittedInputContent(
            {
                parts: [resource("small", docx, "small.docx"), text(" "), resource("large", docx, "large.docx")],
                opensTask: false,
            },
            reader({ small: { mediaType: docx, bytes: small }, large: { mediaType: docx, bytes: large } }),
        )

        const rendered = content[0]?.type === "text" ? content[0].text : ""
        expect(rendered).toContain(`encoding="base64" name="small.docx" id="small">\n${small.toString("base64")}\n`)
        expect(rendered).toContain(
            '<attached_resource name="large.docx" id="large">\n[The attached resource is unavailable: semantic_input_resource_too_large]',
        )
    })

    it("marks every resource unavailable when no reader was provided", async () => {
        const content = await buildAdmittedInputContent(
            { parts: [resource("img", "image/png", "shot.png")], opensTask: false },
            undefined,
        )

        expect(content[0]).toMatchObject({
            type: "text",
            text: expect.stringContaining("semantic_input_resource_open_failed"),
        })
    })

    it("opens a task as the task and keeps submission context in its own block", async () => {
        const content = await buildAdmittedInputContent(
            { parts: [text("build it"), resource("img", "image/png", "ui.png")], context: "hook context", opensTask: true },
            reader({ img: { mediaType: "image/png", bytes: PNG_BYTES } }),
        )

        expect(content.map((block) => block.type)).toEqual(["text", "image", "text", "text"])
        expect(content[0]).toEqual({
            type: "text",
            text: '<task>\nbuild it<image_ref name="ui.png" id="img" />\n</task>\n<image name="ui.png" id="img">\n',
        })
        expect(content[2]).toEqual({ type: "text", text: "\n</image>" })
        expect(content[3]).toEqual({ type: "text", text: "<context>\nhook context\n</context>" })
    })

    it("appends submission context inside a later message, after what the user typed", async () => {
        const content = await buildAdmittedInputContent(
            { parts: [text("next"), resource("img", "image/png", "a.png")], context: "spawn handoff", opensTask: false },
            reader({ img: { mediaType: "image/png", bytes: PNG_BYTES } }),
        )

        expect(content[0]).toEqual({
            type: "text",
            text: '<user_message>\nnext<image_ref name="a.png" id="img" />\n\nspawn handoff\n</user_message>\n<image name="a.png" id="img">\n',
        })
    })
})
