import path from "path"
import * as vscode from "vscode"
import { OpenMultiFileDiffRequest, OpenMultiFileDiffResponse } from "@/shared/proto/dline/host"
import { Logger } from "@/shared/services/Logger"
import { getCwd } from "@/utils/path"
import { DIFF_VIEW_URI_SCHEME } from "../../VscodeDiffViewProvider"

const openedMultiDiffTabs = new Set<vscode.Tab>()
const comparedFilePaths = new Set<string>()
const DOCUMENT_CLOSE_TIMEOUT_MS = 2_000

export async function openMultiFileDiff(request: OpenMultiFileDiffRequest): Promise<OpenMultiFileDiffResponse> {
    const cwd = await getCwd()
    for (const diff of request.diffs) {
        if (diff.filePath) comparedFilePaths.add(normalizePath(diff.filePath))
    }
    const tabsBeforeOpen = new Set(vscode.window.tabGroups.all.flatMap((group) => group.tabs))
    await vscode.commands.executeCommand(
        "vscode.changes",
        request.title,
        request.diffs.map((diff) => {
            const file = vscode.Uri.file(diff.filePath || "")
            const relativePath = path.relative(cwd, diff.filePath || "")
            const left = diff.leftContent ?? ""
            const right = diff.rightContent ?? ""
            return [
                file,
                vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${relativePath}`).with({
                    query: Buffer.from(left).toString("base64"),
                }),
                vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${relativePath}`).with({
                    query: Buffer.from(right).toString("base64"),
                }),
            ]
        }),
    )
    for (const tab of vscode.window.tabGroups.all.flatMap((group) => group.tabs)) {
        if (!tabsBeforeOpen.has(tab)) openedMultiDiffTabs.add(tab)
    }

    // Hide the bottom panel to give more room for the diff view
    vscode.commands.executeCommand("workbench.action.closePanel")

    return {}
}

/** Close only Dline-owned compare views and clean editors for the compared paths. */
export async function closeOpenedMultiFileDiffs(): Promise<void> {
    const pathsToRelease = new Set(comparedFilePaths)
    const currentTabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs)
    const tabsToClose = new Set(openedMultiDiffTabs)
    for (const tab of currentTabs) {
        if (!tab.isDirty && tabTargetsComparedPath(tab, pathsToRelease)) tabsToClose.add(tab)
    }
    openedMultiDiffTabs.clear()
    comparedFilePaths.clear()
    const currentTabSet = new Set(currentTabs)
    for (const tab of tabsToClose) {
        if (currentTabSet.has(tab)) await vscode.window.tabGroups.close(tab)
    }
    await waitForCleanFileDocumentsToClose(pathsToRelease)
}

function tabTargetsComparedPath(tab: vscode.Tab, comparedPaths: ReadonlySet<string>): boolean {
    if (tab.input instanceof vscode.TabInputText) {
        return comparedPaths.has(normalizePath(tab.input.uri.fsPath))
    }
    return (
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.original.scheme === DIFF_VIEW_URI_SCHEME &&
        comparedPaths.has(normalizePath(tab.input.modified.fsPath))
    )
}

async function waitForCleanFileDocumentsToClose(comparedPaths: ReadonlySet<string>): Promise<void> {
    const hasMatchingDocument = () =>
        vscode.workspace.textDocuments.some(
            (document) =>
                document.uri.scheme === "file" && !document.isDirty && comparedPaths.has(normalizePath(document.uri.fsPath)),
        )
    if (!hasMatchingDocument()) return

    await new Promise<void>((resolve) => {
        let timeout: NodeJS.Timeout | undefined
        let subscription: vscode.Disposable | undefined
        const finish = () => {
            if (timeout) clearTimeout(timeout)
            subscription?.dispose()
            resolve()
        }
        subscription = vscode.workspace.onDidCloseTextDocument(() => {
            if (!hasMatchingDocument()) finish()
        })
        timeout = setTimeout(finish, DOCUMENT_CLOSE_TIMEOUT_MS)
        if (!hasMatchingDocument()) finish()
    })

    if (hasMatchingDocument()) {
        Logger.warn("[DiffHost] Timed out waiting for compared clean text documents to close before restore")
    }
}

function normalizePath(filePath: string): string {
    const normalized = path.resolve(filePath).replaceAll("\\", "/")
    return process.platform === "win32" ? normalized.toLowerCase() : normalized
}
