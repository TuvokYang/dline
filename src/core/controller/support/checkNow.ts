import { EmptyRequest } from "@shared/proto/dline/common"
import { SupportStatus } from "@shared/proto/dline/support"
import { getSupportTelemetryService } from "@/services/support/SupportTelemetryService"
import type { Controller } from ".."
import { toSupportStatus } from "./getStatus"

export async function checkNow(_controller: Controller, _request: EmptyRequest): Promise<SupportStatus> {
    return toSupportStatus(await getSupportTelemetryService()?.checkNow())
}
