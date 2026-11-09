import * as vscode from "vscode"
import { OpenFileRequest, OpenFileResponse } from "@/shared/proto/dline/host/window"

export async function openFile(request: OpenFileRequest): Promise<OpenFileResponse> {
    // The generic open command chooses the editor VS Code registered for the
    // file, which for images and other media is a webview/custom editor. Its
    // input applies navigation options when the editor is set; omitting the
    // options makes the workbench call `applyOptions(undefined)` and log
    // "Cannot read properties of undefined (reading 'selection')". Always pass
    // an explicit options object so that open path stays defined.
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(request.filePath), {
        preview: false,
        preserveFocus: false,
    })
    return OpenFileResponse.create({})
}
