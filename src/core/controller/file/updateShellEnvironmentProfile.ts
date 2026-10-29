import type { ShellEnvironmentProfile, UpdateShellEnvironmentProfileRequest } from "@/shared/proto/dline/file"
import type { Controller } from ".."
import { updateShellEnvironmentProfile as writeProfile } from "./shellEnvironmentConfig"

export async function updateShellEnvironmentProfile(
    _controller: Controller,
    request: UpdateShellEnvironmentProfileRequest,
): Promise<ShellEnvironmentProfile> {
    return writeProfile(request)
}
