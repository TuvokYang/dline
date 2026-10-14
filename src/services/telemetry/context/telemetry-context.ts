import type { TelemetryProperties } from "../providers/ITelemetryProvider"

/** Host metadata shared by every canonical telemetry signal. */
export type TelemetryMetadata = {
    /** Extension or core version. */
    extension_version: string
    /** Distribution type, such as the VS Code extension or CLI. */
    dline_type: string
    /** Host IDE or environment name. */
    platform: string
    /** Host environment version. */
    platform_version: string
    /** Operating system type. */
    os_type: string
    /** Operating system version. */
    os_version: string
    /** Whether the current workspace is remote. */
    is_remote_workspace: boolean
    /** Development-mode marker, when present. */
    is_dev: string | undefined
}

/**
 * Owns host metadata for the canonical telemetry pipeline.
 *
 * Account identity deliberately does not live here. It is emitted through the
 * dedicated account channel so ordinary events and metrics cannot inherit a
 * user or organization identity by accident.
 */
export class TelemetryContext {
    private metadata: TelemetryMetadata

    constructor(metadata: TelemetryMetadata) {
        this.metadata = metadata
    }

    /** Replace host metadata once the host bridge has answered. */
    setMetadata(metadata: TelemetryMetadata): void {
        this.metadata = metadata
    }

    get hostMetadata(): TelemetryMetadata {
        return this.metadata
    }

    /** Host metadata merged onto event properties. */
    eventProperties(properties?: TelemetryProperties): TelemetryProperties {
        return {
            ...(properties ?? {}),
            ...this.metadata,
        }
    }

    /** Host metadata merged onto metric attributes, without account identity. */
    metricAttributes(attributes?: TelemetryProperties): TelemetryProperties {
        return {
            ...this.metadata,
            ...(attributes ?? {}),
        }
    }
}
