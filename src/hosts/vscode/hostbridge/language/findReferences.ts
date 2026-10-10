import * as fs from "node:fs"
import * as vscode from "vscode"
import {
    FindReferencesRequest,
    FindReferencesResponse,
    LanguageFailureKind,
    ReferenceLocation,
} from "@/shared/proto/dline/host/language"
import { Logger } from "@/shared/services/Logger"

/** Error text fragments that indicate the host itself lacks the LSP command. */
const LSP_UNAVAILABLE_PATTERNS = ["not found", "not supported", "command 'vscode.executeReferenceProvider'"]

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
            message: `File is not inside any workspace folder. LSP cannot index files outside the workspace: ${uri.fsPath}`,
        }
    }

    return undefined
}

/**
 * Find all references to the symbol at the given position using VSCode's LSP.
 * Returns ReferenceLocation[] with context lines for each reference found.
 */
export async function findReferences(request: FindReferencesRequest): Promise<FindReferencesResponse> {
    try {
        const uri = vscode.Uri.file(request.filePath)

        const preCheckFailure = await runLspPreChecks(uri)
        if (preCheckFailure) {
            // The host has LSP; this specific request cannot use it.
            return {
                hasLspSupport: true,
                references: [],
                errorMessage: preCheckFailure.message,
                failureKind: preCheckFailure.kind,
            }
        }

        const position = new vscode.Position(request.line - 1, request.character - 1)

        const locations = await vscode.commands.executeCommand<vscode.Location[]>(
            "vscode.executeReferenceProvider",
            uri,
            position,
        )

        if (!locations || locations.length === 0) {
            return {
                hasLspSupport: true,
                references: [],
                errorMessage:
                    "LSP returned no references. The symbol may have no references, or the language server may not support reference lookups for this file type.",
                failureKind: LanguageFailureKind.LANGUAGE_FAILURE_KIND_NONE,
            }
        }

        const references: ReferenceLocation[] = await Promise.all(
            locations.map(async (loc) => {
                const contextLine = await readLineAt(loc.uri, loc.range.start.line)
                return {
                    filePath: loc.uri.fsPath,
                    startLine: loc.range.start.line + 1, // 1-based
                    startCharacter: loc.range.start.character + 1, // 1-based
                    endLine: loc.range.end.line + 1,
                    endCharacter: loc.range.end.character + 1,
                    contextLine,
                }
            }),
        )

        return {
            hasLspSupport: true,
            references,
            errorMessage: "",
            failureKind: LanguageFailureKind.LANGUAGE_FAILURE_KIND_NONE,
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const hasLspSupport = !LSP_UNAVAILABLE_PATTERNS.some((p) => message.toLowerCase().includes(p.toLowerCase()))
        Logger.warn(`findReferences failed: ${message}`)
        return {
            hasLspSupport,
            references: [],
            errorMessage: message,
            failureKind: hasLspSupport
                ? LanguageFailureKind.LANGUAGE_FAILURE_KIND_PROVIDER_ERROR
                : LanguageFailureKind.LANGUAGE_FAILURE_KIND_NO_LSP_HOST,
        }
    }
}

/**
 * Read a single line from a document at the given 0-based line index.
 */
async function readLineAt(uri: vscode.Uri, line: number): Promise<string> {
    try {
        const doc = await vscode.workspace.openTextDocument(uri)
        if (line >= 0 && line < doc.lineCount) {
            return doc.lineAt(line).text
        }
    } catch {
        // document may be binary or inaccessible
    }
    return ""
}
