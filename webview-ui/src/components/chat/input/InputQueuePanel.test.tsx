import "@testing-library/jest-dom/vitest"
import { SEMANTIC_INPUT_SCHEMA_VERSION, type SemanticInputDocument } from "@shared/input-semantics/document"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { InputQueuePanel, type InputQueuePanelEntry, queuedAttachmentsOf } from "./InputQueuePanel"

class TestResizeObserver implements ResizeObserver {
    disconnect = vi.fn()
    observe = vi.fn()
    unobserve = vi.fn()
}

globalThis.ResizeObserver = TestResizeObserver

function entry(overrides: Partial<InputQueuePanelEntry> & { id: string }): InputQueuePanelEntry {
    return {
        text: `text-${overrides.id}`,
        images: [],
        files: [],
        mode: "queued",
        ...overrides,
    }
}

function composedDocument(): SemanticInputDocument {
    return {
        schemaVersion: SEMANTIC_INPUT_SCHEMA_VERSION,
        parserVersion: "test",
        catalogRevision: "test",
        documentId: "doc-1",
        rawText: "look ",
        nodes: [
            { kind: "text", text: "look " },
            { kind: "image", entityId: "e-image", resourceId: "r-image", displayName: "shot.png" },
            { kind: "file", entityId: "e-file", resourceId: "r-file", fileOrigin: "pasted_text", displayName: "paste.txt" },
        ],
        resources: [],
    }
}

function handlers() {
    return {
        onToggleMode: vi.fn(),
        onEdit: vi.fn(),
        onCancelEdit: vi.fn(),
        onRemove: vi.fn(),
        onReorder: vi.fn(),
    }
}

