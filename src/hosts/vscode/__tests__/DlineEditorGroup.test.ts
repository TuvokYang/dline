import { describe, expect, it, vi } from "vitest"
import type { WebviewPanel } from "vscode"
import { ViewColumn } from "vscode"
import { DlineEditorGroup } from "../DlineEditorGroup"

function createPanel(viewColumn: ViewColumn | undefined, active = true) {
    return {
        active,
        viewColumn,
        reveal: vi.fn(),
    } as unknown as WebviewPanel
}

describe("DlineEditorGroup", () => {
    it("opens the first panel beside and later new panels in its resolved column", () => {
        const group = new DlineEditorGroup()

        expect(group.getCreateViewColumn()).toBe(ViewColumn.Beside)
        group.register(createPanel(ViewColumn.Two))

        expect(group.getCreateViewColumn()).toBe(ViewColumn.Two)
    })

    it("preserves a restored panel in the VS Code column that owns it", () => {
        const group = new DlineEditorGroup()
        const existingPanel = createPanel(ViewColumn.Two)
        const restoredPanel = createPanel(ViewColumn.Three)
        group.register(existingPanel)

        group.register(restoredPanel)

        expect(restoredPanel.reveal).not.toHaveBeenCalled()
    })

    it("uses the first panel column for later panels after VS Code resolves it", () => {
        const group = new DlineEditorGroup()
        const pendingPanel = createPanel(undefined)
        group.register(pendingPanel)

        Object.defineProperty(pendingPanel, "viewColumn", { configurable: true, value: ViewColumn.Two })
        group.synchronize(pendingPanel)

        expect(group.getCreateViewColumn()).toBe(ViewColumn.Two)
        expect(pendingPanel.reveal).not.toHaveBeenCalled()
    })

    it("clears the target column after the last panel is removed", () => {
        const group = new DlineEditorGroup()
        const panel = createPanel(ViewColumn.Two)
        group.register(panel)

        group.unregister(panel)

        expect(group.getCreateViewColumn()).toBe(ViewColumn.Beside)
    })

    it("does not move a panel when its view state changes", () => {
        const group = new DlineEditorGroup()
        const panel = createPanel(ViewColumn.Two)
        group.register(panel)

        group.synchronize(panel)

        expect(panel.reveal).not.toHaveBeenCalled()
    })
})
