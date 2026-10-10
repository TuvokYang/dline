import os from "node:os"
import type { RootCauseDiagnosis } from "../analysis/root-cause-types"
import type { RuntimeTelemetryEvent } from "../types"
import { readBuildIdentity } from "./build-identity"
import { type BundleArchiveResult, writeBundleArchive } from "./bundle-archive-writer"
import { type BuiltBundle, type BundleEnvironment, buildDiagnosticBundle, type RawArtifact } from "./bundle-builder"

/**
 * Turns the live telemetry state into a diagnostic bundle on disk.
 *
 * This is the seam between the telemetry pipeline and the file system. The
 * builder decides what a bundle may contain and the archive writer decides how
 * it reaches disk; the exporter only supplies the inputs and enforces the one
 * rule that spans both: raw artifacts require an explicit, per-export consent
 * that defaults to absent.
 */

/** Source of the events and diagnoses to export. */
export interface DiagnosticSource {
    readonly sessionId: string
    /** Events currently available, oldest first. */
    events(): readonly RuntimeTelemetryEvent[]
    /** Diagnoses produced for those events. */
    diagnoses(): readonly RootCauseDiagnosis[]
}

/**
 * Consent for attaching raw artifacts.
 *
 * Modelled as a required, explicit object rather than an optional flag: a
 * caller that forgets to pass it gets a bundle without raw content, which is
 * the safe outcome. The artifacts are supplied by the caller because choosing
 * them belongs to the confirmation UI, not to this module — the exporter must
 * never scan the workspace looking for things to attach.
 */
export interface RawArtifactConsent {
    readonly confirmed: boolean
    readonly artifacts: readonly RawArtifact[]
}

export interface ExportRequest {
    readonly destinationPath: string
    readonly extensionVersion: string
    readonly hostVersion: string
    readonly rawConsent?: RawArtifactConsent
    /** Injectable so tests do not depend on wall time. */
    readonly now?: () => number
}

export interface ExportResult {
    readonly archive: BundleArchiveResult
    readonly bundle: BuiltBundle
}

export function describeEnvironment(extensionVersion: string, hostVersion: string): BundleEnvironment {
    return {
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.versions.node,
        hostVersion,
        extensionVersion,
        cpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
    }
}

/**
 * Build and write a bundle for `source`.
 *
 * Returns the built bundle alongside the archive result so a caller can report
 * the manifest and checksums without reopening the zip.
 */
export async function exportDiagnosticBundle(source: DiagnosticSource, request: ExportRequest): Promise<ExportResult> {
    const identity = readBuildIdentity()
    const bundle = buildDiagnosticBundle({
        sessionId: source.sessionId,
        createdAt: (request.now ?? Date.now)(),
        events: source.events(),
        diagnoses: source.diagnoses(),
        environment: describeEnvironment(request.extensionVersion, request.hostVersion),
        buildId: identity.buildId,
        rawArtifacts: selectRawArtifacts(request.rawConsent),
    })

    const archive = await writeBundleArchive(bundle, request.destinationPath)
    return { archive, bundle }
}

/**
 * Raw artifacts are included only when consent was confirmed for this export.
 *
 * An unconfirmed consent object carrying artifacts is treated as no artifacts
 * rather than as an error: it means the confirmation flow was abandoned, and
 * the user's last expressed intent was not to attach them.
 */
function selectRawArtifacts(consent: RawArtifactConsent | undefined): readonly RawArtifact[] {
    if (!consent?.confirmed) return []
    return consent.artifacts
}
