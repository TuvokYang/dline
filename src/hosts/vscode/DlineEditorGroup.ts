import * as vscode from "vscode"

/** Tracks Dline panels without overriding VS Code's native editor-group layout. */
export class DlineEditorGroup {
    private readonly panels = new Set<vscode.WebviewPanel>()
    private createColumn: vscode.ViewColumn | undefined

    getCreateViewColumn(): vscode.ViewColumn {
        return this.createColumn ?? vscode.ViewColumn.Beside
    }

    register(panel: vscode.WebviewPanel): void {
        this.panels.add(panel)
        if (this.createColumn === undefined && this.isConcreteColumn(panel.viewColumn)) {
            this.createColumn = panel.viewColumn
        }
    }

    /** Capture the first resolved create column without moving restored or user-moved panels. */
    synchronize(panel: vscode.WebviewPanel): void {
        if (this.createColumn === undefined && this.panels.has(panel) && this.isConcreteColumn(panel.viewColumn)) {
            this.createColumn = panel.viewColumn
        }
    }

    unregister(panel: vscode.WebviewPanel): void {
        this.panels.delete(panel)
        if (this.panels.size === 0) this.createColumn = undefined
    }

    private isConcreteColumn(column: vscode.ViewColumn | undefined): column is vscode.ViewColumn {
        return typeof column === "number" && column >= vscode.ViewColumn.One
    }
}

export const dlineEditorGroup = new DlineEditorGroup()
