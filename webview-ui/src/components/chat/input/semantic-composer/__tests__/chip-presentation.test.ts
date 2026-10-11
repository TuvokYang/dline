import { act, fireEvent, render } from "@testing-library/react"
import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { createReadyResourceAtom, createStagingResourceAtom, failedResourceAtom } from "../atoms"
import { describeChip } from "../chip-presentation"
import { SemanticComposerEngine } from "../engine"
import { type CommandAtom, type ComposerSegment, caretAt, flatTextOf, type MentionAtom, type ResourceAtom } from "../model"
import { SemanticComposerEditor } from "../SemanticComposerEditor"

interface FormatCase {
    readonly displayName: string
    readonly mediaType: string
    readonly nodeKind?: "image" | "file"
    readonly icon: string
    readonly badge: string
    readonly kindName: string
}

/** One case per format the composer must tell apart (VER-TASK-4105-UI). */
const FORMAT_CASES: readonly FormatCase[] = [
    { displayName: "report.pdf", mediaType: "application/pdf", icon: "file-pdf", badge: "PDF", kindName: "PDF document" },
    { displayName: "notes.txt", mediaType: "text/plain", icon: "note", badge: "TXT", kindName: "Text file" },
    {
        displayName: "spec.docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        icon: "book",
        badge: "DOCX",
        kindName: "Document",
    },
    {
        displayName: "budget.xlsx",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        icon: "table",
        badge: "XLSX",
        kindName: "Spreadsheet",
    },
    {
        displayName: "analysis.ipynb",
        mediaType: "application/x-ipynb+json",
        icon: "notebook",
        badge: "IPYNB",
        kindName: "Notebook",
    },
    { displayName: "rows.csv", mediaType: "text/csv", icon: "json", badge: "CSV", kindName: "Data file" },
    { displayName: "config.json", mediaType: "application/json", icon: "json", badge: "JSON", kindName: "Data file" },
    { displayName: "feed.xml", mediaType: "application/xml", icon: "json", badge: "XML", kindName: "Data file" },
    { displayName: "build.log", mediaType: "text/plain", icon: "note", badge: "LOG", kindName: "Text file" },
    { displayName: "main.ts", mediaType: "text/plain", icon: "file-code", badge: "TS", kindName: "Code file" },
    { displayName: "blob.bin", mediaType: "application/octet-stream", icon: "file", badge: "BIN", kindName: "File" },
    { displayName: "LICENSE", mediaType: "application/octet-stream", icon: "file", badge: "FILE", kindName: "File" },
    { displayName: "shot.png", mediaType: "image/png", nodeKind: "image", icon: "file-media", badge: "PNG", kindName: "Image" },
]

function readyAtomOf(format: FormatCase, entityId?: string): ResourceAtom {
    return createReadyResourceAtom(
        {
            ref: {
                resourceId: `res-${format.displayName}`,
                expectedContentHash: `sha256:${format.displayName}`,
                mediaType: format.mediaType,
                byteLength: 10,
                owner: { kind: "draft", draftId: "draft-1" },
                generation: 1,
            },
            displayName: format.displayName,
            nodeKind: format.nodeKind ?? "file",
            fileOrigin: "uploaded_file",
        },
        entityId,
    )
}

describe("describeChip for resources", () => {
    it.each(FORMAT_CASES)("shows $displayName as $kindName with a $badge badge", (format) => {
        const chip = describeChip(readyAtomOf(format))

        expect(chip).toMatchObject({
            icon: format.icon,
            badge: format.badge,
            label: format.displayName,
            tone: "resource",
            busy: false,
        })
        expect(chip.ariaLabel).toBe(`${format.kindName} ${format.displayName}, ${format.badge}`)
        expect(chip.tooltip).toContain("Press Enter to open, Backspace to remove.")
        expect(chip.plainText).toBe("")
    })

    it("never shows two formats the same way", () => {
        const looks = FORMAT_CASES.map((format) => {
            const chip = describeChip(readyAtomOf(format))
            return `${chip.icon}|${chip.badge}`
        })
        expect(new Set(looks).size).toBe(FORMAT_CASES.length)
    })

    it("trusts a specific verified media type over the name the user gave", () => {
        const chip = describeChip(
            readyAtomOf({ displayName: "invoice.pdf", mediaType: "application/json", icon: "", badge: "", kindName: "" }),
        )
        expect(chip).toMatchObject({ icon: "json", badge: "JSON" })
    })

    it("speaks the line count of a pasted text", () => {
        const atom = { ...readyAtomOf(FORMAT_CASES[1]), fileOrigin: "pasted_text" as const, lineCount: 120 }
        const chip = describeChip(atom)
        expect(chip.ariaLabel).toBe("Text file notes.txt, TXT, 120 lines")
        expect(chip.tooltip).toContain("(TXT, 120 lines)")
    })

    it("marks a resource that is still attaching as busy", () => {
        const chip = describeChip(
            createStagingResourceAtom({ nodeKind: "file", fileOrigin: "uploaded_file", displayName: "spec.docx" }),
        )
        expect(chip).toMatchObject({ icon: "loading", tone: "warning", busy: true, badge: "DOCX" })
        expect(chip.ariaLabel).toBe("Document spec.docx, DOCX, attaching")
    })

    it("names the failure of a resource that could not be attached", () => {
        const failed = failedResourceAtom(
            createStagingResourceAtom({ nodeKind: "file", fileOrigin: "uploaded_file", displayName: "huge.log" }),
            {
                code: "input_resource_too_large",
                message: "The file is larger than 20 MB.",
            },
        )
        const chip = describeChip(failed)
        expect(chip).toMatchObject({ icon: "error", tone: "error", busy: false, badge: "LOG" })
        expect(chip.ariaLabel).toBe("Text file huge.log, LOG, failed: The file is larger than 20 MB.")
        expect(chip.tooltip).toBe("huge.log: The file is larger than 20 MB.")
    })
})

