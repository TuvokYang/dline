/**
 * Tests for selfHosted mode behavior across PostHog-based services.
 * When ClineEndpoint.isSelfHosted() returns true, all PostHog functionality should be disabled.
 */

import * as assert from "assert"
import { afterEach, describe, it, vi } from "vitest"

// sinon import removed

// Mock the missing generated module to prevent import chain failure
vi.mock("@generated/hosts/vscode/protobus-services", () => ({
    serviceHandlers: {},
}))

import { ClineEndpoint } from "@/config"
import { Logger } from "@/shared/services/Logger"
import { ErrorProviderFactory } from "../error/ErrorProviderFactory"
import { FeatureFlagsProviderFactory } from "../feature-flags/FeatureFlagsProviderFactory"

describe("SelfHosted Mode - PostHog Disabling", () => {
    let isSelfHostedStub: any /* sinon.SinonStub → vitest */

    afterEach(() => {
        if (isSelfHostedStub) {
            isSelfHostedStub.mockRestore()
        }
    })

    describe("FeatureFlagsProviderFactory", () => {
        // Experimental switches are resolved locally, so self-hosted mode has
        // nothing to disable: there is no request to suppress either way.
        it("should resolve locally regardless of selfHosted mode", () => {
            isSelfHostedStub = vi.spyOn(ClineEndpoint, "isSelfHosted").mockReturnValue(true)
            assert.strictEqual(FeatureFlagsProviderFactory.getDefaultConfig().type, "local")

            isSelfHostedStub.mockReturnValue(false)
            assert.strictEqual(FeatureFlagsProviderFactory.getDefaultConfig().type, "local")
        })

        it("should create a provider that reports as enabled", () => {
            const config = FeatureFlagsProviderFactory.getDefaultConfig()
            const provider = FeatureFlagsProviderFactory.createProvider(config)

            assert.strictEqual(provider.isEnabled(), true)
        })
    })

    describe("ErrorProviderFactory", () => {
        it("should return no-op config when in selfHosted mode", () => {
            isSelfHostedStub = vi.spyOn(ClineEndpoint, "isSelfHosted").mockReturnValue(true)

            const config = ErrorProviderFactory.getDefaultConfig()

            assert.strictEqual(config.type, "no-op", "Should return no-op type in selfHosted mode")
        })

        it("should keep the compatibility provider local when NOT in selfHosted mode", () => {
            isSelfHostedStub = vi.spyOn(ClineEndpoint, "isSelfHosted").mockReturnValue(false)

            const config = ErrorProviderFactory.getDefaultConfig()

            assert.strictEqual(config.type, "no-op", "Remote error sinks must be registered through TelemetryService")
        })

        it("should create a disabled provider with zero logging side effects", async () => {
            isSelfHostedStub = vi.spyOn(ClineEndpoint, "isSelfHosted").mockReturnValue(true)
            const messages: string[] = []
            const unsubscribe = Logger.subscribe((message) => messages.push(message))

            const config = ErrorProviderFactory.getDefaultConfig()
            const provider = await ErrorProviderFactory.createProvider(config)
            const error = new Error("no-op-canary")
            await provider.captureException(error, { canary: "must-not-log" })
            provider.logException(error, { canary: "must-not-log" })
            provider.logMessage("must-not-log", "error", { canary: "must-not-log" })
            await provider.dispose()
            unsubscribe()

            assert.strictEqual(provider.isEnabled(), false, "NoOp provider must report as disabled")
            assert.deepStrictEqual(provider.getSettings(), { enabled: false, hostEnabled: false, level: "off" })
            assert.deepStrictEqual(messages, [])
        })
    })

    describe("Integration - selfHosted should disable all PostHog services", () => {
        it("should return no-op for every PostHog-based factory when selfHosted", () => {
            isSelfHostedStub = vi.spyOn(ClineEndpoint, "isSelfHosted").mockReturnValue(true)

            // Feature flags are no longer PostHog-based, so they are not part of
            // this assertion: local resolution makes no request to suppress.
            assert.strictEqual(ErrorProviderFactory.getDefaultConfig().type, "no-op", "Error provider should be no-op")
        })
    })
})
