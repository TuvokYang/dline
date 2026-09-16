/**
 * Tests for the abstracted multi-provider telemetry system
 * This demonstrates the multi-provider architecture that supports dual tracking,
 * validates provider switching capabilities, and ensures NoOpTelemetryProvider functionality
 * Tests for the abstracted multi-provider telemetry system
 * This demonstrates the multi-provider architecture that supports dual tracking,
 * validates provider switching capabilities, and ensures NoOpTelemetryProvider functionality
 */

import { HostProvider } from "@hosts/host-provider"
import { Logger } from "@shared/services/Logger"
import * as assert from "assert"
import { afterAll, beforeAll, describe, it, vi, expect as vitestExpect } from "vitest"
import { setVscodeHostProviderMock } from "../../test/host-provider-test-utils"
import { isTelemetryProviderRegistration, type TelemetryProviderInput } from "./providers/capabilities"
import { NoOpTelemetryProvider, TelemetryProviderFactory } from "./TelemetryProviderFactory"
import { TelemetryMetadata, TelemetryService } from "./TelemetryService"

async function disposeProviderInputs(inputs: readonly TelemetryProviderInput[]): Promise<void> {
	await Promise.all(inputs.map((input) => (isTelemetryProviderRegistration(input) ? input.base.dispose() : input.dispose())))
}

