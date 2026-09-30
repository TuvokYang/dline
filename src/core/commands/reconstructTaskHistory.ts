import { getDlineDocumentsPath, getSavedClineMessages, getTaskMetadata } from "@core/storage/disk"
import { StateManager } from "@core/storage/StateManager"
import { TaskMetricsOwner } from "@core/task/performance/TaskMetricsOwner"
import { HostProvider } from "@hosts/host-provider"
import { ClineMessage } from "@shared/ExtensionMessage"
import type { ApiMetrics } from "@shared/getApiMetrics"
import { HistoryItem } from "@shared/HistoryItem"
import { ShowMessageType } from "@shared/proto/dline/host/window"
import { fileExistsAtPath } from "@utils/fs"
import * as path from "path"
import { ulid } from "ulid"

interface TaskReconstructionResult {
	totalTasks: number
	reconstructedTasks: number
	skippedTasks: number
	errors: string[]
}

/**
 * Reconstructs task history from existing task folders
 * @returns Reconstruction result or null if cancelled
 */
export async function reconstructTaskHistory(): Promise<TaskReconstructionResult | null> {
	try {
		// Show confirmation dialog using HostProvider
		const proceed = await HostProvider.window.showMessage({
			type: ShowMessageType.WARNING,
			message:
				"This will rebuild your task history index from the task folders on disk. The current index will be replaced. Continue?",
			options: {
				items: ["Yes, Reconstruct", "Cancel"],
			},
		})

		if (proceed?.selectedOption !== "Yes, Reconstruct") {
			return null
		}

		HostProvider.window.showMessage({
			type: ShowMessageType.INFORMATION,
			message: "Reconstructing task history...",
		})

		const result = await performTaskHistoryReconstruction()

		// Show results
		if (result.errors.length > 0) {
			const errorMessage = `Reconstruction completed with warnings:\n- Reconstructed: ${result.reconstructedTasks} tasks\n- Skipped: ${result.skippedTasks} tasks\n- Errors: ${result.errors.length}\n\nFirst few errors:\n${result.errors.slice(0, 3).join("\n")}`

			HostProvider.window.showMessage({
				type: ShowMessageType.WARNING,
				message: errorMessage,
			})
		} else {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `Task history successfully reconstructed! Found and restored ${result.reconstructedTasks} tasks.`,
			})
		}

		return result
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: `Failed to reconstruct task history: ${errorMessage}`,
		})
		return null
	}
}

async function performTaskHistoryReconstruction(): Promise<TaskReconstructionResult> {
	const result: TaskReconstructionResult = {
		totalTasks: 0,
		reconstructedTasks: 0,
		skippedTasks: 0,
		errors: [],
	}

	// Get tasks directory
	const tasksDir = path.join(await getDlineDocumentsPath(), "tasks")

	// Check if tasks directory exists
	if (!(await fileExistsAtPath(tasksDir))) {
		throw new Error("No tasks directory found. Nothing to reconstruct.")
	}

	// Scan for task directories
	const taskIds = await scanTaskDirectories(tasksDir)
	result.totalTasks = taskIds.length

	if (taskIds.length === 0) {
		throw new Error("No task directories found. Nothing to reconstruct.")
	}

	// Process each task
	const reconstructedItems: HistoryItem[] = []

	for (const taskId of taskIds) {
		try {
			const historyItem = await reconstructTaskHistoryItem(taskId)
			if (historyItem) {
				reconstructedItems.push(historyItem)
				result.reconstructedTasks++
			} else {
				result.skippedTasks++
			}
		} catch (error) {
			result.skippedTasks++
			const errorMsg = error instanceof Error ? error.message : String(error)
			result.errors.push(`Task ${taskId}: ${errorMsg}`)
		}
	}

	// Sort by timestamp (newest first)
	reconstructedItems.sort((a, b) => b.ts - a.ts)

	// The rebuilt set is authoritative: replace the stored index, then refresh the
	// in-memory cache so open views do not keep serving the discarded entries.
	const stateManager = StateManager.get()
	const persisted = await stateManager.taskHistory.replaceAllItems(reconstructedItems)
	stateManager.setGlobalStateBatch({ taskHistory: persisted })

	return result
}

