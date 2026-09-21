import type { ClineMessage } from "@shared/ExtensionMessage"
import { EmptyRequest } from "@shared/proto/dline/common"
import { NewTaskRequest } from "@shared/proto/dline/task"
import { useCallback, useRef } from "react"
import { TaskServiceClient } from "@/services/grpc-client"

import type { ChatState, MessageHandlers } from "../types/chatTypes"

export async function runNewTaskSubmission(
	startTask: () => Promise<unknown>,
	clearDraft: () => void,
	restoreDraft: () => void,
	shouldRestoreDraft: () => boolean = () => true,
): Promise<void> {
	clearDraft()
	try {
		await startTask()
	} catch (error) {
		if (shouldRestoreDraft()) {
			restoreDraft()
		}
		throw error
	}
}

/**
 * Custom hook for managing message handlers
 * Handles sending messages, button clicks, and task management
 */
export function useMessageHandlers(
	messages: ClineMessage[],
	chatState: ChatState,
	disableAutoScrollRef?: React.MutableRefObject<boolean>,
	taskId?: string,
): MessageHandlers {
	const {
		activeQuote,
		setActiveQuote,
		setEnableButtons,
		setInputValue,
		setSelectedFiles,
		setSelectedImages,
		setSendingDisabled,
	} = chatState
	const taskOwnershipRef = useRef({ taskId, revision: 0 })
	const latestMessagesRef = useRef(messages)
	if (taskOwnershipRef.current.taskId !== taskId) {
		taskOwnershipRef.current = {
			taskId,
			revision: taskOwnershipRef.current.revision + 1,
		}
	}
	latestMessagesRef.current = messages

	const handleSendMessage = useCallback(
		async (text: string, images: string[], files: string[]) => {
			let messageToSend = text.trim()
			const hasContent = messageToSend.length > 0 || images.length > 0 || files.length > 0
			if (!hasContent || taskId !== undefined) {
				return
			}
			if (activeQuote) {
				messageToSend = `[context] \n> ${activeQuote}\n[/context] \n\n${messageToSend}`
			}
			const submissionOwnerRevision = taskOwnershipRef.current.revision
			await runNewTaskSubmission(
				() =>
					TaskServiceClient.newTask(
						NewTaskRequest.create({
							text: messageToSend,
							images,
							files,
						}),
					),
				() => {
					setInputValue("")
					setActiveQuote(null)
					setSendingDisabled(true)
					setSelectedImages([])
					setSelectedFiles([])
					setEnableButtons(false)
				},
				() => {
					setInputValue(text)
					setActiveQuote(activeQuote)
					setSendingDisabled(false)
					setSelectedImages(images)
					setSelectedFiles(files)
					setEnableButtons(true)
				},
				() => taskOwnershipRef.current.revision === submissionOwnerRevision && latestMessagesRef.current.length === 0,
			)
			if (disableAutoScrollRef) {
				disableAutoScrollRef.current = false
			}
		},
		[
			activeQuote,
			disableAutoScrollRef,
			setActiveQuote,
			setEnableButtons,
			setInputValue,
			setSelectedFiles,
			setSelectedImages,
			setSendingDisabled,
			taskId,
		],
	)

	const startNewTask = useCallback(async () => {
		await TaskServiceClient.clearTask(EmptyRequest.create({}))
		setActiveQuote(null)
	}, [setActiveQuote])

	const handleTaskCloseButtonClick = useCallback(() => startNewTask(), [startNewTask])

	return {
		handleSendMessage,
		handleTaskCloseButtonClick,
		startNewTask,
	}
}
