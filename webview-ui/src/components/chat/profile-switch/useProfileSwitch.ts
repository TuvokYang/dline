import type { ProfileSwitchSnapshot } from "@shared/profile-switch"
import { PlanActMode, ProfileSwitchOperationRequest, ProfileSwitchRequest, ProfileSwitchStatus } from "@shared/proto/dline/state"
import type { Mode } from "@shared/storage/types"
import { useCallback, useMemo } from "react"
import { StateServiceClient } from "../../../services/grpc-client"

interface UseProfileSwitchOptions {
    profileSwitch?: ProfileSwitchSnapshot
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
export function useProfileSwitch({ profileSwitch }: UseProfileSwitchOptions): UseProfileSwitchResult {
    const requestSwitch = useCallback(async (targetProfile: string, targetModes: Mode[]): Promise<void> => {
        if (targetModes.length === 0) return
        // A dropped rejection made a refused switch indistinguishable from no request,
        // so the reason has to reach the console even when the snapshot also carries it.
        try {
            const response = await StateServiceClient.requestProfileSwitch(
                ProfileSwitchRequest.create({
                    targetProfile,
                    targetModes: targetModes.map(toProtoMode),
                }),
            )
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
    }, [])

    const confirmSwitch = useCallback(async (operationId: string): Promise<void> => {
        await StateServiceClient.confirmProfileSwitch(ProfileSwitchOperationRequest.create({ operationId })).catch(
            () => undefined,
        )
    }, [])

    const cancelSwitch = useCallback(async (operationId: string): Promise<void> => {
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
