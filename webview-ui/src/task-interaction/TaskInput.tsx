import type { TaskViewState } from "@shared/ExtensionMessage"
import { BooleanRequest } from "@shared/proto/dline/common"
import type { KeyboardEvent } from "react"
import { FileServiceClient } from "@/services/grpc-client"
import { buildInteractionRequest, type DispatchInteraction, type InteractionDraft } from "./types"

/** Props for an input controlled exclusively by backend interaction policy. */
export interface TaskInputProps {
    view: TaskViewState
    draft: InteractionDraft
    onDraftChange: (draft: InteractionDraft) => void
    dispatch: DispatchInteraction
}

/** Render interaction draft input and dispatch only the configured Enter action. */
export function TaskInput({ view, draft, onDraftChange, dispatch }: TaskInputProps) {
    const canSelectAttachments = view.input.enabled && (view.input.acceptsImages || view.input.acceptsFiles)

    const selectAttachments = async () => {
        if (!canSelectAttachments) return
        const response = await FileServiceClient.selectFiles(BooleanRequest.create({ value: view.input.acceptsImages }))
        onDraftChange({
            ...draft,
            images: view.input.acceptsImages ? [...draft.images, ...response.values1] : draft.images,
            files: view.input.acceptsFiles ? [...draft.files, ...response.values2] : draft.files,
        })
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== "Enter" || event.shiftKey || !view.input.enterAction) {
            return
        }
        const request = buildInteractionRequest(view, view.input.enterAction, draft)
        if (!request) {
            return
        }
        event.preventDefault()
        void dispatch(request)
    }

    return (
        <div>
            <textarea
                aria-label="Task input"
                disabled={!view.input.enabled || !view.input.acceptsText}
                onChange={(event) => onDraftChange({ ...draft, text: event.target.value })}
                onKeyDown={handleKeyDown}
                value={draft.text}
            />
            {canSelectAttachments ? (
                <button onClick={() => void selectAttachments()} type="button">
                    Add attachments
                </button>
            ) : null}
            {draft.images.map((image, index) => (
                <button
                    aria-label={`Remove image ${index + 1}`}
                    key={`${image}-${index}`}
                    onClick={() => onDraftChange({ ...draft, images: draft.images.filter((_, item) => item !== index) })}
                    type="button">
                    {image}
                </button>
            ))}
            {draft.files.map((file, index) => (
                <button
                    aria-label={`Remove file ${index + 1}`}
                    key={`${file}-${index}`}
                    onClick={() => onDraftChange({ ...draft, files: draft.files.filter((_, item) => item !== index) })}
                    type="button">
                    {file}
                </button>
            ))}
        </div>
    )
}
