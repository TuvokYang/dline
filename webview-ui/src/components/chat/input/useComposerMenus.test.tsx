import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { act, renderHook, waitFor } from "@testing-library/react"
import type React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ContextMenuOptionType } from "@/utils/context-mentions"
import type { SlashMenuEntry } from "@/utils/slash-commands"
import { SemanticComposerEngine } from "./semantic-composer/engine"
import { type ComposerAtom, caretAt, stateFromText } from "./semantic-composer/model"
import { useComposerMenus } from "./useComposerMenus"

const services = vi.hoisted(() => ({
    file: {
        refreshRules: vi.fn(),
        searchFiles: vi.fn(),
        searchCommits: vi.fn(),
    },
    slash: {
        getAvailableSlashCommands: vi.fn(),
        getInputSemanticCatalog: vi.fn(),
    },
}))

vi.mock("@/services/grpc-client", () => ({ FileServiceClient: services.file, SlashServiceClient: services.slash }))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        chatInputSendShortcut: undefined,
        mcpServers: [],
        localWorkflowToggles: {},
        globalWorkflowToggles: {},
        remoteWorkflowToggles: {},
        localSkillsToggles: {},
        globalSkillsToggles: {},
        remoteSkillsToggles: {},
        remoteConfigSettings: undefined,
        setLocalWorkflowToggles: vi.fn(),
        setGlobalWorkflowToggles: vi.fn(),
        setLocalSkillsToggles: vi.fn(),
        setGlobalSkillsToggles: vi.fn(),
    }),
}))

vi.mock("@/hooks/useTaskCapabilityToggles", () => ({
    useTaskCapabilityToggles: () => ({ snapshot: undefined, reconcile: vi.fn() }),
}))

const CATALOG = { revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS } as unknown as InputSemanticCatalog

function setup(initial = "") {
    const engine = new SemanticComposerEngine({ initial: stateFromText(initial) })
    const onPicked = vi.fn()
    const view = renderHook(() => useComposerMenus({ engine, catalog: CATALOG, onPicked }))
    const type = (text: string) => act(() => engine.apply({ type: "insert_text", text, source: "typed" }))
    const key = (name: string) => {
        const event = { key: name, preventDefault: vi.fn(), shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }
        let consumed = false
        act(() => {
            consumed = view.result.current.handleKeyDown(event as unknown as React.KeyboardEvent, false)
        })
        return consumed
    }
    const atoms = (): ComposerAtom[] =>
        engine.getState().segments.flatMap((segment) => (segment.kind === "atom" ? [segment.atom] : []))
    return { engine, view, type, key, atoms, onPicked }
}

beforeEach(() => {
    vi.clearAllMocks()
    services.slash.getAvailableSlashCommands.mockResolvedValue({ commands: [] })
    services.slash.getInputSemanticCatalog.mockResolvedValue({})
    services.file.refreshRules.mockResolvedValue({})
    services.file.searchFiles.mockResolvedValue({ results: [] })
    services.file.searchCommits.mockResolvedValue({ commits: [] })
})

