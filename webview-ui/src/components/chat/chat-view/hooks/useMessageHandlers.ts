import type { UiMessage } from "@shared/ExtensionMessage"
import { EmptyRequest } from "@shared/proto/dline/common"
import { NewTaskRequest } from "@shared/proto/dline/task"
import { toProtoSemanticInputDocument } from "@shared/proto-conversions/input-semantics/document"
import { useCallback, useRef } from "react"
import { TaskServiceClient } from "@/services/grpc-client"
import { isBlankDraft, trimSegments } from "../../input/semantic-composer/model"
import { composeComposerSubmission } from "../../input/semantic-composer/projection"

import type { ChatState, MessageHandlers, NewTaskComposition } from "../types/chatTypes"

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
    messages: UiMessage[],
    chatState: ChatState,
    disableAutoScrollRef?: React.MutableRefObject<boolean>,
    taskId?: string,
): MessageHandlers {
    const { activeQuote, composer, setActiveQuote, setEnableButtons, setSendingDisabled } = chatState
    const taskOwnershipRef = useRef({ taskId, revision: 0 })
    const latestMessagesRef = useRef(messages)
    if (taskOwnershipRef.current.taskId !== taskId) {
        taskOwnershipRef.current = {
            taskId,
            revision: taskOwnershipRef.current.revision + 1,
        }
    }
    latestMessagesRef.current = messages

    const { retire: retireComposer, load: loadComposer, documentId } = composer
    const handleSendMessage = useCallback(
        async ({ segments, catalog }: NewTaskComposition) => {
            if (isBlankDraft(segments) || taskId !== undefined) {
                return
            }
            // The quote is text the composer adds, never something the user typed,
            // so it is a literal whether or not the user's own text needs a
            // document (WS-041 AC-09).
            const quotePrefix = activeQuote ? `[context] \n> ${activeQuote}\n[/context] \n\n` : ""
            const submission = composeComposerSubmission(trimSegments(segments), {
                catalog,
                documentId,
                literalPrefix: quotePrefix,
            })
            const document = submission.semanticInput
            const submissionOwnerRevision = taskOwnershipRef.current.revision
            await runNewTaskSubmission(
                () =>
                    TaskServiceClient.newTask(
                        NewTaskRequest.create({
                            text: submission.text,
                            images: [],
                            files: [],
                            ...(document ? { semanticInput: toProtoSemanticInputDocument(document) } : {}),
                        }),
                    ),
                () => {
                    retireComposer()
                    setActiveQuote(null)
                    setSendingDisabled(true)
                    setEnableButtons(false)
                },
                () => {
                    // The frozen segments come back whole: the same atoms, resources and held text.
                    loadComposer(segments)
                    setActiveQuote(activeQuote)
                    setSendingDisabled(false)
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
            retireComposer,
            disableAutoScrollRef,
            documentId,
            loadComposer,
            setActiveQuote,
            setEnableButtons,
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
