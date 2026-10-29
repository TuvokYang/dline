import type { ShellEnvironmentProfilePreview, UpdateShellEnvironmentProfileRequest } from "@/shared/proto/dline/file"
import type { Controller } from ".."
import { previewShellEnvironmentProfile as previewProfile } from "./shellEnvironmentConfig"

export async function previewShellEnvironmentProfile(
    _controller: Controller,
    request: UpdateShellEnvironmentProfileRequest,
): Promise<ShellEnvironmentProfilePreview> {
    return previewProfile(request)
}
