import type { ModelPricing } from "@shared/api"
import { ClineMessage } from "@shared/ExtensionMessage"
import React from "react"
import TaskHeader from "@/components/chat/task-header/TaskHeader"
import { MessageHandlers } from "../../types/chatTypes"

interface TaskSectionProps {
	task: ClineMessage
	apiMetrics: {
		totalTokensIn: number
		totalTokensOut: number
		totalCacheWrites?: number
		totalCacheReads?: number
		totalCost: number
		cacheHitRate?: number
		currency?: string
		requestsPerMinute?: number
		tokensPerMinute?: number
	}
	lastApiReqTotalTokens?: number
	selectedModelInfo: {
		contextWindow?: number
		supportsPromptCache: boolean
		supportsImages: boolean
		pricing?: ModelPricing
	}
	messageHandlers: MessageHandlers
	taskId?: string
	compactTaskDisabled?: boolean
	forceTruncateAvailable?: boolean
	forceTruncateTaskDisabled?: boolean
	onCompactTask?: () => Promise<boolean>
	onDeleteConfirmed?: () => void
	onForceTruncateTask?: () => Promise<boolean>
	lastProgressMessageText?: string
	showFocusChainPlaceholder?: boolean
}

/**
 * Task section shown when there's an active task
 * Includes the task header and manages task-specific UI
 */
export const TaskSection: React.FC<TaskSectionProps> = ({
	task,
	apiMetrics,
	taskId,
	lastApiReqTotalTokens,
	selectedModelInfo,
	messageHandlers,
	compactTaskDisabled,
	forceTruncateAvailable,
	forceTruncateTaskDisabled,
	onCompactTask,
	onDeleteConfirmed,
	onForceTruncateTask,
	lastProgressMessageText,
	showFocusChainPlaceholder,
}) => {
	return (
		<TaskHeader
			cacheHitRate={apiMetrics.cacheHitRate}
			cacheReads={apiMetrics.totalCacheReads}
			cacheWrites={apiMetrics.totalCacheWrites}
			compactTaskDisabled={compactTaskDisabled}
			contextWindow={selectedModelInfo.contextWindow}
			currency={apiMetrics.currency}
			doesModelSupportPromptCache={selectedModelInfo.supportsPromptCache}
			forceTruncateAvailable={forceTruncateAvailable}
			forceTruncateTaskDisabled={forceTruncateTaskDisabled}
			lastApiReqTotalTokens={lastApiReqTotalTokens}
			lastProgressMessageText={lastProgressMessageText}
			onClose={messageHandlers.handleTaskCloseButtonClick}
			onCompactTask={onCompactTask}
			onDeleteConfirmed={onDeleteConfirmed}
			onForceTruncateTask={onForceTruncateTask}
			pricing={selectedModelInfo.pricing}
			requestsPerMinute={apiMetrics.requestsPerMinute}
			showFocusChainPlaceholder={showFocusChainPlaceholder}
			task={task}
			taskId={taskId}
			tokensIn={apiMetrics.totalTokensIn}
			tokensOut={apiMetrics.totalTokensOut}
			tokensPerMinute={apiMetrics.tokensPerMinute}
			totalCost={apiMetrics.totalCost}
		/>
	)
}
