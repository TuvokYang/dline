import type { ShellEnvironmentProfile, ShellEnvironmentProfileRequest } from "@/shared/proto/dline/file"
import type { Controller } from ".."
import { getShellEnvironmentProfile as readProfile } from "./shellEnvironmentConfig"

export async function getShellEnvironmentProfile(
    _controller: Controller,
    request: ShellEnvironmentProfileRequest,
): Promise<ShellEnvironmentProfile> {
    return readProfile(request)
}
