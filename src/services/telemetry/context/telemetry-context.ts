import type { ClineAccountUserInfo } from "@/services/auth/AuthService"
import type { TelemetryProperties } from "../providers/ITelemetryProvider"

/**
 * Host and account identity attached to outgoing telemetry.
 *
 * Every recorder needs the same host fields and, for metrics, the same account
 * fields. Keeping that merge in one owner is what stops each `capture*` method
 * from assembling identity its own way — the drift that made the previous
 * implementation attach organization ids to some metrics and not others.
 */

export type TelemetryMetadata = {
    /**
     * The extension or cline-core version. JetBrains and CLI have different
     * versioning than the VSCode Extension, but on those platforms this will be the _cline-core version_
     * which uses the same as the versioning as the VSCode extension.
     */
    extension_version: string
    /**
     * The type of cline distribution, e.g VSCode Extension, JetBrains Plugin or CLI. This
     * is different than the `platform` because there are many variants of VSCode and JetBrains but they
     * all use the same extension or plugin.
     */
    dline_type: string
    /** The name of the host IDE or environment e.g. VSCode, Cursor, IntelliJ Professional Edition, etc. */
    platform: string
    /** The version of the host environment */
    platform_version: string
    /** The operating system type, e.g. darwin, win32. This is the value returned by os.platform() */
    os_type: string
    /** The operating system version e.g. 'Windows 10 Pro', 'Darwin Kernel Version 21.6.0...'
     * This is the value returned by os.version() */
    os_version: string
    /** Whether the current workspace is a VS Code remote workspace */
    is_remote_workspace: boolean
    /** Whether the extension is running in development mode */
    is_dev: string | undefined
}

/** The organization a signed-in user is currently acting within. */
export interface ActiveOrganization {
    organization_id: string
    organization_name: string
    member_id: string
}

/**
 * Owns host metadata and account identity for the telemetry pipeline.
 *
 * Host metadata is replaceable because the facade is constructed
 * synchronously — the host version arrives from an async bridge call and is
 * attached once it resolves. Until then events still carry the placeholder
 * fields rather than being dropped, because losing early events would hide
 * exactly the activation problems telemetry exists to surface.
 */
export class TelemetryContext {
    private metadata: TelemetryMetadata
    private userId?: string
    private activeOrg: ActiveOrganization | null = null

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

    get currentUserId(): string | undefined {
        return this.userId
    }

    get organization(): ActiveOrganization | null {
        return this.activeOrg
    }

    /**
     * Record who is signed in and which organization is active.
     *
     * Returns the identity so a caller can forward it to providers without
     * reaching back into this object for each field.
     */
    identify(userInfo: ClineAccountUserInfo): void {
        this.userId = userInfo.id
        const activeOrg = userInfo.organizations?.find((org) => org.active)
        this.activeOrg = activeOrg
            ? {
                  organization_id: activeOrg.organizationId,
                  organization_name: activeOrg.name,
                  member_id: activeOrg.memberId,
              }
            : null
    }

    /** Host metadata merged onto event properties. */
    eventProperties(properties?: TelemetryProperties): TelemetryProperties {
        return {
            ...(properties ?? {}),
            ...this.metadata,
        }
    }

    /**
     * Host metadata plus account identity, merged onto metric attributes.
     *
     * Account identity is included here but not on events because the metric
     * consumers group by organization; whether that remains appropriate for
     * cardinality is decided later in this workstream, not by individual
     * recorders.
     */
    metricAttributes(attributes?: TelemetryProperties): TelemetryProperties {
        return {
            ...this.metadata,
            ...(this.userId ? { userId: this.userId } : {}),
            ...this.activeOrg,
            ...(attributes ?? {}),
        }
    }
}
