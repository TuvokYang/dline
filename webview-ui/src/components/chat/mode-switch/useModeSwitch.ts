import type { ClineAsk } from "@shared/ExtensionMessage"
import type { ModeSwitchSnapshot } from "@shared/mode-switch"
import { ModeSwitchOperationRequest, ModeSwitchStatus, PlanActMode, TogglePlanActModeRequest } from "@shared/proto/dline/state"
import type { Mode } from "@shared/storage/types"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { StateServiceClient } from "@/services/grpc-client"

/** Immutable input captured when a mode-switch transaction starts. */
export interface ModeSwitchDraft {
	text: string
	images: string[]
	files: string[]
}

interface PendingSwitch {
	requestId: number
	operationId?: string
	targetMode: Mode
	startRevision: number
	draft: ModeSwitchDraft
	attachDraft: boolean
	submitDraftAfterSwitch: boolean
}

interface UseModeSwitchOptions {
	mode: Mode
	stateRevision: number
	modeSwitch?: ModeSwitchSnapshot
	draft: ModeSwitchDraft
	attachDraft: boolean
	submitDraftAfterSwitch?: boolean
	onSend: (draft: ModeSwitchDraft) => void | Promise<void>
	clearDraft: () => void
}

interface UseModeSwitchResult {
	requestSwitch: (targetMode: Mode) => Promise<void>
	confirmSwitch: (operationId: string) => Promise<void>
	cancelSwitch: (operationId: string) => Promise<void>
	isSwitchPending: boolean
	statusText?: string
	displayMode: Mode
}

const ACTIVE_PHASES = new Set<ModeSwitchSnapshot["phase"]>(["awaiting_confirmation", "compacting", "committing"])
const MODE_SWITCH_OWNED_ASKS = new Set<ClineAsk>([
	"followup",
	"make_plan",
	"qna_respond",
	"generate_report",
	"status_acknowledgment",
	"completion_result",
])

/** Return whether a captured draft contains user-authored content. */
function hasDraft(draft: ModeSwitchDraft): boolean {
	return Boolean(draft.text.trim() || draft.images.length || draft.files.length)
}

/** Return whether the active interaction owns the draft submitted with a mode switch. */
export function shouldAttachModeSwitchDraft(clineAsk: ClineAsk | undefined): boolean {
	return clineAsk !== undefined && MODE_SWITCH_OWNED_ASKS.has(clineAsk)
}

/** Convert a shared mode value to its protobuf enum. */
function toProtoMode(mode: Mode): PlanActMode {
	return mode === "plan" ? PlanActMode.PLAN : PlanActMode.ACT
}

/** Clone mutable draft arrays before retaining transaction ownership. */
function cloneDraft(draft: ModeSwitchDraft): ModeSwitchDraft {
	return {
		text: draft.text,
		images: [...draft.images],
		files: [...draft.files],
	}
}

