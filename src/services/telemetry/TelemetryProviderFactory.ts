import { join } from "node:path"
import { getDlineDataDir } from "@/core/storage/disk"
import type { ClineAccountUserInfo } from "@/services/auth/AuthService"
import {
	createDefaultLoopbackOpenTelemetryConfig,
	DEFAULT_LOOPBACK_OTLP_ENDPOINT,
	type OpenTelemetryClientValidConfig,
} from "@/shared/services/config/otel-config"
import { Logger } from "@/shared/services/Logger"
import { isTelemetryDevelopmentMode } from "./development-mode"
import { createLocalJournalRegistration, getProcessTelemetrySessionId, LocalJournalProvider } from "./journal"
import type { TelemetryProviderInput, TelemetryProviderRegistration, TelemetrySinkDescriptor } from "./providers/capabilities"
import type { ITelemetryProvider, TelemetryProperties, TelemetrySettings } from "./providers/ITelemetryProvider"
import { adaptLegacyTelemetryProvider } from "./providers/LegacyTelemetryProviderAdapter"
import { OpenTelemetryClientProvider } from "./providers/opentelemetry/OpenTelemetryClientProvider"
import { OpenTelemetryTelemetryProvider } from "./providers/opentelemetry/OpenTelemetryTelemetryProvider"
import { OpenTelemetryTraceProvider } from "./providers/opentelemetry/OpenTelemetryTraceProvider"
import { PostHogClientProvider } from "./providers/posthog/PostHogClientProvider"
import { PostHogTelemetryProvider } from "./providers/posthog/PostHogTelemetryProvider"

/**
 * Supported telemetry provider types
 */
export type TelemetryProviderType = "posthog" | "no-op" | "opentelemetry"

/**
 * Configuration for telemetry providers
 */
export type TelemetryProviderConfig =
	| { type: "posthog"; apiKey?: string; host?: string }
	| {
			type: "opentelemetry"
			config: OpenTelemetryClientValidConfig
			name?: string
			sink: TelemetrySinkDescriptor
	  }
	/** Retained only for explicit tests; disabled production is an empty registry. */
	| { type: "no-op" }

/**
 * Factory class for creating telemetry providers
 * Allows easy switching between different analytics providers
 */
export class TelemetryProviderFactory {
	/**
	 * Creates multiple telemetry providers based on configuration
	 * Supports dual tracking during transition period
	 */
	public static async createProviders(): Promise<TelemetryProviderInput[]> {
		const configs = TelemetryProviderFactory.getDefaultConfigs()
		const providers: TelemetryProviderRegistration[] = []

		try {
			const journal = await LocalJournalProvider.create({
				directory: join(getDlineDataDir(), "telemetry", "sessions"),
				sessionId: getProcessTelemetrySessionId(),
			})
			providers.push(createLocalJournalRegistration(journal))
		} catch (error) {
			Logger.internalError("TelemetryProviderFactory: Local journal provider could not be created", error)
		}

		for (const config of configs) {
			try {
				const provider = await TelemetryProviderFactory.createProvider(config)
				if (provider) providers.push(provider)
			} catch (error) {
				Logger.internalError(`Failed to create telemetry provider: ${config.type}`, error)
			}
		}

		Logger.info(
			providers.length > 0
				? `TelemetryProviderFactory: Created providers - ${providers.map((entry) => entry.base.name).join(", ")}`
				: "TelemetryProviderFactory: No telemetry providers configured",
		)
		return providers
	}

	/**
	 * Creates a single telemetry provider based on the provided configuration
	 * @param config Configuration for the telemetry provider
	 * @returns ITelemetryProvider instance
	 */
	private static async createProvider(config: TelemetryProviderConfig): Promise<TelemetryProviderRegistration | null> {
		switch (config.type) {
			case "posthog": {
				const sharedClient = PostHogClientProvider.getClient()
				if (!sharedClient) return null
				const provider = await new PostHogTelemetryProvider(sharedClient).initialize()
				return adaptLegacyTelemetryProvider(provider, {
					sink: { kind: "remote", origin: "user", channels: ["usage"] },
				})
			}
			case "opentelemetry": {
				const client = new OpenTelemetryClientProvider(config.config)
				if (!client.meterProvider && !client.loggerProvider) {
					await client.dispose()
					Logger.warn("TelemetryProviderFactory: OpenTelemetry exporters were not created")
					return null
				}
				const traceProvider = new OpenTelemetryTraceProvider(config.config.otlpEndpoint ?? DEFAULT_LOOPBACK_OTLP_ENDPOINT)
				const provider = await new OpenTelemetryTelemetryProvider(client.meterProvider, client.loggerProvider, {
					name: config.name,
					owner: client,
					traceProvider,
				}).initialize()
				const registration = adaptLegacyTelemetryProvider(provider, { sink: config.sink })
				return { ...registration, capabilities: [...registration.capabilities, traceProvider] }
			}
			case "no-op":
				return adaptLegacyTelemetryProvider(new NoOpTelemetryProvider(), {
					sink: { kind: "test", origin: "test", channels: ["usage"] },
				})
			default: {
				const unhandled: never = config
				throw new Error(`Unsupported telemetry provider configuration: ${JSON.stringify(unhandled)}`)
			}
		}
	}

	/**
	 * Gets the default telemetry provider configuration
	 * @returns Default configuration using available providers
	 */
	public static getDefaultConfigs(): TelemetryProviderConfig[] {
		return [
			{
				type: "opentelemetry",
				name: "OpenTelemetryLoopbackProvider",
				config: createDefaultLoopbackOpenTelemetryConfig(),
				sink: {
					kind: "loopback",
					origin: "default",
					channels: ["usage", "runtime"],
					endpoint: DEFAULT_LOOPBACK_OTLP_ENDPOINT,
					enhancement: isTelemetryDevelopmentMode() ? "debug" : "standard",
				},
			},
		]
	}
}

/**
 * No-operation telemetry provider for when telemetry is disabled
 * or for testing purposes
 */
export class NoOpTelemetryProvider implements ITelemetryProvider {
	readonly name = "NoOpTelemetryProvider"

	log(_event: string, _properties?: TelemetryProperties): void {}
	logRequired(_event: string, _properties?: TelemetryProperties): void {}
	identifyUser(_userInfo: ClineAccountUserInfo, _properties?: TelemetryProperties): void {}
	isEnabled(): boolean {
		return false
	}
	getSettings(): TelemetrySettings {
		return {
			hostEnabled: false,
			level: "off",
		}
	}
	recordCounter(
		_name: string,
		_value: number,
		_attributes?: TelemetryProperties,
		_description?: string,
		_required = false,
	): void {
		// no-op
	}
	recordHistogram(
		_name: string,
		_value: number,
		_attributes?: TelemetryProperties,
		_description?: string,
		_required = false,
	): void {
		// no-op
	}
	recordGauge(
		_name: string,
		_value: number | null,
		_attributes?: TelemetryProperties,
		_description?: string,
		_required = false,
	): void {
		// no-op
	}

	async forceFlush() {}
	async dispose(): Promise<void> {}
}