describe("InputQueuePanel", () => {
    it("renders nothing when the queue is empty", () => {
        const { container } = render(<InputQueuePanel entries={[]} {...handlers()} />)

        expect(container).toBeEmptyDOMElement()
    })

    it("summarizes the queue and its steering count while collapsed", () => {
        render(
            <InputQueuePanel
                entries={[entry({ id: "a" }), entry({ id: "b", mode: "steering" }), entry({ id: "c", mode: "steering" })]}
                {...handlers()}
            />,
        )

        const toggle = screen.getByTestId("input-queue-toggle")
        expect(toggle).toHaveTextContent("3")
        expect(toggle).toHaveTextContent("2")
        // Entries stay hidden until the user opens the panel.
        expect(screen.queryByTestId("input-queue-entry-a")).toBeNull()
    })

    it("reveals entries in order once expanded", () => {
        render(<InputQueuePanel entries={[entry({ id: "a" }), entry({ id: "b" })]} {...handlers()} />)

        fireEvent.click(screen.getByTestId("input-queue-toggle"))

        const rendered = screen.getAllByTestId(/^input-queue-entry-/)
        expect(rendered.map((node) => node.getAttribute("data-testid"))).toEqual(["input-queue-entry-a", "input-queue-entry-b"])
    })

    it("marks steering entries so they are visually distinct", () => {
        render(<InputQueuePanel entries={[entry({ id: "a" }), entry({ id: "b", mode: "steering" })]} {...handlers()} />)
        fireEvent.click(screen.getByTestId("input-queue-toggle"))

        expect(screen.getByTestId("input-queue-entry-a")).toHaveAttribute("data-mode", "queued")
        expect(screen.getByTestId("input-queue-entry-b")).toHaveAttribute("data-mode", "steering")
    })

    it("marks an editing entry as held by the composer", () => {
        render(<InputQueuePanel entries={[entry({ id: "a", editing: true })]} {...handlers()} />)
        fireEvent.click(screen.getByTestId("input-queue-toggle"))

        expect(screen.getByTestId("input-queue-entry-a")).toHaveAttribute("data-editing", "true")
    })

    // The send icon promotes an entry to steering; it must never deliver.
    it("requests a mode toggle without delivering", () => {
        const props = handlers()
        render(<InputQueuePanel entries={[entry({ id: "a" })]} {...props} />)
        fireEvent.click(screen.getByTestId("input-queue-toggle"))

        fireEvent.click(screen.getByTestId("input-queue-send-a"))

        expect(props.onToggleMode).toHaveBeenCalledWith("a")
    })

    it("requests edit and removal for the exact entry", () => {
        const props = handlers()
        render(<InputQueuePanel entries={[entry({ id: "a" }), entry({ id: "b" })]} {...props} />)
        fireEvent.click(screen.getByTestId("input-queue-toggle"))

        fireEvent.click(screen.getByTestId("input-queue-edit-b"))
        fireEvent.click(screen.getByTestId("input-queue-remove-a"))

        expect(props.onEdit).toHaveBeenCalledWith("b")
        expect(props.onRemove).toHaveBeenCalledWith("a")
    })

    // An entry under edit is blocked from delivery, so without this control the
    // user would have to send or delete it to get it moving again.
    it("offers a way out of an edit that does not send or delete the entry", () => {
        const props = handlers()
        render(<InputQueuePanel entries={[entry({ id: "a", editing: true })]} {...props} />)
        fireEvent.click(screen.getByTestId("input-queue-toggle"))

        expect(screen.queryByTestId("input-queue-edit-a")).toBeNull()
        fireEvent.click(screen.getByTestId("input-queue-cancel-edit-a"))

        expect(props.onCancelEdit).toHaveBeenCalledWith("a")
        expect(props.onRemove).not.toHaveBeenCalled()
        expect(props.onToggleMode).not.toHaveBeenCalled()
    })

    it("reports a drop as a reorder to the target index", () => {
        const props = handlers()
        render(<InputQueuePanel entries={[entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c" })]} {...props} />)
        fireEvent.click(screen.getByTestId("input-queue-toggle"))

        const source = screen.getByTestId("input-queue-entry-c")
        const target = screen.getByTestId("input-queue-entry-a")
        fireEvent.dragStart(source)
        fireEvent.drop(target)

        expect(props.onReorder).toHaveBeenCalledWith("c", 0)
    })

    // Cancel and the other footer actions must never shift when the queue opens.
    it("portals the bounded opaque surface out of the local queue root", () => {
        render(<InputQueuePanel entries={[entry({ id: "a" })]} {...handlers()} />)
        fireEvent.click(screen.getByTestId("input-queue-toggle"))

        const overlay = screen.getByTestId("input-queue-overlay")
        expect(screen.getByTestId("input-queue-root")).not.toContainElement(overlay)
        expect(overlay).toHaveAttribute("data-slot", "popover-content")
        expect(overlay).toHaveClass("w-(--radix-popover-trigger-width)", "max-h-[min(60vh,480px)]", "overflow-y-auto")
        expect(overlay.style.backgroundColor).toContain("--vscode-editorWidget-background")
        expect(screen.getByTestId("input-queue-markdown-a")).toHaveClass("max-h-[min(20vh,180px)]")
    })

    // A composed entry carries its attachments only as resource nodes; its flat lists are empty.
    it("shows the attachments of a composed entry from its resource nodes", () => {
        render(<InputQueuePanel entries={[entry({ id: "a", semanticInput: composedDocument() })]} {...handlers()} />)
        fireEvent.click(screen.getByTestId("input-queue-toggle"))

        const attachments = screen.getByTestId("input-queue-attachments-a")
        expect(attachments).toHaveTextContent("1 image, 1 file")
        expect(attachments).toHaveAttribute("title", "shot.png, paste.txt")
        expect(screen.getByTestId("input-queue-markdown-a")).toHaveTextContent("look [shot.png][paste.txt]")
        expect(screen.getByTestId("input-queue-markdown-a")).not.toHaveTextContent("r-image")
    })

    it("shows the flat attachments of an entry without a composed document", () => {
        render(
            <InputQueuePanel
                entries={[entry({ id: "a", images: ["data:image/png;base64,AA=="], files: ["C:\\work\\notes.md", "/tmp/b.ts"] })]}
                {...handlers()}
            />,
        )
        fireEvent.click(screen.getByTestId("input-queue-toggle"))

        const attachments = screen.getByTestId("input-queue-attachments-a")
        expect(attachments).toHaveTextContent("1 image, 2 files")
        expect(attachments).toHaveAttribute("title", "image, notes.md, b.ts")
    })

    it("shows no attachment summary for a text-only entry", () => {
        render(<InputQueuePanel entries={[entry({ id: "a" })]} {...handlers()} />)
        fireEvent.click(screen.getByTestId("input-queue-toggle"))

        expect(screen.queryByTestId("input-queue-attachments-a")).toBeNull()
    })
})

describe("queuedAttachmentsOf", () => {
    // The flat lists of a composed entry are the delivery bridge, never a second authority.
    it("ignores the flat lists when the entry carries a document", () => {
        const attachments = queuedAttachmentsOf({
            images: ["data:image/png;base64,AA=="],
            files: ["/tmp/bridge.txt"],
            semanticInput: composedDocument(),
        })

        expect(attachments).toEqual({ images: ["shot.png"], files: ["paste.txt"] })
    })

    it("falls back to the flat lists when the document holds no resource nodes", () => {
        const textOnly: SemanticInputDocument = {
            ...composedDocument(),
            rawText: "look",
            nodes: [{ kind: "text", text: "look", source: "typed" }] as unknown as SemanticInputDocument["nodes"],
            resources: [],
        }

        const attachments = queuedAttachmentsOf({
            images: ["data:image/png;base64,AA=="],
            files: ["/tmp/notes.txt"],
            semanticInput: textOnly,
        })

        expect(attachments).toEqual({ images: ["image"], files: ["notes.txt"] })
    })
})
