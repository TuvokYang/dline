import * as vscode from "vscode"
import { ApplyTextDocumentEditRequest, ApplyTextDocumentEditResponse } from "@/shared/proto/dline/host"

/** Apply and save a full-document edit without opening an editor or changing focus. */
export async function applyTextDocumentEdit(request: ApplyTextDocumentEditRequest): Promise<ApplyTextDocumentEditResponse> {
	const uri = vscode.Uri.file(request.filePath)
	const document = await vscode.workspace.openTextDocument(uri)
	const currentContent = document.getText()

	if (currentContent !== request.expectedContent) {
		return ApplyTextDocumentEditResponse.create({ conflict: true, content: currentContent })
	}

	const edit = new vscode.WorkspaceEdit()
	edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(currentContent.length)), request.content)
	if (!(await vscode.workspace.applyEdit(edit))) {
		return ApplyTextDocumentEditResponse.create({ content: currentContent })
	}

	const saved = await document.save()
	return ApplyTextDocumentEditResponse.create({ saved, content: document.getText() })
}
