import { Empty, StringRequest } from "@shared/proto/dline/common"
import * as vscode from "vscode"
import { ExtensionRegistryInfo } from "@/registry"

const DLINE_OUTPUT_CHANNEL = vscode.window.createOutputChannel(ExtensionRegistryInfo.displayName)

// Appends a log message to the current Dline distribution's output channel.
export async function debugLog(request: StringRequest): Promise<Empty> {
    DLINE_OUTPUT_CHANNEL.appendLine(request.value)
    return Empty.create({})
}

// Register the Dline output channel within the VSCode extension context.
export function registerClineOutputChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
    context.subscriptions.push(DLINE_OUTPUT_CHANNEL)
    return DLINE_OUTPUT_CHANNEL
}
