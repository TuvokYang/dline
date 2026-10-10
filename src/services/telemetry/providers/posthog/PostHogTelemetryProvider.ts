import { PostHog } from "posthog-node"
import { HostProvider } from "@/hosts/host-provider"
import { getErrorLevelFromString } from "@/services/error"
import { getDistinctId, setDistinctId } from "@/services/logging/distinctId"
import { fetch } from "@/shared/net"
import { Setting } from "@/shared/proto/dline/host"
import { Logger } from "@/shared/services/Logger"
import { posthogConfig } from "../../../../shared/services/config/posthog-config"
import type { ClineAccountUserInfo } from "../../../auth/AuthService"
import type { ITelemetryProvider, TelemetryProperties, TelemetrySettings } from "../ITelemetryProvider"
/**
 * PostHog implementation of the telemetry provider interface
 * Handles PostHog-specific analytics tracking
 */
export class PostHogTelemetryProvider implements ITelemetryProvider {
    private client: PostHog
    private telemetrySettings: TelemetrySettings
    private isSharedClient: boolean

    readonly name = "PostHogTelemetryProvider"

    constructor(sharedClient?: PostHog) {
        this.isSharedClient = !!sharedClient

        // Use shared PostHog client if provided, otherwise create a new one
        if (sharedClient) {
            this.client = sharedClient
        } else {
            // A key alone is not enough: without a configured host there is
            // nowhere to report to.
            const { apiKey, host } = posthogConfig
            if (!apiKey || !host) {
                throw new Error("A PostHog API key and host are required to create a new client")
            }
            this.client = new PostHog(apiKey, {
                host,
                fetch: (url, options) => fetch(url, options),
            })
        }

        // Initialize telemetry settings
        this.telemetrySettings = {
            hostEnabled: true,
            level: "all",
        }
    }
    public async initialize(): Promise<PostHogTelemetryProvider> {
        // Listen for host telemetry changes
        HostProvider.env.subscribeToTelemetrySettings(
            {},
            {
                onResponse: (event: { isEnabled: Setting }) => {
                    const hostEnabled = event.isEnabled === Setting.ENABLED || event.isEnabled === Setting.UNSUPPORTED
                    this.telemetrySettings.hostEnabled = hostEnabled
                },
            },
        )

        // Check host-specific telemetry setting (e.g. VS Code setting)
        const hostSettings = await HostProvider.env.getTelemetrySettings({})
        if (hostSettings.isEnabled === Setting.DISABLED) {
            this.telemetrySettings.hostEnabled = false
        }

        this.telemetrySettings.level = await this.getTelemetryLevel()
        return this
    }

    async forceFlush() {
        return this.client.flush()
    }

    public log(event: string, properties?: TelemetryProperties): void {
        if (!this.isEnabled() || this.telemetrySettings.level === "off") {
            return
        }

        // Host-level severity filtering is applied centrally by channel policy.
        this.client.capture({
            distinctId: getDistinctId(),
            event,
            properties,
        })
    }

    public logRequired(event: string, properties?: TelemetryProperties): void {
        if (!this.isEnabled()) return
        this.client.capture({
            distinctId: getDistinctId(),
            event,
            properties: {
                ...properties,
                _required: true, // Mark as required event
            },
        })
    }

    public identifyUser(userInfo: ClineAccountUserInfo, properties: TelemetryProperties = {}): void {
        const distinctId = getDistinctId()
        // Only identify user if telemetry is enabled and user ID is different than the currently set distinct ID
        if (this.isEnabled() && userInfo && userInfo?.id !== distinctId) {
            this.client.identify({
                distinctId: userInfo.id,
                properties: {
                    uuid: userInfo.id,
                    name: userInfo.displayName,
                    ...properties,
                    alias: distinctId,
                },
            })
            // Ensure distinct ID is updated so that we will not identify the user again
            setDistinctId(userInfo.id)
        }
    }

    public isEnabled(): boolean {
        return this.telemetrySettings.hostEnabled && this.telemetrySettings.level !== "off"
    }

    public getSettings(): TelemetrySettings {
        return { ...this.telemetrySettings }
    }

    /**
     * Record a counter metric by converting to equivalent PostHog event
     * This maintains backward compatibility with existing dashboards
     */
    public recordCounter(
        name: string,
        _value: number,
        _attributes?: TelemetryProperties,
        _description?: string,
        _required = false,
    ): void {
        if (!this.isEnabled()) return

        // Convert metric to event format for PostHog
        // Most counters don't need individual events - they're aggregated in OpenTelemetry
        // Only log significant counter events that have dashboard equivalents
        if (name === "dline.tokens.input.total" || name === "dline.tokens.output.total") {
            // These will be batched and emitted as a single "task.tokens" event
            // Implementation will be added when we update captureTokenUsage
        }
    }

    /**
     * Record a histogram metric by converting to equivalent PostHog event
     * Histograms track distributions, but PostHog events capture individual values
     */
    public recordHistogram(
        _name: string,
        _value: number,
        _attributes?: TelemetryProperties,
        _description?: string,
        _required = false,
    ): void {
        // Histograms are for distribution analysis in OpenTelemetry
        // PostHog gets the raw values through existing event capture methods
        // No action needed here - events already capture these values
    }

    /**
     * Record a gauge metric by converting to equivalent PostHog event
     * Gauges track current state, which we can log as state change events
     */
    public recordGauge(
        name: string,
        value: number | null,
        attributes?: TelemetryProperties,
        _description?: string,
        _required = false,
    ): void {
        if (!this.isEnabled() || value === null) return

        // Convert gauge updates to state change events
        if (name === "dline.workspace.active_roots") {
            this.log("workspace.roots_changed", {
                count: value,
                ...attributes,
            })
        }
    }

    public async dispose(): Promise<void> {
        // Only shut down the client if it's not shared (we own it)
        if (!this.isSharedClient) {
            try {
                await this.client.shutdown()
            } catch (error) {
                Logger.error("Error shutting down PostHog client:", error)
            }
        }
    }

    /**
     * Get the current telemetry level from VS Code settings
     */
    private async getTelemetryLevel(): Promise<TelemetrySettings["level"]> {
        const hostSettings = await HostProvider.env.getTelemetrySettings({})
        if (hostSettings.isEnabled === Setting.DISABLED) {
            return "off"
        }
        return getErrorLevelFromString(hostSettings.errorLevel)
    }
}
