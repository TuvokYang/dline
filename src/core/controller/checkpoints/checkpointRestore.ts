import { CheckpointRestoreRequest } from "@shared/proto/dline/checkpoints"
import { Empty } from "@shared/proto/dline/common"
import pWaitFor from "p-wait-for"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/dline/host"
import { Logger } from "@/shared/services/Logger"
import { ClineCheckpointRestore } from "../../../shared/WebviewMessage"
import { Controller } from ".."

export async function checkpointRestore(controller: Controller, request: CheckpointRestoreRequest): Promise<Empty> {
	if (request.number) {
		// wait for messages to be loaded
		await pWaitFor(() => controller.task !== undefined, {
			timeout: 3_000,
		}).catch((error) => {
			Logger.log("Failed to init new Dline instance to restore checkpoint", error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Failed to restore checkpoint",
			})
			throw error
		})

		// The checkpoint owner owns validation, stop/fence and reopen as one transaction.
		// Pre-cancelling here used the ordinary cancel path, which rearmed executors and
		// offered a cancelled-resume dialog before the restore had even been validated.
		await controller.task?.owners.checkpoints?.restoreCheckpoint(
			request.number,
			request.restoreType as ClineCheckpointRestore,
			request.offset,
			request.editedText || undefined,
		)
	}
	return Empty.create({})
}
