/** What happened to a path below a watched tree. The host does not say whether it was a file or a directory. */
export type TreeChangeKind = "created" | "changed" | "deleted"

export type TreeChangeListener = (kind: TreeChangeKind, absolutePath: string) => void

/**
 * The editor's own recursive watch of the folders it has open.
 *
 * VS Code watches every workspace folder with one recursive watcher that holds
 * a single handle on the folder root, so any directory inside it can still be
 * renamed or deleted. A watch served from here therefore opens no handle of
 * its own inside the workspace and applies the user's `files.watcherExclude`,
 * exactly like the editor.
 */
export interface WorkspaceTreeWatchHost {
    /** Absolute paths of the folders the host watches recursively; read again on every call because folders change. */
    roots(): readonly string[]
    /** Report every change below `root` until the returned function is called. */
    watchTree(root: string, listener: TreeChangeListener): () => void
}