describe("useComposerMenus slash menu", () => {
    it("opens when an edit leaves the caret completing a slash trigger", () => {
        const { view, type } = setup()
        expect(view.result.current.slash.open).toBe(false)

        type("/comp")

        expect(view.result.current.slash.open).toBe(true)
        expect(view.result.current.slash.entries.map((entry) => entry.commandId)).toContain("command.compact")
    })

    it("does not open when only the caret moves onto a trigger", () => {
        const { engine, view } = setup("/comp and more")
        act(() => engine.apply({ type: "select", selection: caretAt(5) }))
        expect(view.result.current.slash.open).toBe(false)
    })

    it("writes the picked command as an atom in place of the trigger text and closes", () => {
        const { view, type, atoms, onPicked } = setup()
        type("/comp")
        const entry = view.result.current.slash.entries.find((candidate) => candidate.commandId === "command.compact")
        if (!entry) throw new Error("compact entry expected")

        act(() => view.result.current.slash.select(entry))

        // The atom reads exactly as the row the user picked.
        expect(atoms()).toEqual([
            expect.objectContaining({ kind: "command", commandId: "command.compact", sourceText: entry.trigger }),
        ])
        expect(view.result.current.slash.open).toBe(false)
        expect(onPicked).toHaveBeenCalledOnce()
    })

    it("picks the highlighted entry with the keyboard", () => {
        const { view, type, key, atoms } = setup()
        type("/compact")
        expect(view.result.current.slash.selectedIndex).toBe(0)
        const highlighted = view.result.current.slash.entries[0]

        expect(key("Enter")).toBe(true)

        expect(atoms()).toEqual([
            expect.objectContaining({ kind: "command", commandId: highlighted.commandId, sourceText: highlighted.trigger }),
        ])
        expect(view.result.current.slash.open).toBe(false)
    })

    it("wraps the highlighted row with the arrow keys", () => {
        const { view, type, key } = setup()
        type("/")
        const count = view.result.current.slash.entries.length
        expect(count).toBeGreaterThan(1)

        key("ArrowUp")
        expect(view.result.current.slash.selectedIndex).toBe(count - 1)
        key("ArrowDown")
        expect(view.result.current.slash.selectedIndex).toBe(0)
    })

    it("closes on Escape without changing the draft", () => {
        const { engine, view, type, key } = setup()
        type("/comp")
        const before = engine.getState().segments

        expect(key("Escape")).toBe(true)

        expect(view.result.current.slash.open).toBe(false)
        expect(engine.getState().segments).toBe(before)
    })

    it("keeps the menu open and writes nothing when the catalog cannot resolve a pick", () => {
        const { engine, view, type } = setup()
        type("/comp")
        const before = engine.getState().segments
        const unknown: SlashMenuEntry = {
            ...view.result.current.slash.entries[0],
            commandId: "command.unknown",
            trigger: "/unknown",
        }
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

        act(() => view.result.current.slash.select(unknown))

        expect(engine.getState().segments).toBe(before)
        expect(view.result.current.slash.open).toBe(true)
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
    })

    it("closes on blur unless the blur came from clicking the menu", () => {
        const { view, type } = setup()
        const editor = focusableEditor()
        type("/comp")
        // Focus went to the body, as when the user clicks blank space in the webview.
        editor.blur()

        act(() => {
            view.result.current.onMenuMouseDown()
            view.result.current.onEditorBlur(blurOf(editor))
        })
        expect(view.result.current.slash.open).toBe(true)

        act(() => view.result.current.onEditorBlur(blurOf(editor)))
        expect(view.result.current.slash.open).toBe(false)
    })

    it("stays open when only the editor's window or frame loses focus", () => {
        const { view, type } = setup()
        const editor = focusableEditor()
        editor.focus()
        type("/comp")

        // Another window taking focus blurs the editor but leaves it the document's focused element.
        act(() => view.result.current.onEditorBlur(blurOf(editor)))
        expect(view.result.current.slash.open).toBe(true)

        const other = document.createElement("button")
        document.body.append(other)
        other.focus()
        act(() => view.result.current.onEditorBlur(blurOf(editor, other)))
        expect(view.result.current.slash.open).toBe(false)
    })
})

/** A focusable stand-in for the editor root, attached so the document can focus it. */
function focusableEditor(): HTMLElement {
    const editor = document.createElement("div")
    editor.tabIndex = 0
    document.body.append(editor)
    return editor
}

/** The blur React delivers for the editor, with the element focus moved to, if any. */
function blurOf(editor: HTMLElement, relatedTarget: Element | null = null): React.FocusEvent<HTMLElement> {
    return { currentTarget: editor, relatedTarget } as unknown as React.FocusEvent<HTMLElement>
}

describe("useComposerMenus mention menu", () => {
    it("opens on @ with the File row preselected", () => {
        const { view, type } = setup()
        type("see @")

        expect(view.result.current.mention.open).toBe(true)
        expect(view.result.current.mention.searchQuery).toBe("")
        expect(view.result.current.mention.selectedIndex).toBeGreaterThanOrEqual(0)
    })

    it("writes a picked mention as an atom in place of the trigger text", () => {
        const { view, type, atoms, onPicked } = setup()
        type("see @prob")

        act(() => view.result.current.mention.select(ContextMenuOptionType.Problems))

        expect(atoms()).toEqual([expect.objectContaining({ kind: "mention", sourceText: "@problems" })])
        expect(view.result.current.mention.open).toBe(false)
        expect(onPicked).toHaveBeenCalledOnce()
    })

    it("narrows to a category without writing anything", () => {
        const { engine, view, type } = setup()
        type("@")
        const before = engine.getState().segments

        act(() => view.result.current.mention.select(ContextMenuOptionType.File))

        expect(engine.getState().segments).toBe(before)
        expect(view.result.current.mention.selectedType).toBe(ContextMenuOptionType.File)
        expect(services.file.searchFiles).toHaveBeenCalledWith(expect.objectContaining({ query: "" }))
    })

    it("searches the workspace for the typed query and shows the latest results", async () => {
        services.file.searchFiles.mockResolvedValue({ results: [{ path: "/src/app.ts", type: "file", label: "app.ts" }] })
        const { view, type } = setup()
        type("@app")

        await waitFor(() => expect(services.file.searchFiles).toHaveBeenCalledWith(expect.objectContaining({ query: "app" })))
        await waitFor(() =>
            expect(view.result.current.mention.results).toEqual([expect.objectContaining({ path: "/src/app.ts" })]),
        )
        expect(view.result.current.mention.loading).toBe(false)
    })

    it("closes when an edit moves the caret off the trigger", () => {
        const { view, type } = setup()
        type("@src")
        expect(view.result.current.mention.open).toBe(true)

        type(" ")

        expect(view.result.current.mention.open).toBe(false)
    })
})
