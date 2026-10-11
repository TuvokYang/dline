import { describe, expect, it } from "vitest"
import { classifyPaste, type PasteClipboardItem } from "../paste-intent"

const OPEN = { attachmentsEnabled: true, hasFreeSlot: true }

function imageItem(type: string, name = "shot.png"): PasteClipboardItem {
    const file = new File([new Uint8Array([1, 2, 3])], name, { type })
    return { type, getAsFile: () => file }
}

function linesOf(count: number): string {
    return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
}

describe("classifyPaste", () => {
    it("takes over a bare URL so a separating space can follow it", () => {
        expect(classifyPaste("  https://example.com/compact  ", [], OPEN)).toEqual({
            kind: "url",
            url: "https://example.com/compact",
        })
    })

    it("applies the inline budget before treating a paste as a URL", () => {
        const longUrl = `https://example.com/${"a".repeat(5000)}`

        expect(classifyPaste(longUrl, [], OPEN)).toEqual({ kind: "oversized_text", text: longUrl })
        expect(classifyPaste(longUrl, [], { attachmentsEnabled: true, hasFreeSlot: false })).toEqual({
            kind: "refused_text",
        })
    })

    it("stores an oversized paste as a file instead of letting the browser insert it", () => {
        const text = linesOf(24)

        expect(classifyPaste(text, [], OPEN)).toEqual({ kind: "oversized_text", text })
    })

    it("leaves a paste within the inline budget to the browser", () => {
        expect(classifyPaste(linesOf(3), [], OPEN)).toEqual({ kind: "native" })
    })

    it.each([
        ["no attachment slot is free", { attachmentsEnabled: true, hasFreeSlot: false }],
        ["attachments are disabled", { attachmentsEnabled: false, hasFreeSlot: true }],
    ])("refuses an oversized paste instead of inlining it when %s", (_label, capacity) => {
        expect(classifyPaste(linesOf(20), [], capacity)).toEqual({ kind: "refused_text" })
        expect(classifyPaste("x".repeat(5000), [], capacity)).toEqual({ kind: "refused_text" })
    })

    it("still lets the browser inline text within the budget when attachments are disabled", () => {
        const disabled = { attachmentsEnabled: false, hasFreeSlot: false }

        expect(classifyPaste(linesOf(19), [], disabled)).toEqual({ kind: "native" })
        expect(classifyPaste("x".repeat(4999), [], disabled)).toEqual({ kind: "native" })
    })

    it("reads pasted image files during the paste, not after it", () => {
        const intent = classifyPaste("", [imageItem("image/png"), imageItem("text/plain")], OPEN)

        expect(intent.kind).toBe("images")
        if (intent.kind !== "images") return
        expect(intent.files.map((file) => file.name)).toEqual(["shot.png"])
    })

    it("ignores image formats no provider accepts", () => {
        expect(classifyPaste("", [imageItem("image/gif", "anim.gif")], OPEN)).toEqual({ kind: "native" })
    })

    it("never takes over pasted images when attachments are disabled", () => {
        const disabled = { attachmentsEnabled: false, hasFreeSlot: true }

        expect(classifyPaste("caption", [imageItem("image/png")], disabled)).toEqual({ kind: "native" })
    })
})
