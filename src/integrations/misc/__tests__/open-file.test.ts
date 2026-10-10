import { describe, expect, it } from "vitest"
import { shouldOpenViaGenericCommand } from "../open-file"

describe("shouldOpenViaGenericCommand", () => {
    it("returns false for text file types (kept in the text editor)", () => {
        expect(shouldOpenViaGenericCommand("/w/readme.md")).toBe(false)
        expect(shouldOpenViaGenericCommand("/w/src/main.ts")).toBe(false)
        expect(shouldOpenViaGenericCommand("/w/notes.txt")).toBe(false)
        expect(shouldOpenViaGenericCommand("/w/page.html")).toBe(false)
        expect(shouldOpenViaGenericCommand("/w/config.json")).toBe(false)
    })

    it("returns false for files without an extension", () => {
        expect(shouldOpenViaGenericCommand("/w/LICENSE")).toBe(false)
    })

    it("returns true for images", () => {
        expect(shouldOpenViaGenericCommand("/w/screenshot.png")).toBe(true)
        expect(shouldOpenViaGenericCommand("/w/photo.jpg")).toBe(true)
        expect(shouldOpenViaGenericCommand("/w/photo.jpeg")).toBe(true)
        expect(shouldOpenViaGenericCommand("/w/icon.webp")).toBe(true)
        expect(shouldOpenViaGenericCommand("/w/anim.gif")).toBe(true)
        expect(shouldOpenViaGenericCommand("/w/logo.svg")).toBe(true)
    })

    it("returns true for documents", () => {
        expect(shouldOpenViaGenericCommand("/w/report.pdf")).toBe(true)
        expect(shouldOpenViaGenericCommand("/w/sheet.xlsx")).toBe(true)
        expect(shouldOpenViaGenericCommand("/w/doc.docx")).toBe(true)
        expect(shouldOpenViaGenericCommand("/w/archive.zip")).toBe(true)
    })

    it("is case-insensitive on the extension", () => {
        expect(shouldOpenViaGenericCommand("/w/SCREENSHOT.PNG")).toBe(true)
        expect(shouldOpenViaGenericCommand("/w/README.MD")).toBe(false)
    })
})
