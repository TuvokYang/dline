import * as fs from "node:fs"
import * as vscode from "vscode"
import {
    FileEdit,
    LanguageFailureKind,
    RenameSymbolRequest,
    RenameSymbolResponse,
    TextEdit,
} from "@/shared/proto/dline/host/language"
import { Logger } from "@/shared/services/Logger"

/** Error text fragments that indicate the host itself lacks the LSP command. */
const LSP_UNAVAILABLE_PATTERNS = ["not found", "not supported", "command 'vscode.executeDocumentRenameProvider'"]

/** A failed pre-flight check, carrying both its category and an actionable message. */
interface PreCheckFailure {
    kind: LanguageFailureKind
    message: string
}

/**
 * Verify the request can reach the LSP at all.
 *
 * Only conditions that make the LSP call meaningless are checked here. Whether a
 * language server actually handles the file is left to the provider call itself,
 * since the installed-extension list cannot reliably predict provider registration.
 *
 * @returns the failure, or undefined when the request may proceed.
 */
async function runLspPreChecks(uri: vscode.Uri): Promise<PreCheckFailure | undefined> {
    try {
        await fs.promises.access(uri.fsPath, fs.constants.R_OK)
    } catch {
        return {
            kind: LanguageFailureKind.LANGUAGE_FAILURE_KIND_INVALID_PATH,
            message: `File not found or not readable: ${uri.fsPath}`,
        }
    }

    if (!vscode.workspace.getWorkspaceFolder(uri)) {
        return {
            kind: LanguageFailureKind.LANGUAGE_FAILURE_KIND_OUTSIDE_WORKSPACE,
            message: `File is not inside any workspace folder. LSP cannot rename symbols outside the workspace: ${uri.fsPath}`,
        }
    }

    return undefined
}

/**
 * Rename the symbol at the given position using VSCode's LSP.
 * When dry_run is true, returns a preview without applying changes.
 */
export async function renameSymbol(request: RenameSymbolRequest): Promise<RenameSymbolResponse> {
    try {
        const uri = vscode.Uri.file(request.filePath)

        const preCheckFailure = await runLspPreChecks(uri)
        if (preCheckFailure) {
            // The host has LSP; this specific request cannot use it.
            return {
                success: false,
                filesChanged: 0,
                totalChanges: 0,
                hasLspSupport: true,
                errorMessage: preCheckFailure.message,
                preview: [],
                failureKind: preCheckFailure.kind,
            }
        }

        const position = new vscode.Position(request.line - 1, request.character - 1)

        // VS Code runs this command through a model-and-position wrapper whose branch for a
        // document without a loaded model forwards the new name as an array, which the rename
        // command rejects with "Unexpected type". Loading the document keeps the call on the
        // branch that forwards it as a string; no editor is shown.
        await vscode.workspace.openTextDocument(uri)
        const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
            "vscode.executeDocumentRenameProvider",
            uri,
            position,
            request.newName,
        )

        if (!edit || edit.size === 0) {
            return {
                success: false,
                filesChanged: 0,
                totalChanges: 0,
                hasLspSupport: true,
                errorMessage:
                    "LSP returned no edits for this rename. The symbol may not be renamable, or the language server may not support rename for this file type.",
                preview: [],
                failureKind: LanguageFailureKind.LANGUAGE_FAILURE_KIND_NO_LANGUAGE_SUPPORT,
            }
        }

        const fileEdits = workspaceEditToFileEdits(edit)
        const totalChanges = fileEdits.reduce((sum, fe) => sum + fe.edits.length, 0)
        // Fill oldLine/newLine from disk for every edit (LSP does not provide line content)
        fillLineText(fileEdits, request.newName)

        if (request.dryRun) {
            return {
                success: true,
                filesChanged: fileEdits.length,
                totalChanges,
                hasLspSupport: true,
                errorMessage: "",
                preview: fileEdits,
                failureKind: LanguageFailureKind.LANGUAGE_FAILURE_KIND_NONE,
            }
        }

        // Apply the workspace edit
        const applied = await vscode.workspace.applyEdit(edit)
        if (!applied) {
            return {
                success: false,
                filesChanged: 0,
                totalChanges: 0,
                hasLspSupport: true,
                errorMessage: "VSCode failed to apply the rename edit.",
                preview: [],
                failureKind: LanguageFailureKind.LANGUAGE_FAILURE_KIND_PROVIDER_ERROR,
            }
        }

        // Save all modified documents to disk
        for (const [uri] of edit.entries()) {
            const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
            if (doc) await doc.save()
        }

        return {
            success: true,
            filesChanged: fileEdits.length,
            totalChanges,
            hasLspSupport: true,
            errorMessage: "",
            preview: fileEdits,
            failureKind: LanguageFailureKind.LANGUAGE_FAILURE_KIND_NONE,
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const hasLspSupport = !LSP_UNAVAILABLE_PATTERNS.some((p) => message.toLowerCase().includes(p.toLowerCase()))
        Logger.warn(`renameSymbol failed: ${message}`)
        return {
            success: false,
            filesChanged: 0,
            totalChanges: 0,
            hasLspSupport,
            errorMessage: message,
            preview: [],
            failureKind: hasLspSupport
                ? LanguageFailureKind.LANGUAGE_FAILURE_KIND_PROVIDER_ERROR
                : LanguageFailureKind.LANGUAGE_FAILURE_KIND_NO_LSP_HOST,
        }
    }
}

/**
 * Convert a VSCode WorkspaceEdit into FileEdit[] for the proto response.
 * originalText is left empty — fillOriginalText() populates it afterward.
 */
function workspaceEditToFileEdits(edit: vscode.WorkspaceEdit): FileEdit[] {
    const fileEdits: FileEdit[] = []

    for (const [uri, edits] of edit.entries()) {
        const textEdits: TextEdit[] = []
        for (const e of edits) {
            textEdits.push({
                startLine: e.range.start.line + 1,
                startCharacter: e.range.start.character + 1,
                endLine: e.range.end.line + 1,
                endCharacter: e.range.end.character + 1,
                newText: e.newText,
                originalText: "",
                oldLine: "",
                newLine: "",
            })
        }

        fileEdits.push({
            filePath: uri.fsPath,
            edits: textEdits,
        })
    }

    return fileEdits
}

/**
 * Fill oldLine and newLine for every TextEdit by reading source lines from disk
 * and constructing the renamed line.
 */
function fillLineText(fileEdits: FileEdit[], newName: string): void {
    for (const file of fileEdits) {
        let lines: string[] | null = null
        for (const edit of file.edits) {
            if (!lines) {
                try {
                    lines = fs.readFileSync(file.filePath, "utf-8").split("\n")
                } catch {
                    break
                }
            }
            const lineIdx = edit.startLine - 1
            if (lineIdx >= 0 && lineIdx < lines.length) {
                const origLine = lines[lineIdx]
                edit.oldLine = origLine
                edit.originalText = origLine.substring(edit.startCharacter - 1, edit.endCharacter - 1)
                edit.newLine = buildRenamedLine(origLine, edit.startCharacter, edit.endCharacter, newName)
            }
        }
    }
}

/**
 * Replace the character range [startChar, endChar] (1-based) with newName.
 */
function buildRenamedLine(origLine: string, startChar: number, endChar: number, newName: string): string {
    const s = startChar - 1
    const e = endChar - 1
    return origLine.substring(0, s) + newName + origLine.substring(e)
}
