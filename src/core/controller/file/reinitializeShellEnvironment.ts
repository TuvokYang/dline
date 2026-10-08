import { EmptyRequest } from "@/shared/proto/dline/common"
import { ShellEnvironmentReinitializeResponse } from "@/shared/proto/dline/file"
import type { Controller } from ".."

export async function reinitializeShellEnvironment(
	controller: Controller,
	_request: EmptyRequest,
): Promise<ShellEnvironmentReinitializeResponse> {
	const result = controller.task?.owners.commands.reinitializeTerminals()
	return ShellEnvironmentReinitializeResponse.create({
		closedCount: result?.closedCount ?? 0,
		busyCount: result?.busyTerminals.length ?? 0,
	})
}
