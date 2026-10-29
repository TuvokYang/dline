import * as vscode from "vscode"
import { ExtensionRegistryInfo } from "@/registry"
import { OpenClineSidebarPanelRequest, OpenClineSidebarPanelResponse } from "@/shared/proto/dline/host"

export async function openClineSidebarPanel(_: OpenClineSidebarPanelRequest): Promise<OpenClineSidebarPanelResponse> {
    await vscode.commands.executeCommand(`${ExtensionRegistryInfo.views.Sidebar}.focus`)
    return {}
}
