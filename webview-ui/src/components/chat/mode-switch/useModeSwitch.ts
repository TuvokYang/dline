import type { SemanticInputDocument } from "@shared/input-semantics/document"
import type { ModeSwitchSnapshot } from "@shared/mode-switch"
import {
    ModeSwitchOperationRequest,
    type ModeSwitchResponse,
    ModeSwitchStatus,
    PlanActMode,
    TogglePlanActModeRequest,
} from "@shared/proto/dline/state"
import type { Mode } from "@shared/storage/types"
import { hasTransitionDraftContent } from "@shared/TransitionDraft"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { StateServiceClient } from "@/services/grpc-client"
import { type TransitionDraftComposer, transitionChatContentOf } from "./transitionDraft"

/** Immutable input captured when a mode-switch transaction starts. */
export interface ModeSwitchDraft {
    text: string
    images: string[]
    files: string[]
    /**
     * The structure the composer held when the switch started.
     *
     * Captured with the text so confirming the switch submits the same input the
     * user composed, including node order and any lifecycle barrier, instead of
     * a re-parse of the captured string.
     */
    semanticInput?: SemanticInputDocument
}

interface PendingSwitch<TDraft extends ModeSwitchDraft> {
    requestId: number
    operationId?: string
    targetMode: Mode
    startRevision: number
    draft: TDraft
    submitDraftAfterSwitch: boolean
    /**
     * The switch's own account of the draft, from the response that reported it switched.
     *
     * The state stream shows the Mode change but not whether the awaiting dialog
     * took the draft, so a switch that carried one settles only once this is known.
     */
    settled?: { readonly draftDelivered: boolean }
}

/**
 * The draft type is the caller's: the switch only reads the fields of
 * {@link ModeSwitchDraft} and hands the very draft it captured back to `onSend`,
 * so whatever else the caller froze with it survives the switch.
 */
interface UseModeSwitchOptions<TDraft extends ModeSwitchDraft> {
    mode: Mode
    stateRevision: number
    modeSwitch?: ModeSwitchSnapshot
    draft: TDraft
    /** Whether a draft the switch did not deliver is sent as a new message once the Mode changed. */
    submitDraftAfterSwitch?: boolean
    onSend: (draft: TDraft) => void | Promise<void>
    /** The composer the draft is captured from; a settled switch acts on it only while it still holds that draft. */
    composer: TransitionDraftComposer<TDraft>
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

/** What a response that reported the switch done says about the draft it carried. */
function settlementOf(response: ModeSwitchResponse): Pick<PendingSwitch<ModeSwitchDraft>, "settled"> {
    return response.status === ModeSwitchStatus.MODE_SWITCH_STATUS_SWITCHED
        ? { settled: { draftDelivered: response.draftDelivered === true } }
        : {}
}

/**
 * Whether a response leaves the switch with nothing more to report.
 *
 * Only a confirmation still to be given, or a switch done, keeps the request
 * waiting; any other answer ends it. Waiting on it anyway left the toggle
 * disabled for good, since no later response would ever settle it.
 */
function endsWithoutSettlement(response: ModeSwitchResponse, awaitingConfirmation: boolean): boolean {
    if (response.status === ModeSwitchStatus.MODE_SWITCH_STATUS_SWITCHED) return false
    return !(awaitingConfirmation && response.status === ModeSwitchStatus.MODE_SWITCH_STATUS_CONFIRMATION_REQUIRED)
}

/** Convert a shared mode value to its protobuf enum. */
function toProtoMode(mode: Mode): PlanActMode {
    return mode === "plan" ? PlanActMode.PLAN : PlanActMode.ACT
}

/**
 * Clone mutable draft arrays before retaining transaction ownership.
 *
 * Everything else is kept by reference: the document is immutable once
 * composed, so the captured reference is already a stable snapshot.
 */
function cloneDraft<TDraft extends ModeSwitchDraft>(draft: TDraft): TDraft {
    return { ...draft, images: [...draft.images], files: [...draft.files] }
}

/** Coordinate Webview mode-switch RPCs from accepted backend transaction state. */
export function useModeSwitch<TDraft extends ModeSwitchDraft>(options: UseModeSwitchOptions<TDraft>): UseModeSwitchResult {
    const { mode, stateRevision, modeSwitch, draft, submitDraftAfterSwitch = true, onSend, composer } = options
    const [pending, setPending] = useState<PendingSwitch<TDraft>>()
    const nextRequestId = useRef(0)
    const completedRequests = useRef(new Set<number>())
    const onSendRef = useRef(onSend)
    const composerRef = useRef(composer)

    useEffect(() => {
        onSendRef.current = onSend
        composerRef.current = composer
    }, [composer, onSend])

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
            setPending((current) =>
                current?.requestId !== pending.requestId || current.operationId === operationId
                    ? current
                    : { ...current, operationId },
            )
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

        const carriesDraft = hasTransitionDraftContent(pending.draft)
        // The Mode change alone does not say whether the awaiting dialog took the draft.
        if (carriesDraft && !pending.settled) return

        completedRequests.current.add(pending.requestId)
        const completed = pending
        setPending(undefined)
        // A composer edited or emptied since the capture holds the user's newer work.
        if (!carriesDraft || !composerRef.current.holds(completed.draft)) return
        // A delivered draft already answered the dialog; one that was not stays the
        // user's, either sent as their next message or left in the composer.
        if (completed.settled?.draftDelivered) {
            composerRef.current.retire()
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
            const nextPending: PendingSwitch<TDraft> = {
                requestId,
                targetMode,
                startRevision: stateRevision,
                draft: capturedDraft,
                submitDraftAfterSwitch,
            }
            setPending(nextPending)

            try {
                const response = await StateServiceClient.togglePlanActModeProto(
                    TogglePlanActModeRequest.create({
                        mode: toProtoMode(targetMode),
                        chatContent: transitionChatContentOf(capturedDraft),
                    }),
                )
                if (endsWithoutSettlement(response, true) || !response.operationId) {
                    setPending((current) => (current?.requestId === requestId ? undefined : current))
                    return
                }
                setPending((current) =>
                    current?.requestId === requestId
                        ? { ...current, operationId: response.operationId, ...settlementOf(response) }
                        : current,
                )
            } catch {
                setPending((current) => (current?.requestId === requestId ? undefined : current))
            }
        },
        [draft, isSwitchPending, mode, stateRevision, submitDraftAfterSwitch],
    )

    /** Confirm compaction for the active backend operation. */
    const confirmSwitch = useCallback(async (operationId: string): Promise<void> => {
        try {
            const response = await StateServiceClient.confirmModeSwitch(ModeSwitchOperationRequest.create({ operationId }))
            if (endsWithoutSettlement(response, false)) {
                setPending((current) => (current?.operationId === operationId ? undefined : current))
                return
            }
            setPending((current) => (current?.operationId === operationId ? { ...current, ...settlementOf(response) } : current))
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
