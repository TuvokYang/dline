import { mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { ExportRuntimeTelemetryBundleRequest, ExportRuntimeTelemetryBundleResponse } from "@shared/proto/dline/state"
import { getDlineDataDir } from "@/core/storage/disk"
import { exportDiagnosticBundle } from "@/services/telemetry/runtime/export/diagnostic-exporter"
import { getDiagnosticSource } from "@/services/telemetry/runtime/host"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."

/**
 * Write the current session's diagnostic bundle under the Dline data directory.
 *
 * The archive lands in a fixed directory next to the telemetry journals it is
 * built from, rather than at a path the user picks. A save dialog is modal: it
 * turns "give me my diagnostics" into a second decision at the moment something
 * is already wrong, and an unanswered dialog leaves the caller waiting with no
 * way to tell that apart from a slow export. A known directory is also easier
 * to name in a bug report than whatever path a user chose.
 *
 * The command lives here rather than in the telemetry package because it needs
 * the extension's version, which the package must not depend on. Keeping the
 * direction that way lets the exporter stay testable without a host.
 *
 * Raw artifacts are never attached. The request carries the flag so the
 * contract is stable, but honouring it requires a confirmation UI that names
 * the files being attached; until that exists, silently including raw content
 * because a boolean was set would defeat the export's privacy default.
 */

/** Directory holding every exported bundle, alongside the telemetry journals. */
function diagnosticsDirectory(): string {
    return path.join(getDlineDataDir(), "diagnostics")
}

/**
 * Timestamped name so repeated exports accumulate instead of overwriting.
 *
 * Colons and dots are illegal or awkward in Windows paths, so the ISO stamp is
 * flattened to dashes.
 */
function bundleFileName(now: Date): string {
    const stamp = now.toISOString().replaceAll(/[:.]/g, "-")
    return `dline-diagnostics-${stamp}.zip`
}

function describeFailure(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error)
}

export async function exportRuntimeTelemetryBundle(
    controller: Controller,
    request: ExportRuntimeTelemetryBundleRequest,
): Promise<ExportRuntimeTelemetryBundleResponse> {
    const source = getDiagnosticSource()
    if (!source) {
        // Distinct from an empty bundle: telemetry never started, so there is
        // nothing to export and no file should be created.
        return ExportRuntimeTelemetryBundleResponse.create({
            error: "Runtime telemetry is not running. Enable error and usage reporting, then retry.",
        })
    }

    if (request.includeRawArtifacts) {
        Logger.warn(
            "[exportRuntimeTelemetryBundle] Raw artifacts requested but no confirmation flow exists; exporting without them",
        )
    }

    try {
        const directory = diagnosticsDirectory()
        await mkdir(directory, { recursive: true })

        const { archive } = await exportDiagnosticBundle(source, {
            destinationPath: path.join(directory, bundleFileName(new Date())),
            extensionVersion: controller.context.extension?.packageJSON?.version ?? "unknown",
            hostVersion: process.versions.node,
        })

        // Report the size from disk rather than from the builder: the caller
        // needs to know what was actually written, and a zero-byte file is the
        // symptom this number exists to surface.
        const written = await stat(archive.path)
        return ExportRuntimeTelemetryBundleResponse.create({
            path: archive.path,
            sizeBytes: written.size,
        })
    } catch (error) {
        Logger.error("[exportRuntimeTelemetryBundle] Export failed:", error)
        return ExportRuntimeTelemetryBundleResponse.create({
            error: describeFailure(error),
        })
    }
}
