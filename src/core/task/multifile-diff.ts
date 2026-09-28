import { readCheckpointReferenceSet } from "@shared/checkpoints"
import { HostProvider } from "@/hosts/host-provider"
import CheckpointTracker from "@/integrations/checkpoints/CheckpointTracker"
import { resolveCompletionDiffBaseHash } from "@/integrations/checkpoints/completion-diff"
import { ShowMessageType } from "@/shared/proto/dline/host"
import { Logger } from "@/shared/services/Logger"
import { MessageStateHandler } from "./message-state"

export async function showChangedFilesDiff(
	messageStateHandler: MessageStateHandler,
	checkpointTracker: CheckpointTracker,
	messageTs: number,
	seeNewChangesSinceLastTaskCompletion: boolean,
) {
	Logger.log("presentMultifileDiff", messageTs)
	const clineMessages = messageStateHandler.clineMessages
	const messageIndex = clineMessages.findIndex((m) => m.ts === messageTs)
	const message = clineMessages[messageIndex]
	if (!message) {
		Logger.error("Message not found")
		return
	}
	const lastCheckpointHash = readCheckpointReferenceSet(message)?.hashes.find(Boolean)
	if (!lastCheckpointHash) {
		Logger.error("No checkpoint hash found")
		return
	}

	const changedFiles = await getChangedFiles(
		messageStateHandler,
		checkpointTracker,
		seeNewChangesSinceLastTaskCompletion,
		messageIndex,
		lastCheckpointHash,
	)
	if (!changedFiles.length) {
		return
	}
	const title = seeNewChangesSinceLastTaskCompletion ? "New changes" : "Changes since snapshot"
	const diffs = changedFiles.map((file) => ({
		filePath: file.absolutePath,
		leftContent: file.before,
		rightContent: file.after,
	}))
	HostProvider.diff.openMultiFileDiff({ title, diffs })
}

type ChangedFile = {
	relativePath: string
	absolutePath: string
	before: string
	after: string
}

async function getChangedFiles(
	messageStateHandler: MessageStateHandler,
	checkpointTracker: CheckpointTracker,
	changesSinceLastTaskCompletion: boolean,
	messageIndex: number,
	lastCheckpointHash: string,
): Promise<ChangedFile[]> {
	try {
		let changedFiles
		if (changesSinceLastTaskCompletion) {
			changedFiles = await getChangesSinceLastTaskCompletion(
				messageStateHandler,
				checkpointTracker,
				messageIndex,
				lastCheckpointHash,
			)
		} else {
			// Compare this checkpoint against the previous checkpoint hash
			// so the diff shows only the files this checkpoint introduced.
			// Uses `git diff --name-only hash1..hash2` (read-only, no git add .)
			const prevHash = findPreviousCheckpointHash(messageStateHandler, messageIndex)
			if (prevHash) {
				changedFiles = await checkpointTracker.getDiffSet(prevHash, lastCheckpointHash)
			} else {
				// Fallback: no previous checkpoint — compare to working directory
				changedFiles = await checkpointTracker.getDiffSet(lastCheckpointHash)
			}
		}
		if (!changedFiles.length) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "No changes found",
			})
		}
		return changedFiles
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error"
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: `Failed to retrieve diff set: ${errorMessage}`,
		})
		return []
	}
}

/**
 * Find the `lastCheckpointHash` of the most recent `checkpoint_created`
 * message that appears before `messageIndex` and has a non-empty hash.
 */
function findPreviousCheckpointHash(messageStateHandler: MessageStateHandler, messageIndex: number): string | undefined {
	const clineMessages = messageStateHandler.clineMessages
	// Walk backwards from messageIndex - 1 to find the previous checkpoint_created with a hash
	for (let i = messageIndex - 1; i >= 0; i--) {
		const msg = clineMessages[i]
		if (msg?.say === "checkpoint_created") {
			const hash = readCheckpointReferenceSet(msg)?.hashes.find(Boolean)
			if (hash) return hash
		}
	}
	return undefined
}

async function getChangesSinceLastTaskCompletion(
	messageStateHandler: MessageStateHandler,
	checkpointTracker: CheckpointTracker,
	messageIndex: number,
	lastCheckpointHash: string,
): Promise<ChangedFile[]> {
	const previousCheckpointHash = resolveCompletionDiffBaseHash(messageStateHandler.clineMessages, messageIndex)

	if (!previousCheckpointHash) {
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: "Unexpected error: No checkpoint hash found",
		})
		return []
	}

	return await checkpointTracker.getTaskDiffSet(previousCheckpointHash, lastCheckpointHash)
}
