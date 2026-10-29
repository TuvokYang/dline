import type { Controller } from "@core/controller"
import { WebviewProvider } from "@core/webview"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import { getContextForCommand } from "../commandUtils"
import { resolveEditorCommandTarget } from "../editorCommandRouting"

vi.mock("@/registry", () => ({
    ExtensionRegistryInfo: { commands: { FocusChatInput: "dline.focusChatInput" } },
}))

interface MockSidebarProvider {
    controller: Controller
}

function createEditor() {
    const selection = new vscode.Range(0, 0, 0, 12)
    return {
        selection,
        document: {
            uri: { fsPath: "e:\\workspace\\sample.ts" },
            languageId: "typescript",
            getText: vi.fn(() => "const answer"),
        },
    }
}

describe("editor command routing", () => {
    afterEach(() => {
        vi.restoreAllMocks()
        Reflect.deleteProperty(vscode.window, "activeTextEditor")
    })

    it("routes a busy sidebar command to an independent editor panel controller", async () => {
        const sidebarController = { task: { taskId: "sidebar-task" }, context: {} } as unknown as Controller
        const panelController = { task: undefined, context: {} } as unknown as Controller
        const sidebar = { controller: sidebarController } as unknown as WebviewProvider
        const showSidebar = vi.fn()
        const createPanel = vi.fn(async () => panelController)

        const result = await resolveEditorCommandTarget(sidebar, {}, { showSidebar, createPanel })

        expect(createPanel).toHaveBeenCalledOnce()
        expect(showSidebar).not.toHaveBeenCalled()
        expect(result).toEqual({ controller: panelController, surface: "panel" })
        expect(result.controller).not.toBe(sidebarController)
    })

    it("reuses and reveals an idle sidebar without creating a panel", async () => {
        const sidebarController = { task: undefined, context: {} } as unknown as Controller
        const sidebar = { controller: sidebarController } as unknown as WebviewProvider
        const showSidebar = vi.fn()
        const createPanel = vi.fn()

        const result = await resolveEditorCommandTarget(sidebar, {}, { showSidebar, createPanel })

        expect(result).toEqual({ controller: sidebarController, surface: "sidebar" })
        expect(createPanel).not.toHaveBeenCalled()
        expect(showSidebar).toHaveBeenCalledWith(false)
    })

    it("captures editor context before revealing the sidebar changes focus", async () => {
        const sidebarController = { task: undefined, context: {} } as unknown as Controller
        const sidebar = { controller: sidebarController } as unknown as MockSidebarProvider
        const editor = createEditor()
        Object.defineProperty(vscode.window, "activeTextEditor", { configurable: true, value: editor })
        vi.spyOn(WebviewProvider, "getInstance").mockReturnValue(sidebar as unknown as WebviewProvider)
        vi.spyOn(vscode.commands, "executeCommand").mockImplementation(async () => {
            Reflect.deleteProperty(vscode.window, "activeTextEditor")
        })

        const result = await getContextForCommand()

        expect(editor.document.getText).toHaveBeenCalledOnce()
        expect(result?.commandContext.selectedText).toBe("const answer")
    })

    it("allows notebook commands to explicitly reuse a busy sidebar", async () => {
        const sidebarController = { task: { taskId: "sidebar-task" }, context: {} } as unknown as Controller
        const sidebar = { controller: sidebarController } as unknown as WebviewProvider
        const showSidebar = vi.fn()
        const createPanel = vi.fn()

        const result = await resolveEditorCommandTarget(sidebar, { reuseBusySidebar: true }, { showSidebar, createPanel })

        expect(result).toEqual({ controller: sidebarController, surface: "sidebar" })
        expect(createPanel).not.toHaveBeenCalled()
        expect(showSidebar).toHaveBeenCalledWith(false)
    })
})
