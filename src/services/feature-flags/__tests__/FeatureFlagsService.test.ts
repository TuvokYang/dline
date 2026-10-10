import { describe, expect, it, vi } from "vitest"
import { ExperimentalFeatureFlag } from "@/shared/services/feature-flags/feature-flags"
import { FeatureFlagsService } from "../FeatureFlagsService"
import type { FeatureFlagPayload, IFeatureFlagsProvider } from "../providers/IFeatureFlagsProvider"
import { LocalFeatureFlagsProvider } from "../providers/LocalFeatureFlagsProvider"

function providerReturning(flags: Record<string, FeatureFlagPayload>): IFeatureFlagsProvider {
    return {
        resolveFlags: () => flags,
        isEnabled: () => true,
        getSettings: () => ({ enabled: true }),
        dispose: async () => {},
    }
}

describe("FeatureFlagsService", () => {
    it("resolves on read without any prior poll", () => {
        // The switches used to resolve only on the sign-in path, which left them
        // at their defaults for anyone not signed in.
        const service = new FeatureFlagsService(new LocalFeatureFlagsProvider({ IS_DEV: "true" }))

        expect(service.getWebtoolsEnabled()).toBe(true)
        expect(service.getWorktreesEnabled()).toBe(true)
    })

    it("keeps every switch at its default when the provider has no opinion", () => {
        const service = new FeatureFlagsService(providerReturning({}))

        expect(service.getBooleanFlagEnabled(ExperimentalFeatureFlag.WEBTOOLS)).toBe(false)
        expect(service.getFlagPayload(ExperimentalFeatureFlag.WEBTOOLS)).toBe(false)
    })

    it("falls back to defaults instead of propagating a provider failure", () => {
        const failing: IFeatureFlagsProvider = {
            resolveFlags: () => {
                throw new Error("resolution failed")
            },
            isEnabled: () => true,
            getSettings: () => ({ enabled: true }),
            dispose: async () => {},
        }
        const service = new FeatureFlagsService(failing)

        expect(() => service.getWebtoolsEnabled()).not.toThrow()
        expect(service.getWebtoolsEnabled()).toBe(false)
    })

    it("answers consistently within a session even if the environment changes", () => {
        const env: Record<string, string | undefined> = { DLINE_EXPERIMENTAL_WEBTOOLS: "true" }
        const service = new FeatureFlagsService(new LocalFeatureFlagsProvider(env))

        expect(service.getWebtoolsEnabled()).toBe(true)
        env.DLINE_EXPERIMENTAL_WEBTOOLS = "false"

        // A capability must not turn off underneath a caller mid-session.
        expect(service.getWebtoolsEnabled()).toBe(true)
    })

    it("picks up an environment change after refresh()", () => {
        const env: Record<string, string | undefined> = { DLINE_EXPERIMENTAL_WEBTOOLS: "true" }
        const service = new FeatureFlagsService(new LocalFeatureFlagsProvider(env))
        expect(service.getWebtoolsEnabled()).toBe(true)

        env.DLINE_EXPERIMENTAL_WEBTOOLS = "false"
        service.refresh()

        expect(service.getWebtoolsEnabled()).toBe(false)
    })

    it("resolves once per session rather than on every read", () => {
        const resolveFlags = vi.fn().mockReturnValue({})
        const service = new FeatureFlagsService({
            resolveFlags,
            isEnabled: () => true,
            getSettings: () => ({ enabled: true }),
            dispose: async () => {},
        })

        service.getWebtoolsEnabled()
        service.getWorktreesEnabled()

        expect(resolveFlags).toHaveBeenCalledTimes(1)
    })
})

describe("LocalFeatureFlagsProvider", () => {
    it("answers only the requested switches", () => {
        const provider = new LocalFeatureFlagsProvider({ IS_DEV: "true" })

        expect(provider.resolveFlags([ExperimentalFeatureFlag.WEBTOOLS])).toEqual({
            [ExperimentalFeatureFlag.WEBTOOLS]: true,
        })
    })

    it("makes no network request, so it reports no timeout", () => {
        expect(new LocalFeatureFlagsProvider({}).getSettings()).toEqual({ enabled: true })
    })
})
