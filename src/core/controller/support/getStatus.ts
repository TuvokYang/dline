import { EmptyRequest } from "@shared/proto/dline/common"
import { SupportRefresh, SupportStatus } from "@shared/proto/dline/support"
import { getSupportTelemetryService, type SupportStatusProjection } from "@/services/support/SupportTelemetryService"
import type { Controller } from ".."

export function toSupportStatus(status: SupportStatusProjection | undefined): SupportStatus {
    const refresh = status?.refresh
    return SupportStatus.create({
        present: Boolean(status),
        publicCode: status?.publicCode ?? "",
        state: status?.state ?? "",
        authorizationExpiresAt: status?.authorizationExpiresAt ?? 0,
        captureExpiresAt: status?.captureExpiresAt,
        issueState: status?.issueState ?? "",
        resolution: status?.resolution,
        // Only a refusal or an unreachable service produces this node; an
        // ordinary projection stays exactly as it was before the field existed.
        refresh:
            refresh === undefined
                ? undefined
                : SupportRefresh.create({
                      state: refresh.state,
                      nextQueryAt: refresh.nextQueryAt,
                      reason: refresh.reason,
                  }),
    })
}

export async function getStatus(_controller: Controller, _request: EmptyRequest): Promise<SupportStatus> {
    return toSupportStatus(await getSupportTelemetryService()?.status())
}
