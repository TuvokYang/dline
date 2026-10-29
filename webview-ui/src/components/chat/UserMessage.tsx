import type { SubmittedInputFacts } from "@shared/input-semantics/submitted-input"
import { CheckpointRestoreRequest } from "@shared/proto/dline/checkpoints"
import { ClineCheckpointRestore } from "@shared/WebviewMessage"
import React, { forwardRef, useMemo, useRef, useState } from "react"
import DynamicTextArea from "react-textarea-autosize"
import { openTaskResource } from "@/components/chat/input/semantic-composer/resource-staging"
import { type ResourceChipResolver, ResourceChipResolverContext, sentResourceNode } from "@/components/common/ResourceChip"
import Thumbnails from "@/components/common/Thumbnails"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { CheckpointsServiceClient } from "@/services/grpc-client"
import { markSubmittedEntities, type SubmittedResource, submittedResourcesByKey } from "@/services/input-semantics/highlight"
import { UserInputMarkdownBody } from "./UserInputMarkdownBody"

interface UserMessageProps {
    text?: string
    /** Facts recorded when the row was sent; the row marks the entities they say ran. */
    submittedInputs?: readonly SubmittedInputFacts[]
    files?: string[]
    images?: string[]
    messageTs?: number // Timestamp for the message, needed for checkpoint restore
    sendMessageFromChatRow?: (text: string, images: string[], files: string[]) => void
    inputKind?: "direct" | "queued"
    queuedInputMode?: "queued" | "steering"
}

/**
 * Resolve a sent row's resource links to the resources it recorded.
 *
 * Only a task-owned resource can open: the task keeps its bytes for as long
 * as the task exists, while a draft's bytes are gone once it was sent.
 */
function sentResourceChipResolverOf(resources: ReadonlyMap<string, SubmittedResource>): ResourceChipResolver | undefined {
    if (resources.size === 0) return undefined
    return (key) => {
        const sent = resources.get(key)
        if (!sent) return undefined
        const { resource } = sent
        return {
            node: sentResourceNode(key, sent.displayName, resource),
            resource,
            onOpen: resource.owner.kind === "task" ? () => void openTaskResource(resource) : undefined,
        }
    }
}