/** Coordinate Webview mode-switch RPCs from accepted backend transaction state. */
export function useModeSwitch(options: UseModeSwitchOptions): UseModeSwitchResult {
	const { mode, stateRevision, modeSwitch, draft, attachDraft, submitDraftAfterSwitch = true, onSend, clearDraft } = options
	const [pending, setPending] = useState<PendingSwitch>()
	const nextRequestId = useRef(0)
	const completedRequests = useRef(new Set<number>())
	const onSendRef = useRef(onSend)
	const clearDraftRef = useRef(clearDraft)

	useEffect(() => {
		onSendRef.current = onSend
		clearDraftRef.current = clearDraft
	}, [clearDraft, onSend])

	const backendPending = Boolean(modeSwitch && ACTIVE_PHASES.has(modeSwitch.phase))
	const isSwitchPending = Boolean(pending) || backendPending

	useEffect(() => {
		if (!pending || stateRevision <= pending.startRevision) return
		const matchingSnapshot =
			modeSwitch?.operationId &&
			modeSwitch.targetMode === pending.targetMode &&
			(!pending.operationId || modeSwitch.operationId === pending.operationId)
				? modeSwitch
				: undefined

		if (matchingSnapshot?.phase === "failed") {
			setPending(undefined)
			return
		}

		if (matchingSnapshot && matchingSnapshot.phase !== "idle") {
			const operationId = matchingSnapshot.operationId
			const backendOwnsDraft = matchingSnapshot.phase === "awaiting_confirmation" || matchingSnapshot.phase === "compacting"
			setPending((current) => {
				if (current?.requestId !== pending.requestId) return current
				const nextAttachDraft = current.attachDraft || backendOwnsDraft
				if (current.operationId === operationId && current.attachDraft === nextAttachDraft) return current
				return { ...current, operationId, attachDraft: nextAttachDraft }
			})
			return
		}

		if (modeSwitch?.phase === "idle" && pending.operationId && mode !== pending.targetMode) {
			setPending(undefined)
			return
		}

		if (modeSwitch?.phase !== "idle" || mode !== pending.targetMode) return
		if (completedRequests.current.has(pending.requestId)) {
			setPending(undefined)
			return
		}

		completedRequests.current.add(pending.requestId)
		const completed = pending
		setPending(undefined)
		if (!hasDraft(completed.draft)) return
		if (completed.attachDraft) {
			clearDraftRef.current()
			return
		}
		if (completed.submitDraftAfterSwitch) {
			void onSendRef.current(completed.draft)
		}
	}, [mode, modeSwitch, pending, stateRevision])

	/** Request a new mode-switch transaction while preserving the current draft. */
	const requestSwitch = useCallback(
		async (targetMode: Mode): Promise<void> => {
			if (isSwitchPending || targetMode === mode) return
			const capturedDraft = cloneDraft(draft)
			const requestId = ++nextRequestId.current
			const nextPending: PendingSwitch = {
				requestId,
				targetMode,
				startRevision: stateRevision,
				draft: capturedDraft,
				attachDraft,
				submitDraftAfterSwitch,
			}
			setPending(nextPending)

			try {
				const response = await StateServiceClient.togglePlanActModeProto(
					TogglePlanActModeRequest.create({
						mode: toProtoMode(targetMode),
						chatContent: hasDraft(capturedDraft)
							? {
									message: capturedDraft.text || undefined,
									images: capturedDraft.images,
									files: capturedDraft.files,
								}
							: undefined,
					}),
				)
				if (
					response.status === ModeSwitchStatus.MODE_SWITCH_STATUS_REJECTED ||
					response.status === ModeSwitchStatus.MODE_SWITCH_STATUS_UNSPECIFIED ||
					response.status === ModeSwitchStatus.UNRECOGNIZED ||
					!response.operationId
				) {
					setPending((current) => (current?.requestId === requestId ? undefined : current))
					return
				}
				setPending((current) =>
					current?.requestId === requestId
						? {
								...current,
								operationId: response.operationId,
								attachDraft:
									current.attachDraft ||
									response.status === ModeSwitchStatus.MODE_SWITCH_STATUS_CONFIRMATION_REQUIRED,
							}
						: current,
				)
			} catch {
				setPending((current) => (current?.requestId === requestId ? undefined : current))
			}
		},
		[attachDraft, draft, isSwitchPending, mode, stateRevision, submitDraftAfterSwitch],
	)

	/** Confirm compaction for the active backend operation. */
	const confirmSwitch = useCallback(async (operationId: string): Promise<void> => {
		try {
			const response = await StateServiceClient.confirmModeSwitch(ModeSwitchOperationRequest.create({ operationId }))
			if (response.status === ModeSwitchStatus.MODE_SWITCH_STATUS_REJECTED) {
				setPending((current) => (current?.operationId === operationId ? undefined : current))
			}
		} catch {
			setPending((current) => (current?.operationId === operationId ? undefined : current))
		}
	}, [])

	/** Cancel the active confirmation while retaining all draft fields. */
	const cancelSwitch = useCallback(async (operationId: string): Promise<void> => {
		try {
			await StateServiceClient.cancelModeSwitch(ModeSwitchOperationRequest.create({ operationId }))
		} finally {
			setPending((current) => (current?.operationId === operationId ? undefined : current))
		}
	}, [])

	const statusText = useMemo(() => {
		switch (modeSwitch?.phase) {
			case "preflighting":
				return "Checking..."
			case "awaiting_confirmation":
				return "Confirm"
			case "compacting":
				return "Compacting..."
			case "committing":
				return "Switching..."
			case "failed":
				return "Switch failed"
			default:
				return undefined
		}
	}, [modeSwitch?.phase])

	return {
		requestSwitch,
		confirmSwitch,
		cancelSwitch,
		isSwitchPending,
		statusText,
		displayMode: mode,
	}
}
