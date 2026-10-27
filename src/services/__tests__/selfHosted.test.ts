/**
 * Self-hosted mode must not change which local providers are used: feature
 * flags resolve locally and the error provider never reports anywhere.
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

describe("SelfHosted Mode - local providers", () => {
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
})
