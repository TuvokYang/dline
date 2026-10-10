import * as vscode from "vscode"
import { OpenProblemsPanelRequest, OpenProblemsPanelResponse } from "@/shared/proto/dline/host"

export async function openProblemsPanel(_: OpenProblemsPanelRequest): Promise<OpenProblemsPanelResponse> {
    vscode.commands.executeCommand("workbench.actions.view.problems")
    return {}
}