describe("resource chips in the editor", () => {
    function renderBetween(atom: ResourceAtom) {
        const segments: ComposerSegment[] = [
            { kind: "text", text: "see ", source: "typed" },
            { kind: "atom", atom },
            { kind: "text", text: " now", source: "typed" },
        ]
        const engine = new SemanticComposerEngine({ initial: { segments, selection: caretAt(0), revision: 0 } })
        const onChipAction = vi.fn()
        const view = render(
            createElement(SemanticComposerEditor, {
                ariaLabel: "Message",
                composerId: "c",
                engine,
                onChipAction,
                testId: "chat-input",
            }),
        )
        const root = view.getByTestId("chat-input")
        const chip = root.querySelector<HTMLElement>(`[data-entity-id="${atom.entityId}"]`)
        if (!chip) throw new Error("chip expected")
        return { engine, root, chip, onChipAction }
    }

    it.each(FORMAT_CASES)("draws $displayName where it was inserted, opens it and removes it", (format) => {
        const atom = readyAtomOf(format, `entity-${format.displayName}`)
        const { engine, root, chip, onChipAction } = renderBetween(atom)

        expect(chip.previousElementSibling?.textContent).toBe("see ")
        expect(chip.nextElementSibling?.textContent).toBe(" now")
        expect(chip.getAttribute("aria-label")).toBe(`${format.kindName} ${format.displayName}, ${format.badge}`)
        expect(chip.dataset.status).toBe("ready")
        expect(chip.querySelector(".composer-chip__icon")?.classList.contains(`codicon-${format.icon}`)).toBe(true)
        expect(chip.querySelector(".composer-chip__badge")?.textContent).toBe(format.badge)

        act(() => engine.apply({ type: "select", selection: { anchor: 4, focus: 5 } }))
        fireEvent.keyDown(root, { key: "Enter" })
        expect(onChipAction).toHaveBeenCalledWith(atom, "open")

        const remove = chip.querySelector('[data-chip-action="remove"]')
        if (!remove) throw new Error("remove control expected")
        fireEvent.mouseDown(remove)
        expect(flatTextOf(engine.getState().segments)).toBe("see  now")
        expect(onChipAction).toHaveBeenLastCalledWith(atom, "remove")
    })

    it("offers retry only on a failed resource it can stage again", () => {
        const failed = failedResourceAtom(
            createStagingResourceAtom({ nodeKind: "file", fileOrigin: "uploaded_file", displayName: "a.ts" }),
            {
                code: "input_resource_unreadable",
                message: "Unreadable.",
                retryable: true,
            },
        )
        const { chip, onChipAction } = renderBetween(failed)
        expect(chip.dataset.status).toBe("failed")

        const retry = chip.querySelector('[data-chip-action="retry"]')
        if (!retry) throw new Error("retry control expected")
        fireEvent.mouseDown(retry)
        expect(onChipAction).toHaveBeenCalledWith(failed, "retry")
    })
})

describe("describeChip for commands and mentions", () => {
    it("reads a command as its source text", () => {
        const command: CommandAtom = {
            kind: "command",
            entityId: "c1",
            commandId: "command.compact",
            canonicalName: "compact",
            sourceText: "/compact",
        } as CommandAtom
        expect(describeChip(command)).toMatchObject({
            icon: "symbol-event",
            label: "/compact",
            tone: "command",
            plainText: "/compact",
        })
        expect(describeChip(command).badge).toBeUndefined()
    })

    it.each([
        ["file", "mention"],
        ["folder", "folder"],
        ["url", "link"],
    ] as const)("gives a %s mention the %s icon", (mentionKind, icon) => {
        const mention = { kind: "mention", entityId: "m1", mentionKind, sourceText: "@src/a.ts" } as unknown as MentionAtom
        expect(describeChip(mention)).toMatchObject({ icon, label: "src/a.ts", tone: "mention", plainText: "@src/a.ts" })
    })
})
