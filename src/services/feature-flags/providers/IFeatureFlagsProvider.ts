/**
 * Interface for experimental feature flag providers.
 *
 * Resolution is local, so the contract is synchronous: the callers that read a
 * switch sit on hot paths and cannot await. The previous asynchronous shape
 * existed for the remote flag service, which has been removed.
 */

/**
 * Feature flags settings that control how feature flags are retrieved
 */
export interface FeatureFlagsSettings {
    /** Whether feature flags are enabled */
    enabled: boolean
    /** Optional timeout for feature flag requests */
    timeout?: number
}

type JsonType =
    | string
    | number
    | boolean
    | null
    | {
          [key: string]: JsonType
      }
    | Array<JsonType>
    | JsonType[]
export type FeatureFlagPayload = string | number | boolean | { [key: string]: JsonType } | JsonType[] | null

export interface IFeatureFlagsProvider {
    /**
     * Resolve the requested switches.
     *
     * A switch the provider has no opinion on must be omitted rather than
     * reported as `false`, so the caller can fall back to its default.
     */
    resolveFlags(flagKeys: readonly string[]): Record<string, FeatureFlagPayload>

    /**
     * Check if the provider is enabled and ready
     * @returns Boolean indicating whether the provider is enabled
     */
    isEnabled(): boolean

    /**
     * Get current feature flags settings
     * @returns Current feature flags settings
     */
    getSettings(): FeatureFlagsSettings

    /**
     * Clean up resources when the provider is disposed
     */
    dispose(): Promise<void>
}
