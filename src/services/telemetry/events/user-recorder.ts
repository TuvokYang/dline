import type { ClineAccountUserInfo } from "@/services/auth/AuthService"
import { TELEMETRY_EVENTS, truncateErrorMessage } from "./catalog"
import { DomainRecorder } from "./domain-recorder"

/**
 * Account lifecycle, activation, and consent-transition events.
 *
 * Opt-out is the one event that must survive the setting it reports: it is
 * emitted as required so it leaves before reporting stops, otherwise the
 * transition would be the only user action telemetry cannot observe.
 */
export class UserEventRecorder extends DomainRecorder {
    /** Emitted once per session to mark that reporting is active. */
    captureTelemetryEnabled(): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.USER.TELEMETRY_ENABLED)
    }

    /**
     * Captures when a user explicitly opts out of telemetry.
     * Uses a required event so it is sent before telemetry is disabled.
     * Should only be called on explicit user action, not on init/sync.
     */
    captureUserOptOut(): void {
        this.sink.captureRequiredEvent(TELEMETRY_EVENTS.USER.OPT_OUT, {})
    }

    /**
     * Captures when a user explicitly opts back into telemetry.
     * Should only be called on explicit user action, not on init/sync.
     */
    captureUserOptIn(): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.USER.OPT_IN)
    }

    captureExtensionActivated(): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.USER.EXTENSION_ACTIVATED)
    }

    captureExtensionStorageError(errorMessage: string, eventName: string): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.USER.EXTENSION_STORAGE_ERROR, {
            error: truncateErrorMessage(errorMessage),
            eventName,
        })
    }

    /**
     * Records when authentication flow is started
     * @param provider The authentication provider being used
     */
    captureAuthStarted(provider?: string): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.USER.AUTH_STARTED, { provider })
    }

    /**
     * Records when authentication flow succeeds
     * @param provider The authentication provider that was used
     */
    captureAuthSucceeded(provider?: string): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.USER.AUTH_SUCCEEDED, { provider })
    }

    /**
     * Records when authentication flow fails
     * @param provider The authentication provider that was used
     */
    captureAuthFailed(provider?: string): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.USER.AUTH_FAILED, { provider })
    }

    /**
     * Records when user logs out of their account
     * @param provider The authentication provider that was used
     * @param reason The reason for logout (user action, cross-window sync, error, etc.)
     */
    captureAuthLoggedOut(provider?: string, reason?: string): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.USER.AUTH_LOGGED_OUT, { provider, reason })
    }

    /**
     * Identifies the account's user
     * @param userInfo The user's information
     */
    identifyAccount(userInfo: ClineAccountUserInfo): void {
        this.sink.identifyUser(userInfo)
    }

    captureOnboardingProgress(args: { step: number; action?: string; model?: string; completed?: boolean }): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.USER.ONBOARDING_PROGRESS, { ...args })
    }

    captureHostEvent(name: string, content: string): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.HOST.DETECTED, { name, content })
    }
}
