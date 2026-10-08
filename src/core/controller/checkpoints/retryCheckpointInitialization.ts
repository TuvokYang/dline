import { Boolean, EmptyRequest } from "@shared/proto/dline/common"
import type { Controller } from "../index"

export async function retryCheckpointInitialization(controller: Controller, _request: EmptyRequest): Promise<Boolean> {
	const checkpointManager = controller.task?.owners.checkpoints
	if (!checkpointManager || !("retryCheckpointInitialization" in checkpointManager)) {
		return Boolean.create({ value: false })
	}

	const retry = checkpointManager.retryCheckpointInitialization
	if (typeof retry !== "function") {
		return Boolean.create({ value: false })
	}

	return Boolean.create({ value: await retry.call(checkpointManager) })
}
