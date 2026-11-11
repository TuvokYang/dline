import { purgeIssueDiagnosticOutbox } from "@/core/storage/telemetry-remote/IssueDiagnosticOutboxRepository"
import { IssueGrantRepository } from "@/core/storage/telemetry-remote/IssueGrantRepository"
import type { OtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { IssueGrantPort } from "../auth/IssueGrantPort"

/** Seal the durable authorization before purging issue-only files, without abandoning either cleanup on failure. */
export async function purgeIssueDiagnosticCapture(
    layout: OtelStorageLayout,
    reason: Parameters<IssueGrantPort["clear"]>[0],
    grants: Pick<IssueGrantPort, "clear"> = new IssueGrantRepository(layout),
): Promise<void> {
    const sealed = await Promise.allSettled([grants.clear(reason)])
    const purged = await Promise.allSettled([purgeIssueDiagnosticOutbox(layout)])
    const errors = [...sealed, ...purged].flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "Could not stop temporary support telemetry")
}
