import { Empty, EmptyRequest } from "@shared/proto/dline/common"
import { getSupportTelemetryService } from "@/services/support/SupportTelemetryService"
import type { Controller } from ".."

export async function openIssue(_controller: Controller, _request: EmptyRequest): Promise<Empty> {
    await getSupportTelemetryService()?.openIssue()
    return Empty.create()
}
