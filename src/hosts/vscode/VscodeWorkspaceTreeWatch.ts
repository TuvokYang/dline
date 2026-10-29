import * as vscode from "vscode"
import type { TreeChangeListener, WorkspaceTreeWatchHost } from "@/services/file-watch/WorkspaceTreeWatchHost"

/**
 * Serves Dline's workspace watches from VS Code's own file watcher.
 *
 * A `**` pattern below a workspace folder is answered by the recursive watcher
 * VS Code already runs for that folder, so no further handle is opened inside
 * the workspace and `files.watcherExclude` applies as it does for the editor.
 */
export class VscodeWorkspaceTreeWatch implements WorkspaceTreeWatchHost {
    roots(): readonly string[] {
        return (vscode.workspace.workspaceFolders ?? [])
            .filter((folder) => folder.uri.scheme === "file")
            .map((folder) => folder.uri.fsPath)
    }

    watchTree(root: string, listener: TreeChangeListener): () => void {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), "**"))
        const subscriptions = [
            watcher.onDidCreate((uri) => listener("created", uri.fsPath)),
            watcher.onDidChange((uri) => listener("changed", uri.fsPath)),
            watcher.onDidDelete((uri) => listener("deleted", uri.fsPath)),
        ]
        return () => {
            for (const subscription of subscriptions) subscription.dispose()
            watcher.dispose()
        }
    }
}
