import * as vscode from "vscode"
import { ApplyTextDocumentEditRequest, ApplyTextDocumentEditResponse } from "@/shared/proto/dline/host"

/**
 * Apply and save a full-document edit without opening an editor or changing focus.
 *
 * The saved document always uses LF line endings, the same contract the visual diff
 * editor applies before saving.
 */
export async function applyTextDocumentEdit(request: ApplyTextDocumentEditRequest): Promise<ApplyTextDocumentEditResponse> {
    const uri = vscode.Uri.file(request.filePath)
    const document = await vscode.workspace.openTextDocument(uri)
    const currentContent = document.getText()

    if (currentContent !== request.expectedContent) {
        return ApplyTextDocumentEditResponse.create({ conflict: true, content: currentContent })
    }

    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(currentContent.length))
    const edit = new vscode.WorkspaceEdit()
    // VS Code rewrites inserted line breaks to the document's end-of-line, which an empty
    // new file takes from `files.eol` (CRLF by default on Windows); the explicit LF edit
    // keeps background writes from depending on that host setting.
    edit.set(uri, [vscode.TextEdit.replace(fullRange, request.content), vscode.TextEdit.setEndOfLine(vscode.EndOfLine.LF)])
    if (!(await vscode.workspace.applyEdit(edit))) {
        return ApplyTextDocumentEditResponse.create({ content: currentContent })
    }

    const saved = await document.save()
    return ApplyTextDocumentEditResponse.create({ saved, content: document.getText() })
}