const UserMessage: React.FC<UserMessageProps> = ({
    text,
    submittedInputs,
    images,
    files,
    messageTs,
    sendMessageFromChatRow: _sendMessageFromChatRow,
    inputKind = "direct",
    queuedInputMode,
}) => {
    const [isEditing, setIsEditing] = useState(false)
    const [editedText, setEditedText] = useState(text || "")
    const textAreaRef = useRef<HTMLTextAreaElement>(null)
    const { checkpointManagerErrorMessage, taskViewState } = useExtensionState()

    const queued = inputKind === "queued"
    // History never lexes the text again: without valid facts the row is plain Markdown.
    const marked = useMemo(() => markSubmittedEntities(text, submittedInputs), [submittedInputs, text])
    const markdown = marked ?? text
    const resolver = useMemo(
        () => sentResourceChipResolverOf(submittedResourcesByKey(text, submittedInputs)),
        [submittedInputs, text],
    )

    // Create refs for the buttons to check in the blur handler
    const restoreAllButtonRef = useRef<HTMLButtonElement>(null)
    const restoreChatButtonRef = useRef<HTMLButtonElement>(null)

    const handleClick = (event: React.MouseEvent<HTMLElement>) => {
        if ((event.target as HTMLElement).closest("a, button, pre, code, [data-resource-chip]")) return
        if (!isEditing) {
            setIsEditing(true)
        }
    }

    // Select all text when entering edit mode
    React.useEffect(() => {
        if (isEditing && textAreaRef.current) {
            textAreaRef.current.select()
        }
    }, [isEditing])

    const handleRestoreWorkspace = async (type: ClineCheckpointRestore) => {
        setIsEditing(false)

        if (text === editedText) {
            return
        }

        try {
            // Pass editedText directly in the RPC so the backend can restart
            // the conversation without depending on a separate webview resend.
            await CheckpointsServiceClient.checkpointRestore(
                CheckpointRestoreRequest.create({
                    number: messageTs,
                    restoreType: type,
                    offset: 1,
                    editedText: type === "task" ? editedText : undefined,
                    checkpointRowTs: messageTs,
                    taskId: taskViewState?.taskId ?? "",
                    taskInstanceId: taskViewState?.taskInstanceId ?? "",
                }),
            )
        } catch (err) {
            console.error("Checkpoint restore error:", err)
        }
    }

    const handleBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => {
        // Check if focus is moving to one of our button elements
        if (e.relatedTarget === restoreAllButtonRef.current || e.relatedTarget === restoreChatButtonRef.current) {
            // Don't close edit mode if focus is moving to one of our buttons
            return
        }

        // Otherwise, close edit mode
        setIsEditing(false)
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Escape") {
            setIsEditing(false)
        } else if (e.key === "Enter" && e.metaKey && !checkpointManagerErrorMessage) {
            handleRestoreWorkspace("taskAndWorkspace")
        } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault()
            handleRestoreWorkspace("task")
        }
    }

    return (
        <article
            className={
                queued
                    ? "my-1 rounded-xs border border-(--vscode-editorWidget-border,var(--vscode-panel-border)) bg-(--vscode-editorWidget-background,var(--vscode-sideBar-background)) p-2.5 pr-1 text-(--vscode-foreground)"
                    : "p-2.5 pr-1 my-1 text-badge-foreground rounded-xs"
            }
            data-input-kind={inputKind}
            data-queue-state={queued ? "delivered" : undefined}
            data-queued-input-mode={queuedInputMode}
            data-testid={queued ? "queued-user-input" : "direct-user-input"}
            onClick={handleClick}
            style={{
                backgroundColor: isEditing
                    ? "unset"
                    : queued
                      ? "var(--vscode-editorWidget-background, var(--vscode-menu-background, var(--vscode-sideBar-background, rgb(30, 30, 30))))"
                      : "var(--vscode-badge-background)",
                whiteSpace: "pre-line",
                wordWrap: "break-word",
            }}>
            {queued && !isEditing ? (
                <header className="mb-1.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-description">
                    <span aria-hidden="true" className="codicon codicon-list-ordered" />
                    <span>Queued input</span>
                    {queuedInputMode === "steering" ? <span>· Steering</span> : null}
                </header>
            ) : null}
            {isEditing ? (
                <>
                    <DynamicTextArea
                        autoFocus
                        onBlur={(e) => handleBlur(e)}
                        onChange={(e) => setEditedText(e.target.value)}
                        onKeyDown={handleKeyDown}
                        ref={textAreaRef}
                        style={{
                            width: "100%",
                            backgroundColor: "var(--vscode-input-background)",
                            color: "var(--vscode-input-foreground)",
                            borderColor: "var(--vscode-input-border)",
                            border: "1px solid",
                            borderRadius: "2px",
                            padding: "6px",
                            fontFamily: "inherit",
                            fontSize: "inherit",
                            lineHeight: "inherit",
                            boxSizing: "border-box",
                            resize: "none",
                            overflowX: "hidden",
                            overflowY: "scroll",
                            scrollbarWidth: "none",
                        }}
                        value={editedText}
                    />
                    <div style={{ display: "flex", gap: "8px", marginTop: "8px", justifyContent: "flex-end" }}>
                        {!checkpointManagerErrorMessage && (
                            <RestoreButton
                                isPrimary={false}
                                label="Restore All"
                                onClick={handleRestoreWorkspace}
                                ref={restoreAllButtonRef}
                                title="Restore both the chat and workspace files to this checkpoint and send your edited message"
                                type="taskAndWorkspace"
                            />
                        )}
                        <RestoreButton
                            isPrimary={true}
                            label="Restore Chat"
                            onClick={handleRestoreWorkspace}
                            ref={restoreChatButtonRef}
                            title="Restore just the chat to this checkpoint and send your edited message"
                            type="task"
                        />
                    </div>
                </>
            ) : (
                <ResourceChipResolverContext.Provider value={resolver}>
                    <UserInputMarkdownBody
                        markdown={markdown}
                        submittedEntities={marked !== undefined}
                        testId={queued ? "queued-input-markdown-scroll" : "user-input-markdown-scroll"}
                        variant={queued ? "queued-history" : "direct"}
                    />
                </ResourceChipResolverContext.Provider>
            )}
            {((images && images.length > 0) || (files && files.length > 0)) && (
                <Thumbnails files={files ?? []} images={images ?? []} style={{ marginTop: "8px" }} />
            )}
        </article>
    )
}

// Reusable button component for restore actions
interface RestoreButtonProps {
    type: ClineCheckpointRestore
    label: string
    isPrimary: boolean
    onClick: (type: ClineCheckpointRestore) => void
    title?: string
}

const RestoreButton = forwardRef<HTMLButtonElement, RestoreButtonProps>(({ type, label, isPrimary, onClick, title }, ref) => {
    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation()
        onClick(type)
    }

    return (
        <button
            onClick={handleClick}
            ref={ref}
            style={{
                backgroundColor: isPrimary
                    ? "var(--vscode-button-background)"
                    : "var(--vscode-button-secondaryBackground, var(--vscode-descriptionForeground))",
                color: isPrimary
                    ? "var(--vscode-button-foreground)"
                    : "var(--vscode-button-secondaryForeground, var(--vscode-foreground))",
                border: "none",
                padding: "4px 8px",
                borderRadius: "2px",
                fontSize: "9px",
                cursor: "pointer",
            }}
            title={title}>
            {label}
        </button>
    )
})

export default UserMessage
