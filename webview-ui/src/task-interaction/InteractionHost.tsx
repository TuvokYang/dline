import type { ClineMessage, TaskViewAction, TaskViewState } from "@shared/ExtensionMessage"
import { EmptyRequest } from "@shared/proto/dline/common"
import { AskResponseRequest, MoveCommandToBackgroundRequest } from "@shared/proto/dline/task"
import { useState } from "react"
import { TaskServiceClient } from "@/services/grpc-client"
import { FooterActions } from "./FooterActions"
import { isPresentationKind, renderPresentation } from "./renderer-registry"
import {
	type AcceptedInteractionSettlement,
	type DispatchInteraction,
	findActiveInteractionAnchor,
	type InteractionDraft,
	type PendingSuccessorDraftTransfer,
} from "./types"

/** Presentation-only props for a say timeline row. */
export interface SayViewProps {
	message: ClineMessage
}

/** Presentation-only say row with no action or dispatch capability. */
export function SayView({ message }: SayViewProps) {
	return <div>{message.text}</div>
}

/** Presentation-only props for an ask timeline row. */
export interface AskViewProps {
	message: ClineMessage
}

/** Read-only ask presentation; actions are rendered only by the host footer. */
export function AskView({ message }: AskViewProps) {
	return <div>{message.text}</div>
}

/** Props for the task interaction synchronization boundary. */
export interface InteractionHostProps {
	messages: ClineMessage[]
	view: TaskViewState
	dispatch: DispatchInteraction
	draft?: InteractionDraft
	showTimeline?: boolean
	onDraftAccepted?: (settlement: AcceptedInteractionSettlement) => void
	onDraftRejected?: (settlement: AcceptedInteractionSettlement) => void
	onSuccessorAccepted?: (transfer: PendingSuccessorDraftTransfer) => void
}

const EMPTY_DRAFT: InteractionDraft = { text: "", images: [], files: [], activeQuote: null }

const DIAGNOSTIC_MESSAGES = {
	interaction_anchor_missing: "Dline could not restore the saved interaction message. The task remains saved for recovery.",
	interaction_anchor_is_say: "Dline found an invalid saved interaction message. The task remains saved for recovery.",
} as const

/**
 * Shown when the backend still owns an awaiting interaction but its ask anchor
 * cannot be matched in the projected messages. The backend anchor is intact in
 * this case, so it emits no diagnostic, and without this notice the controls
 * would disappear with no explanation while the task keeps waiting. The text
 * stays purely descriptive: no recovery action is known to be safe here.
 */
const UNRESOLVED_ANCHOR_MESSAGE =
	"Dline is waiting on a request whose message anchor could not be matched, so its controls are unavailable. The task remains saved for recovery."

async function dispatchTaskAction(view: TaskViewState, action: TaskViewAction): Promise<void> {
	if (action.type === "retry") {
		await TaskServiceClient.askResponse(AskResponseRequest.create({ responseType: "retry" }))
		return
	}
	if (action.type === "continue_in_background") {
		if (!action.activityId) {
			throw new Error("The foreground activity is no longer available to continue in the background.")
		}
		const response = await TaskServiceClient.moveCommandToBackground(
			MoveCommandToBackgroundRequest.create({ taskId: view.taskId, activityId: action.activityId }),
		)
		if (!response.moved) {
			throw new Error("The foreground activity is no longer available to continue in the background.")
		}
		return
	}
	await TaskServiceClient.cancelTask(EmptyRequest.create({}))
}

/** Bind one backend interaction projection to its exact ask presentation anchor. */
export function InteractionHost({
	messages,
	view,
	dispatch,
	draft = EMPTY_DRAFT,
	showTimeline = true,
	onDraftAccepted,
	onDraftRejected,
	onSuccessorAccepted,
}: InteractionHostProps) {
	const [selection, setSelection] = useState<string[]>([])
	const interaction = view.activeInteraction
	const anchor = findActiveInteractionAnchor(messages, view)
	const successorContext = interaction?.kind === "new_task" ? anchor?.text : undefined
	const presentationKind = interaction?.presentationKind
	const supported = presentationKind ? isPresentationKind(presentationKind) : false
	const taskActionDispatcher = (action: TaskViewAction) => dispatchTaskAction(view, action)
	const taskOnlyView: TaskViewState = {
		...view,
		activeInteraction: undefined,
		input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
		footer: { actions: view.footer.actions.filter((action) => action.dispatchTarget === "task") },
	}

	return (
		<section>
			{view.diagnostic ? (
				<div className="mx-3.5 mb-1 text-xs text-(--vscode-errorForeground)" role="alert">
					{DIAGNOSTIC_MESSAGES[view.diagnostic.code]}
				</div>
			) : null}
			{showTimeline &&
				messages.map((message, index) => {
					if (message === anchor && supported) {
						return null
					}
					return message.type === "say" ? (
						<SayView key={`${message.ts}:${message.interactionId ?? ""}:${index}`} message={message} />
					) : (
						<AskView key={`${message.ts}:${message.interactionId ?? ""}:${index}`} message={message} />
					)
				})}
			{interaction && (!anchor || !supported) ? (
				<>
					{!anchor && !view.diagnostic ? (
						<div className="mx-3.5 mb-1 text-xs text-(--vscode-errorForeground)" role="alert">
							{UNRESOLVED_ANCHOR_MESSAGE}
						</div>
					) : null}
					<FooterActions
						dispatch={dispatch}
						dispatchTaskAction={taskActionDispatcher}
						draft={draft}
						onDraftAccepted={onDraftAccepted}
						onDraftRejected={onDraftRejected}
						onSuccessorAccepted={onSuccessorAccepted}
						successorContext={successorContext}
						view={taskOnlyView}
					/>
				</>
			) : anchor && presentationKind && isPresentationKind(presentationKind) ? (
				<>
					{showTimeline
						? renderPresentation(presentationKind, { message: anchor, selection, onSelectionChange: setSelection })
						: null}
					<FooterActions
						dispatch={dispatch}
						dispatchTaskAction={taskActionDispatcher}
						draft={draft}
						onDraftAccepted={onDraftAccepted}
						onDraftRejected={onDraftRejected}
						onSuccessorAccepted={onSuccessorAccepted}
						selection={{ values: selection }}
						successorContext={successorContext}
						view={view}
					/>
				</>
			) : (
				<FooterActions
					dispatch={dispatch}
					dispatchTaskAction={taskActionDispatcher}
					draft={draft}
					onDraftAccepted={onDraftAccepted}
					onDraftRejected={onDraftRejected}
					onSuccessorAccepted={onSuccessorAccepted}
					successorContext={successorContext}
					view={view}
				/>
			)}
		</section>
	)
}
