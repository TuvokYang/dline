import * as vscode from "vscode"
import type { TreeChangeListener, WorkspaceTreeWatchHost } from "@/services/file-watch/WorkspaceTreeWatchHost"

/**
 * Serves supported workspace watches from VS Code's existing recursive watcher.
 *
 * Windows and macOS reuse the host's `**` watch without opening another handle
 * inside the workspace; Linux keeps the filtered path backend for nested changes.
 * Host-served paths respect `files.watcherExclude` as they do in the editor.
 */
export class VscodeWorkspaceTreeWatch implements WorkspaceTreeWatchHost {
    constructor(private readonly platform: NodeJS.Platform = process.platform) {}

    roots(): readonly string[] {
        // Linux host events can miss later writes beneath a newly created directory tree.
        // Keep those paths on watchPaths' filtered chokidar backend, not a second host watch.
        if (this.platform === "linux") return []
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
