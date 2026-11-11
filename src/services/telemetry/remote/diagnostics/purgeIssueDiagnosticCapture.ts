import { purgeIssueDiagnosticOutbox } from "@/core/storage/telemetry-remote/IssueDiagnosticOutboxRepository"
import { IssueGrantRepository } from "@/core/storage/telemetry-remote/IssueGrantRepository"
import type { OtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { IssueGrantPort } from "../auth/IssueGrantPort"

/** Revoke the durable grant before breaking the queue lock so other hosts cannot recreate the purged partition. */
export async function purgeIssueDiagnosticCapture(
    layout: OtelStorageLayout,
    reason: Parameters<IssueGrantPort["clear"]>[0],
    grants: Pick<IssueGrantPort, "clear"> = new IssueGrantRepository(layout),
): Promise<void> {
    await grants.clear(reason)
    await purgeIssueDiagnosticOutbox(layout)
}