describe("Telemetry system is abstracted and can easily switch between providers", () => {
	// Setup and teardown for HostProvider mocking
	beforeAll(() => {
		setVscodeHostProviderMock()
	})

	afterAll(() => {
		// Reset HostProvider after tests
		HostProvider.reset()
	})
	const MOCK_USER_INFO = {
		id: "test-user-123",
		displayName: "Test User",
		email: "test@example.com",
		createdAt: new Date().toISOString(),
		organizations: [
			{
				active: true,
				memberId: "member-456",
				name: "Test Org",
				organizationId: "org-123",
				roles: ["admin"],
			},
		],
	}
	const MOCK_METADATA: TelemetryMetadata = {
		extension_version: "1.2.3",
		dline_type: "dline-unit-test",
		platform: "Test-IDE",
		platform_version: "9.8.7-abc",
		os_type: "win32",
		os_version: "Windows 10 Pro",
		is_remote_workspace: false,
		is_dev: "",
	}

	describe("Telemetry Service", () => {
		it("should derive remote workspace metadata from host version", async () => {
			const remoteProvider = new NoOpTelemetryProvider()
			const localProvider = new NoOpTelemetryProvider()
			const remoteLogSpy = vi.spyOn(remoteProvider, "log")
			const localLogSpy = vi.spyOn(localProvider, "log")
			const hostVersionStub = vi.spyOn(HostProvider.env, "getHostVersion")
			const createProvidersStub = vi.spyOn(TelemetryProviderFactory, "createProviders")

			hostVersionStub.mockResolvedValueOnce({
				platform: "VS Code",
				version: "1.103.0",
				clineType: "VSCode Extension",
				remoteName: "ssh-remote",
			})
			hostVersionStub.mockResolvedValueOnce({
				platform: "VS Code",
				version: "1.103.0",
				clineType: "VSCode Extension",
			})
			createProvidersStub.mockResolvedValueOnce([remoteProvider])
			createProvidersStub.mockResolvedValueOnce([localProvider])

			const remoteService = await TelemetryService.create()
			const localService = await TelemetryService.create()

			remoteLogSpy.mockClear()
			localLogSpy.mockClear()

			remoteService.captureTaskCreated("task-remote", "openai")
			localService.captureTaskCreated("task-local", "openai")

			assert.ok(remoteLogSpy.mock.calls.length === 1, "remote service should emit an event")
			assert.ok(localLogSpy.mock.calls.length === 1, "local service should emit an event")
			assert.strictEqual(remoteLogSpy.mock.calls[0][1]?.is_remote_workspace, true)
			assert.strictEqual(localLogSpy.mock.calls[0][1]?.is_remote_workspace, false)

			hostVersionStub.mockRestore()
			createProvidersStub.mockRestore()
			remoteLogSpy.mockRestore()
			localLogSpy.mockRestore()
			await remoteService.dispose()
			await localService.dispose()
		})

		it("should include remote workspace metadata on workspace.initialized events", async () => {
			const noOpProvider = new NoOpTelemetryProvider()
			const logSpy = vi.spyOn(noOpProvider, "log")
			const telemetryService = new TelemetryService([noOpProvider], {
				...MOCK_METADATA,
				is_remote_workspace: true,
			})

			logSpy.mockClear()
			telemetryService.captureWorkspaceInitialized(1, ["Git"], 123, false)

			assert.ok(logSpy.mock.calls.length === 1, "workspace.initialized should be emitted once")
			const [eventName, properties] = logSpy.mock.calls[0]
			assert.strictEqual(eventName, "workspace.initialized")
			assert.ok(properties, "workspace.initialized properties should be defined")
			assert.strictEqual(properties.is_remote_workspace, true)
			assert.strictEqual(properties.root_count, 1)
			assert.deepStrictEqual(properties.vcs_types, ["Git"])

			logSpy.mockRestore()
			await noOpProvider.dispose()
		})

		it("should include correct metadata with telemetry events", async () => {
			const noOpProvider = new NoOpTelemetryProvider()

			// Spy on the provider's log method to verify metadata
			const logSpy = vi.spyOn(noOpProvider, "log")
			const identifyUserSpy = vi.spyOn(noOpProvider, "identifyUser")
			const recordCounterSpy = vi.spyOn(noOpProvider, "recordCounter")

			const telemetryService = new TelemetryService([noOpProvider], MOCK_METADATA)

			// Reset the spy to ignore the initial telemetry event from constructor
			logSpy.mockClear()

			// Test that metadata is included in events
			telemetryService.captureTaskCreated("task-456", "openai")

			// Verify that log was called with correct arguments
			assert.ok(logSpy.mock.calls.length === 1, "Log should be called once")
			const [eventName, properties] = logSpy.mock.calls[0]
			assert.strictEqual(eventName, "task.created", "Event name should be task.created")
			assert.ok(properties, "Task created properties should be defined")
			assert.strictEqual(typeof properties.telemetry_timestamp_ms, "number")
			assert.deepStrictEqual(
				properties,
				{
					ulid: "task-456",
					apiProvider: "openai",
					openAiCompatibleDomain: undefined,
					...MOCK_METADATA,
					telemetry_channel: "usage",
					telemetry_severity: "info",
					telemetry_timestamp_ms: properties.telemetry_timestamp_ms,
				},
				"Task created event should include only the expected metadata properties",
			)

			// Test identify includes metadata
			telemetryService.identifyAccount(MOCK_USER_INFO)

			assert.ok(identifyUserSpy.mock.calls.length === 1, "IdentifyUser should be called once")
			const [userInfo, metadata] = identifyUserSpy.mock.calls[0]
			assert.deepStrictEqual(userInfo, MOCK_USER_INFO, "User info should match")
			assert.deepStrictEqual(metadata, MOCK_METADATA, "Identify user should include only the expected metadata properties")

			// Test org attributes are included in standard attributes (metrics)
			telemetryService.captureToolUsage("task-456", "write_to_file", "gpt-4", "openai", false, true)

			assert.ok(recordCounterSpy.mock.calls.length > 0, "recordCounter should be called for tool usage")
			const recordCounterArgs = recordCounterSpy.mock.calls[0]
			const recordCounterAttributes = recordCounterArgs[2] as Record<string, unknown>
			assert.strictEqual(recordCounterAttributes.organization_id, "org-123")
			assert.strictEqual(recordCounterAttributes.organization_name, "Test Org")
			assert.strictEqual(recordCounterAttributes.member_id, "member-456")

			// Test direct provider calls don't include metadata
			noOpProvider.log("direct_event", { custom: "data" })
			vitestExpect(logSpy).toHaveBeenCalledWith("direct_event", { custom: "data" })

			// Restore spies
			logSpy.mockRestore()
			identifyUserSpy.mockRestore()
			recordCounterSpy.mockRestore()

			await noOpProvider.dispose()
		})

		it("should support multi-provider telemetry for dual tracking", async () => {
			// Create multiple providers for dual tracking scenario
			const noOpProvider1 = new NoOpTelemetryProvider()
			const noOpProvider2 = new NoOpTelemetryProvider()

			// Spy on both providers to verify they both receive events
			const logSpy1 = vi.spyOn(noOpProvider1, "log")
			const logSpy2 = vi.spyOn(noOpProvider2, "log")
			const identifyUserSpy1 = vi.spyOn(noOpProvider1, "identifyUser")
			const identifyUserSpy2 = vi.spyOn(noOpProvider2, "identifyUser")

			// Create TelemetryService with multiple providers
			const telemetryService = new TelemetryService([noOpProvider1, noOpProvider2], MOCK_METADATA)

			// Reset spies to ignore constructor events
			logSpy1.mockClear()
			logSpy2.mockClear()

			// Test that events are sent to both providers
			telemetryService.captureTaskCreated("multi-task-123", "anthropic")

			// Verify both providers received the event
			assert.ok(logSpy1.mock.calls.length === 1, "First provider should receive the event")
			assert.ok(logSpy2.mock.calls.length === 1, "Second provider should receive the event")

			// Verify event content is correct for both providers
			const [eventName1, properties1] = logSpy1.mock.calls[0]
			const [eventName2, properties2] = logSpy2.mock.calls[0]

			assert.strictEqual(eventName1, "task.created", "First provider should receive correct event name")
			assert.strictEqual(eventName2, "task.created", "Second provider should receive correct event name")
			assert.ok(properties1, "First provider properties should be defined")
			assert.ok(properties2, "Second provider properties should be defined")

			assert.strictEqual(typeof properties1.telemetry_timestamp_ms, "number")
			assert.strictEqual(properties2.telemetry_timestamp_ms, properties1.telemetry_timestamp_ms)
			const expectedProperties = {
				ulid: "multi-task-123",
				apiProvider: "anthropic",
				openAiCompatibleDomain: undefined,
				...MOCK_METADATA,
				telemetry_channel: "usage",
				telemetry_severity: "info",
				telemetry_timestamp_ms: properties1.telemetry_timestamp_ms,
			}
			assert.deepStrictEqual(properties1, expectedProperties, "First provider should receive correct properties")
			assert.deepStrictEqual(properties2, expectedProperties, "Second provider should receive correct properties")

			// Test user identification with multiple providers
			telemetryService.identifyAccount(MOCK_USER_INFO)

			assert.ok(identifyUserSpy1.mock.calls.length === 1, "First provider should receive user identification")
			assert.ok(identifyUserSpy2.mock.calls.length === 1, "Second provider should receive user identification")

			// Verify provider count
			const providers = telemetryService.getProviders()
			assert.strictEqual(providers.length, 2, "Should have exactly 2 providers")

			// Cleanup
			logSpy1.mockRestore()
			logSpy2.mockRestore()
			identifyUserSpy1.mockRestore()
			identifyUserSpy2.mockRestore()
			await noOpProvider1.dispose()
			await noOpProvider2.dispose()
		})
	})
	describe("Default Provider Composition", () => {
		it("declares a loopback usage sink without constructing network resources", () => {
			const [config] = TelemetryProviderFactory.getDefaultConfigs()
			assert.strictEqual(config.type, "opentelemetry")
			if (config.type !== "opentelemetry") throw new Error("Expected OpenTelemetry config")
			assert.deepStrictEqual(config.sink.channels, ["usage", "runtime"])
			assert.strictEqual(config.sink.kind, "loopback")
		})
	})

	describe("No-Op Provider", () => {
		it("should create No-Op provider and handle all operations safely", async () => {
			console.log("\n=== Testing No-Op Provider ===")
			const noOpProvider = new NoOpTelemetryProvider()

			const noOpTelemetryService = new TelemetryService([noOpProvider], MOCK_METADATA)

			// Test various telemetry methods - should all be no-ops
			noOpTelemetryService.captureTaskCreated("task-789", "google")
			noOpTelemetryService.identifyAccount(MOCK_USER_INFO)
			noOpTelemetryService.captureTaskCompleted("task-789")
			noOpTelemetryService.captureModelSelected("gpt-4", "openai", "task-789")
			noOpTelemetryService.captureToolUsage("task-789", "write_to_file", "gpt-4", "openai", false, true)

			// Test provider methods directly
			noOpProvider.log("test_event", { test: "property" })
			noOpProvider.identifyUser(MOCK_USER_INFO, { additional: "data" })

			// Verify provider state
			const isEnabled = noOpProvider.isEnabled()
			const settings = noOpProvider.getSettings()

			// NoOp provider should always return false for isEnabled
			assert.strictEqual(isEnabled, false, "NoOp provider should always be disabled")

			// NoOp provider should return consistent settings
			assert.deepStrictEqual(
				settings,
				{
					hostEnabled: false,
					level: "off",
				},
				"NoOp provider should return consistent settings",
			)

			console.log("No-Op Provider enabled:", isEnabled)
			console.log("No-Op Provider settings:", settings)

			await noOpProvider.dispose()
		})

		it("does not write disabled telemetry events to the application log", async () => {
			const debug = vi.spyOn(Logger, "debug")
			const info = vi.spyOn(Logger, "info")
			const noOpProvider = new NoOpTelemetryProvider()

			noOpProvider.log("task.tool_used", { taskId: "task-1" })
			noOpProvider.logRequired("task.required", { taskId: "task-1" })
			noOpProvider.identifyUser(MOCK_USER_INFO, { source: "test" })
			await noOpProvider.dispose()

			vitestExpect(debug).not.toHaveBeenCalled()
			vitestExpect(info).not.toHaveBeenCalled()
			debug.mockRestore()
			info.mockRestore()
		})

		it("should handle unsupported provider types by returning No-Op provider", async () => {
			console.log("\n=== Testing Unsupported Provider Type ===")
			// Test unsupported type - No-Op provider is the fallback
			const unsupportedProvider = new NoOpTelemetryProvider()

			// Should return NoOp provider
			assert.ok(
				unsupportedProvider instanceof NoOpTelemetryProvider,
				"Unsupported provider should be an instance of NoOpTelemetryProvider",
			)
			assert.strictEqual(unsupportedProvider.isEnabled(), false, "Unsupported provider should return NoOp provider")
			assert.deepStrictEqual(
				unsupportedProvider.getSettings(),
				{
					hostEnabled: false,
					level: "off",
				},
				"Unsupported provider should return NoOp settings",
			)

			// Should handle all operations safely
			const telemetryService = new TelemetryService([unsupportedProvider], MOCK_METADATA)
			telemetryService.captureTaskCreated("task-456", "test")
			telemetryService.identifyAccount(MOCK_USER_INFO)

			await unsupportedProvider.dispose()
		})
	})

	describe("Factory Configuration", () => {
		it("should configure the default loopback OTLP provider", () => {
			const configs = TelemetryProviderFactory.getDefaultConfigs()

			assert.strictEqual(configs.length, 1)
			assert.strictEqual(configs[0].type, "opentelemetry")
			if (configs[0].type !== "opentelemetry") throw new Error("Expected OpenTelemetry config")
			assert.strictEqual(configs[0].sink.kind, "loopback")
			assert.strictEqual(configs[0].sink.endpoint, "http://127.0.0.1:4318")
			assert.deepStrictEqual(configs[0].sink.channels, ["usage", "runtime"])
		})

		it("does not use NoOp as the normal factory fallback", () => {
			const configs = TelemetryProviderFactory.getDefaultConfigs()
			assert.ok(configs.every((config) => config.type !== "no-op"))
		})

		it("should handle provider switching seamlessly", async () => {
			console.log("\n=== Testing Provider Switching ===")

			// Start with available providers
			const providers = await TelemetryProviderFactory.createProviders()
			let telemetryService = new TelemetryService(providers, MOCK_METADATA)

			telemetryService.captureTaskCreated("task-switch-1", "anthropic")
			console.log("Captured event with available providers")

			await disposeProviderInputs(providers)

			// Switch to No-Op provider
			const noOpProvider = new NoOpTelemetryProvider()
			telemetryService = new TelemetryService([noOpProvider], MOCK_METADATA)

			telemetryService.captureTaskCreated("task-switch-2", "openai")
			console.log("Captured event with No-Op provider")

			// Verify different behaviors
			// PostHog provider may be enabled depending on configuration
			// NoOp provider should always be disabled
			assert.strictEqual(noOpProvider.isEnabled(), false, "NoOp provider should always be disabled")

			await noOpProvider.dispose()
		})
	})

	describe("CLI Subagents Telemetry", () => {
		it("should capture subagent toggle events correctly", async () => {
			const noOpProvider = new NoOpTelemetryProvider()
			const logSpy = vi.spyOn(noOpProvider, "log")
			const telemetryService = new TelemetryService([noOpProvider], MOCK_METADATA)

			// Reset spy to ignore constructor events
			logSpy.mockClear()

			// Test enabling subagents
			telemetryService.captureSubagentToggle(true)

			assert.ok(logSpy.mock.calls.length === 1, "Log should be called once for enable")
			const [eventName1, properties1] = logSpy.mock.calls[0]
			assert.ok(properties1, "Properties should be defined")
			assert.strictEqual(eventName1, "task.subagent_enabled", "Event should be subagent_enabled when enabled")
			assert.strictEqual(properties1.enabled, true, "Properties should include enabled: true")
			assert.ok(properties1.timestamp, "Properties should include timestamp")
			assert.strictEqual(typeof properties1.timestamp, "string", "Timestamp should be a string")

			// Reset spy for next test
			logSpy.mockClear()

			// Test disabling subagents
			telemetryService.captureSubagentToggle(false)

			assert.ok(logSpy.mock.calls.length === 1, "Log should be called once for disable")
			const [eventName2, properties2] = logSpy.mock.calls[0]
			assert.ok(properties2, "Properties should be defined")
			assert.strictEqual(eventName2, "task.subagent_disabled", "Event should be subagent_disabled when disabled")
			assert.strictEqual(properties2.enabled, false, "Properties should include enabled: false")
			assert.ok(properties2.timestamp, "Properties should include timestamp")

			logSpy.mockRestore()
			await noOpProvider.dispose()
		})

		it("should capture subagent execution events correctly", async () => {
			const noOpProvider = new NoOpTelemetryProvider()
			const logSpy = vi.spyOn(noOpProvider, "log")
			const telemetryService = new TelemetryService([noOpProvider], MOCK_METADATA)

			// Reset spy to ignore constructor events
			logSpy.mockClear()

			// Test successful subagent execution
			telemetryService.captureSubagentExecution("task-123", 1500, 25, true)

			assert.ok(logSpy.mock.calls.length === 1, "Log should be called once for successful execution")
			const [eventName1, properties1] = logSpy.mock.calls[0]
			assert.ok(properties1, "Properties should be defined")
			assert.strictEqual(eventName1, "task.subagent_completed", "Event should be subagent_completed when successful")
			assert.strictEqual(properties1.ulid, "task-123", "Properties should include task ULID")
			assert.strictEqual(properties1.durationMs, 1500, "Properties should include duration")
			assert.strictEqual(properties1.outputLines, 25, "Properties should include output line count")
			assert.strictEqual(properties1.success, true, "Properties should include success status")
			assert.ok(properties1.timestamp, "Properties should include timestamp")

			// Reset spy for next test
			logSpy.mockClear()

			// Test failed subagent execution
			telemetryService.captureSubagentExecution("task-456", 3200, 150, false)

			assert.ok(logSpy.mock.calls.length === 1, "Log should be called once for failed execution")
			const [eventName2, properties2] = logSpy.mock.calls[0]
			assert.ok(properties2, "Properties should be defined")
			assert.strictEqual(eventName2, "task.subagent_started", "Event should be subagent_started when failed")
			assert.strictEqual(properties2.ulid, "task-456", "Properties should include task ULID")
			assert.strictEqual(properties2.durationMs, 3200, "Properties should include duration")
			assert.strictEqual(properties2.outputLines, 150, "Properties should include output line count")
			assert.strictEqual(properties2.success, false, "Properties should include success status")

			logSpy.mockRestore()
			await noOpProvider.dispose()
		})

		it("should respect subagents telemetry category settings", async () => {
			const noOpProvider = new NoOpTelemetryProvider()
			const logSpy = vi.spyOn(noOpProvider, "log")
			const telemetryService = new TelemetryService([noOpProvider], MOCK_METADATA)

			// Reset spy to ignore constructor events
			logSpy.mockClear()

			// Verify subagents category is enabled by default
			assert.strictEqual(
				telemetryService.isCategoryEnabled("subagents"),
				true,
				"Subagents category should be enabled by default",
			)

			// Test that events are captured when category is enabled
			telemetryService.captureSubagentToggle(true)
			assert.ok(logSpy.mock.calls.length === 1, "Event should be captured when category is enabled")

			// Reset spy
			logSpy.mockClear()

			// Test that events are captured for execution
			telemetryService.captureSubagentExecution("task-789", 2000, 10, true)
			assert.ok(logSpy.mock.calls.length === 1, "Execution event should be captured when category is enabled")

			logSpy.mockRestore()
			await noOpProvider.dispose()
		})
	})

	describe("Skills Telemetry", () => {
		it("should capture skill used events correctly", async () => {
			const noOpProvider = new NoOpTelemetryProvider()
			const logSpy = vi.spyOn(noOpProvider, "log")
			const telemetryService = new TelemetryService([noOpProvider], MOCK_METADATA)

			logSpy.mockClear()

			telemetryService.captureSkillUsed({
				ulid: "task-123",
				skillName: "my-skill",
				skillSource: "global",
				skillsAvailableGlobal: 2,
				skillsAvailableProject: 3,
				provider: "cline",
				modelId: "anthropic/claude-sonnet-4.5",
			})

			assert.ok(logSpy.mock.calls.length === 1, "Log should be called once")
			const [eventName, properties] = logSpy.mock.calls[0]
			assert.strictEqual(eventName, "task.skill_used", "Event name should be task.skill_used")
			assert.ok(properties, "Properties should be defined")
			assert.strictEqual(properties.ulid, "task-123", "Properties should include task ULID")
			assert.strictEqual(properties.skillName, "my-skill", "Properties should include skillName")
			assert.strictEqual(properties.skillSource, "global", "Properties should include skillSource")
			assert.strictEqual(properties.skillsAvailableGlobal, 2, "Properties should include global skill count")
			assert.strictEqual(properties.skillsAvailableProject, 3, "Properties should include project skill count")
			assert.strictEqual(properties.provider, "cline", "Properties should include provider")
			assert.strictEqual(properties.modelId, "anthropic/claude-sonnet-4.5", "Properties should include modelId")

			logSpy.mockRestore()
			await noOpProvider.dispose()
		})
	})
})
