import "@testing-library/jest-dom/vitest"
import { SEMANTIC_INPUT_SCHEMA_VERSION, type SemanticInputDocument } from "@shared/input-semantics/document"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { InputQueuePanel, type InputQueuePanelEntry, queuedAttachmentsOf } from "./InputQueuePanel"

const { openInputResource } = vi.hoisted(() => ({ openInputResource: vi.fn(async () => ({})) }))

vi.mock("@/services/grpc-client", () => ({
    FileServiceClient: { openInputResource, openFileRelativePath: vi.fn(async () => ({})) },
}))

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
        const body = screen.getByTestId("input-queue-markdown-a")
        expect(body).toHaveTextContent(/^look/)
        expect(body).not.toHaveTextContent("r-image")
        expect(body).not.toHaveTextContent("[shot.png]")
    })

    // The queue names each resource the way the composer drew it, not as bracketed text.
    it("draws each resource of a composed entry as its chip, in place", () => {
        render(<InputQueuePanel entries={[entry({ id: "a", semanticInput: composedDocument() })]} {...handlers()} />)
        fireEvent.click(screen.getByTestId("input-queue-toggle"))

        const chips = Array.from(screen.getByTestId("input-queue-markdown-a").querySelectorAll("[data-resource-chip]"))
        expect(chips.map((chip) => chip.querySelector(".composer-chip__label")?.textContent)).toEqual(["shot.png", "paste.txt"])
        expect(chips[0].querySelector(".codicon-file-media")).not.toBeNull()
        expect(chips[1].querySelector(".composer-chip__badge")).toHaveTextContent("TXT")
        // Without a reference the task holds, a chip has nothing to open.
        expect(chips.every((chip) => chip.tagName === "SPAN")).toBe(true)
    })

    it("opens a resource the task holds from its chip without touching the entry", () => {
        const document: SemanticInputDocument = {
            ...composedDocument(),
            resources: [
                {
                    resourceId: "r-image",
                    expectedContentHash: "hash",
                    mediaType: "image/png",
                    byteLength: 4,
                    owner: { kind: "task", taskId: "task-1" },
                    generation: 1,
                },
            ],
        }
        const props = handlers()
        render(<InputQueuePanel entries={[entry({ id: "a", semanticInput: document })]} {...props} />)
        fireEvent.click(screen.getByTestId("input-queue-toggle"))

        fireEvent.click(screen.getByRole("button", { name: "Image shot.png, PNG" }))

        expect(openInputResource).toHaveBeenCalledTimes(1)
        expect(openInputResource.mock.calls[0]).toEqual([
            expect.objectContaining({ ref: expect.objectContaining({ resourceId: "r-image" }) }),
        ])
        expect(props.onEdit).not.toHaveBeenCalled()
    })

    it("shows a legacy entry's text as written, without chips", () => {
        render(<InputQueuePanel entries={[entry({ id: "a", text: "see [shot.png]" })]} {...handlers()} />)
        fireEvent.click(screen.getByTestId("input-queue-toggle"))

        const body = screen.getByTestId("input-queue-markdown-a")
        expect(body).toHaveTextContent("see [shot.png]")
        expect(body.querySelector("[data-resource-chip]")).toBeNull()
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
