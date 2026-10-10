import { openFile as openFileIntegration } from "@integrations/misc/open-file"
import { Empty } from "@/shared/proto/dline/common"
import type { ShellEnvironmentWorkspaceRequest } from "@/shared/proto/dline/file"
import type { Controller } from ".."
import { ensureShellEnvironmentConfig } from "./shellEnvironmentConfig"

export async function openShellEnvironmentConfig(
    _controller: Controller,
    request: ShellEnvironmentWorkspaceRequest,
): Promise<Empty> {
    await openFileIntegration(await ensureShellEnvironmentConfig(request.workspacePath))
    return Empty.create()
}