async function scanTaskDirectories(tasksDir: string): Promise<string[]> {
	const fs = await import("fs/promises")

	try {
		const entries = await fs.readdir(tasksDir, { withFileTypes: true })
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => /^\d+$/.test(name)) // Only numeric task IDs
	} catch (error) {
		throw new Error(`Failed to scan tasks directory: ${error}`)
	}
}

async function reconstructTaskHistoryItem(taskId: string): Promise<HistoryItem | null> {
	try {
		// Load UI messages to extract task info
		const clineMessages = await getSavedClineMessages(taskId)
		if (clineMessages.length === 0) {
			return null // Skip empty tasks
		}

		// Load task metadata for token usage
		const metadata = await getTaskMetadata(taskId)

		// Extract task information
		const usage = await TaskMetricsOwner.readUsage(taskId, clineMessages)
		const taskInfo = extractTaskInformation(clineMessages, metadata, usage)

		// Create HistoryItem
		const historyItem: HistoryItem = {
			id: taskId,
			ulid: taskInfo.ulid || ulid(), // Generate new ULID if missing
			ts: taskInfo.timestamp,
			task: taskInfo.taskDescription,
			tokensIn: taskInfo.tokensIn,
			tokensOut: taskInfo.tokensOut,
			cacheWrites: taskInfo.cacheWrites,
			cacheReads: taskInfo.cacheReads,
			totalCost: taskInfo.totalCost,
			size: taskInfo.size,
			isFavorited: taskInfo.isFavorited,
			conversationHistoryDeletedRange: taskInfo.conversationHistoryDeletedRange,
		}

		return historyItem
	} catch (error) {
		throw new Error(`Failed to reconstruct task ${taskId}: ${error}`)
	}
}

interface TaskInfo {
	ulid?: string
	timestamp: number
	taskDescription: string
	tokensIn: number
	tokensOut: number
	cacheWrites?: number
	cacheReads?: number
	totalCost: number
	size?: number
	isFavorited?: boolean
	conversationHistoryDeletedRange?: [number, number]
}

function extractTaskInformation(clineMessages: ClineMessage[], metadata: any, usage: Readonly<ApiMetrics> | undefined): TaskInfo {
	// Find the first user message (task description)
	const firstUserMessage = clineMessages.find((msg) => msg.type === "say" && msg.say === "text" && msg.text)

	// Extract timestamp from first message or use task ID as fallback
	const timestamp = clineMessages.length > 0 ? clineMessages[0].ts : Date.now()

	// Extract task description
	let taskDescription = "Untitled Task"
	if (firstUserMessage?.text) {
		// Clean up the task description
		const cleanText = firstUserMessage.text
			.replace(/<task>\s*/g, "")
			.replace(/\s*<\/task>/g, "")
			.trim()

		const firstLine = cleanText.split("\n")[0]
		if (firstLine) {
			taskDescription = firstLine.substring(0, 100) // Limit length
		}
	}

	// Usage belongs to the metrics module, not the history-index reconstruction.
	let tokensIn = usage?.totalTokensIn ?? 0
	let tokensOut = usage?.totalTokensOut ?? 0
	let cacheWrites = usage?.totalCacheWrites ?? 0
	let cacheReads = usage?.totalCacheReads ?? 0
	let totalCost = usage?.totalCost ?? 0

	// Preserve metadata-only compatibility when the metrics owner has no usage source.
	if (!usage && metadata.model_usage) {
		for (const usage of metadata.model_usage) {
			tokensIn += usage.tokensIn || 0
			tokensOut += usage.tokensOut || 0
			cacheWrites += usage.cacheWrites || 0
			cacheReads += usage.cacheReads || 0
			totalCost += usage.totalCost || 0
		}
	}

	// Calculate approximate size (rough estimate)
	const messageSize = JSON.stringify(clineMessages).length
	const size = Math.floor(messageSize / 1024) // KB

	return {
		timestamp,
		taskDescription,
		tokensIn,
		tokensOut,
		cacheWrites: cacheWrites > 0 ? cacheWrites : undefined,
		cacheReads: cacheReads > 0 ? cacheReads : undefined,
		totalCost,
		size,
	}
}
