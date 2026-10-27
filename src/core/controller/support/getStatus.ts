import { EmptyRequest } from "@shared/proto/dline/common"
import { SupportStatus } from "@shared/proto/dline/support"
import { getSupportTelemetryService, type SupportStatusProjection } from "@/services/support/SupportTelemetryService"
import type { Controller } from ".."

export function toSupportStatus(status: SupportStatusProjection | undefined): SupportStatus {
    return SupportStatus.create({
        present: Boolean(status),
        publicCode: status?.publicCode ?? "",
        state: status?.state ?? "",
        authorizationExpiresAt: status?.authorizationExpiresAt ?? 0,
        captureExpiresAt: status?.captureExpiresAt,
        issueState: status?.issueState ?? "",
        resolution: status?.resolution,
    })
}

export async function getStatus(_controller: Controller, _request: EmptyRequest): Promise<SupportStatus> {
    return toSupportStatus(await getSupportTelemetryService()?.status())
}
