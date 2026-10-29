import * as fs from "fs/promises"
import * as vscode from "vscode"
import { sanitizeCellForLLM } from "@/integrations/misc/notebook-utils"
import { ExtensionRegistryInfo } from "@/registry"
import { CommandContext } from "@/shared/proto/dline"
import { Logger } from "@/shared/services/Logger"
import { Controller } from "../../core/controller"
import { WebviewProvider } from "../../core/webview"
import { type EditorCommandRoutingOptions, resolveEditorCommandTarget } from "./editorCommandRouting"
import { convertVscodeDiagnostics } from "./hostbridge/workspace/getDiagnostics"

/**
 * Finds the notebook cell that contains the selected text and returns its JSON representation
 * @param filePath Path to the .ipynb file
 * @param notebookCell The cell index from the active notebook editor
 * @returns JSON string of the matching cell, or null if no match found
 */
export async function findMatchingNotebookCell(filePath: string, notebookCell?: number): Promise<string | null> {
    try {
        // Read the notebook file directly
        const notebookContent = await fs.readFile(filePath, "utf8")
        const notebook = JSON.parse(notebookContent)

        if (!notebook.cells || !Array.isArray(notebook.cells)) {
            Logger.log("Invalid notebook structure: no cells array found")
            return null
        }

        Logger.log(`Loaded notebook with ${notebook.cells.length} cells`)

        if (typeof notebookCell === "number" && notebookCell >= 0 && notebookCell < notebook.cells.length) {
            Logger.log(`Using provided notebook cell number ${notebookCell}`)
            // Get a reference to the specific cell object
            const cellToProcess = notebook.cells[notebookCell]

            // Sanitize the cell outputs (truncate images, keep text outputs)
            return sanitizeCellForLLM(cellToProcess)
        }

        Logger.log("No valid notebook cell number provided")
        return null
    } catch (error) {
        Logger.error("Error in findMatchingNotebookCell:", error)
        return null
    }
}

/**
 * Captures editor state before any Webview surface changes focus.
 */
export function getEditorCommandContext(
    range?: vscode.Range,
    vscodeDiagnostics?: vscode.Diagnostic[],
): CommandContext | undefined {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
        const activeNotebook = vscode.window.activeNotebookEditor
        if (!activeNotebook) {
            return
        }
        return {
            selectedText: "",
            filePath: activeNotebook.notebook.uri.fsPath,
            diagnostics: convertVscodeDiagnostics(vscodeDiagnostics || []),
            language: "",
        }
    }

    const textRange = range instanceof vscode.Range ? range : editor.selection
    return {
        selectedText: editor.document.getText(textRange),
        filePath: editor.document.uri.fsPath,
        diagnostics: convertVscodeDiagnostics(vscodeDiagnostics || []),
        language: editor.document.languageId,
    }
}

/**
 * Gets the captured editor context and routes the command to an isolated Controller when needed.
 */
export async function getContextForCommand(
    range?: vscode.Range,
    vscodeDiagnostics?: vscode.Diagnostic[],
    options: EditorCommandRoutingOptions = {},
): Promise<
    | undefined
    | {
          controller: Controller
          commandContext: CommandContext
          surface: "sidebar" | "panel"
      }
> {
    const commandContext = getEditorCommandContext(range, vscodeDiagnostics)
    if (!commandContext) {
        return
    }

    const sidebar = WebviewProvider.getInstance()
    if (!sidebar) {
        return
    }

    const target = await resolveEditorCommandTarget(sidebar, options, {
        showSidebar: async (preserveEditorFocus) => {
            await vscode.commands.executeCommand(ExtensionRegistryInfo.commands.FocusChatInput, preserveEditorFocus)
        },
        createPanel: async (title, sidebarProvider) => {
            const { VscodeWebviewPanelProvider } = await import("./VscodeWebviewPanelProvider")
            const panelProvider = new VscodeWebviewPanelProvider(sidebarProvider.context, { deferController: false })
            try {
                await panelProvider.createPanel(title)
                return panelProvider.controller
            } catch (error) {
                await panelProvider.dispose().catch(() => undefined)
                throw error
            }
        },
    })

    return { ...target, commandContext }
}

export async function showWebview(preserveEditorFocus = true): Promise<WebviewProvider | undefined> {
    await vscode.commands.executeCommand(ExtensionRegistryInfo.commands.FocusChatInput, preserveEditorFocus)

    return WebviewProvider.getInstance()
}
