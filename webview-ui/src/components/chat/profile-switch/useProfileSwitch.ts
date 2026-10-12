import type { ProfileSwitchSnapshot } from "@shared/profile-switch"
import {
    PlanActMode,
    ProfileSwitchOperationRequest,
    ProfileSwitchRequest,
    type ProfileSwitchResponse,
    ProfileSwitchStatus,
} from "@shared/proto/dline/state"
import type { Mode } from "@shared/storage/types"
import { useCallback, useEffect, useMemo, useRef } from "react"
import { StateServiceClient } from "../../../services/grpc-client"
import {
    type TransitionDraftComposer,
    type TransitionDraftContent,
    transitionChatContentOf,
} from "../mode-switch/transitionDraft"

interface UseProfileSwitchOptions {
    profileSwitch?: ProfileSwitchSnapshot
    /**
     * The composer draft a switch carries, read when the switch is requested.
     *
     * The task delivers it as the reply of a dialog awaiting one, under the
     * Profile the user chose; without such a dialog it stays in the composer.
     */
    draft?: TransitionDraftContent
    /** The composer the draft came from; it lets go of a delivered draft only while it still holds it. */
    composer?: TransitionDraftComposer
}

interface UseProfileSwitchResult {
    requestSwitch: (targetProfile: string, targetModes: Mode[]) => Promise<void>
    confirmSwitch: (operationId: string) => Promise<void>
    cancelSwitch: (operationId: string) => Promise<void>
    statusText?: string
    error?: string
}

/** Convert a shared mode to its protobuf value. */
function toProtoMode(mode: Mode): PlanActMode {
    return mode === "plan" ? PlanActMode.PLAN : PlanActMode.ACT
}

/**
 * Coordinate Profile-switch RPCs without optimistically adopting target settings.
 *
 * Selecting a Profile only rebinds which handler the task uses, so the selector never
 * blocks the user. A previous client-side `pending` latch tried to serialize requests
 * and could strand itself when a snapshot settled on the revision that started it,
 * which disabled the selector until the extension restarted. The backend transition
 * engine already owns serialization through its lease, so the client only reflects the
 * published phase.
 */
export function useProfileSwitch({ profileSwitch, draft, composer }: UseProfileSwitchOptions): UseProfileSwitchResult {
    const draftRef = useRef(draft)
    const composerRef = useRef(composer)
    // A confirmation answers a request made earlier; the draft that request carried
    // is what the confirmed switch delivers, whatever the composer holds by then.
    const awaitingConfirmation = useRef(new Map<string, TransitionDraftContent>())
    useEffect(() => {
        draftRef.current = draft
        composerRef.current = composer
    }, [composer, draft])

    /** Retire the composer only on the switch's own word that the dialog took the draft it captured. */
    const settle = useCallback((response: ProfileSwitchResponse, captured: TransitionDraftContent | undefined): void => {
        if (response.status !== ProfileSwitchStatus.PROFILE_SWITCH_STATUS_SWITCHED || response.draftDelivered !== true) return
        const current = composerRef.current
        if (captured && current?.holds(captured)) current.retire()
    }, [])

    const requestSwitch = useCallback(
        async (targetProfile: string, targetModes: Mode[]): Promise<void> => {
            if (targetModes.length === 0) return
            const capturedDraft = draftRef.current
            // A dropped rejection made a refused switch indistinguishable from no request,
            // so the reason has to reach the console even when the snapshot also carries it.
            try {
                const response = await StateServiceClient.requestProfileSwitch(
                    ProfileSwitchRequest.create({
                        targetProfile,
                        targetModes: targetModes.map(toProtoMode),
                        chatContent: capturedDraft ? transitionChatContentOf(capturedDraft) : undefined,
                    }),
                )
                if (
                    response.status === ProfileSwitchStatus.PROFILE_SWITCH_STATUS_CONFIRMATION_REQUIRED &&
                    response.operationId &&
                    capturedDraft
                ) {
                    awaitingConfirmation.current.set(response.operationId, capturedDraft)
                }
                settle(response, capturedDraft)
                // `rejected` and `in_progress` publish no snapshot, so discarding the status
                // left a refused switch looking exactly like a click that never happened.
                if (response.status === ProfileSwitchStatus.PROFILE_SWITCH_STATUS_REJECTED) {
                    console.error("Profile switch rejected", response.error ?? "no reason reported")
                } else if (response.status === ProfileSwitchStatus.PROFILE_SWITCH_STATUS_IN_PROGRESS) {
                    console.error("Profile switch deferred: another transition owns the task", response.operationId)
                }
            } catch (error: unknown) {
                console.error("Profile switch request failed", error)
            }
        },
        [settle],
    )

    const confirmSwitch = useCallback(
        async (operationId: string): Promise<void> => {
            const captured = awaitingConfirmation.current.get(operationId)
            awaitingConfirmation.current.delete(operationId)
            const response = await StateServiceClient.confirmProfileSwitch(
                ProfileSwitchOperationRequest.create({ operationId }),
            ).catch(() => undefined)
            if (response) settle(response, captured)
        },
        [settle],
    )

    const cancelSwitch = useCallback(async (operationId: string): Promise<void> => {
        awaitingConfirmation.current.delete(operationId)
        await StateServiceClient.cancelProfileSwitch(ProfileSwitchOperationRequest.create({ operationId })).catch(() => undefined)
    }, [])

    const statusText = useMemo(() => {
        switch (profileSwitch?.phase) {
            case "preflighting":
                return "Checking target context window..."
            case "awaiting_confirmation":
                return "Confirmation required"
            case "committing":
                return `Activating ${profileSwitch.targetProfile ?? "target Profile"}...`
            case "failed":
                return undefined
            default:
                return undefined
        }
    }, [profileSwitch])

    return {
        requestSwitch,
        confirmSwitch,
        cancelSwitch,
        statusText,
        error: profileSwitch?.phase === "failed" ? profileSwitch.error : undefined,
    }
}
