import { describe, expect, it, vi } from "vitest"
import { ExperimentalFeatureFlag, REMOTE_ROLLOUT_FEATURE_FLAGS } from "@/shared/services/feature-flags/feature-flags"
import { FeatureFlagsService } from "../FeatureFlagsService"
import type { FeatureFlagPayload, IFeatureFlagsProvider } from "../providers/IFeatureFlagsProvider"
import { LayeredFeatureFlagsProvider } from "../providers/LayeredFeatureFlagsProvider"
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

        expect(service.getWorktreesEnabled()).toBe(true)
        expect(service.getAccountEnabled()).toBe(true)
    })

    it("keeps every switch at its default when the provider has no opinion", () => {
        const service = new FeatureFlagsService(providerReturning({}))

        expect(service.getBooleanFlagEnabled(ExperimentalFeatureFlag.WORKTREES)).toBe(false)
        expect(service.getFlagPayload(ExperimentalFeatureFlag.WORKTREES)).toBe(false)
        expect(service.getExternalFileCheckpointsEnabled()).toBe(false)
    })

    it("allows the rollout provider to offer external file checkpoints", () => {
        expect(REMOTE_ROLLOUT_FEATURE_FLAGS).toContain(ExperimentalFeatureFlag.EXTERNAL_FILE_CHECKPOINTS)
        const service = new FeatureFlagsService(providerReturning({ "checkpoint-external-files": true }))

        expect(service.getExternalFileCheckpointsEnabled()).toBe(true)
    })

    it("keeps aggressive rendering off until the rollout offers it", () => {
        expect(new FeatureFlagsService(providerReturning({})).getAggressiveRenderingEnabled()).toBe(false)
        expect(REMOTE_ROLLOUT_FEATURE_FLAGS).toContain(ExperimentalFeatureFlag.AGGRESSIVE_RENDERING)

        const offered = new FeatureFlagsService(providerReturning({ aggressive_rendering: true }))
        expect(offered.getAggressiveRenderingEnabled()).toBe(true)
    })

    it("resolves the aggressive rendering switch from its environment override", () => {
        const enabled = new FeatureFlagsService(
            new LocalFeatureFlagsProvider({ DLINE_EXPERIMENTAL_AGGRESSIVE_RENDERING: "true" }),
        )
        const disabled = new FeatureFlagsService(new LocalFeatureFlagsProvider({}))

        expect(enabled.getAggressiveRenderingEnabled()).toBe(true)
        expect(disabled.getAggressiveRenderingEnabled()).toBe(false)
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

        expect(() => service.getWorktreesEnabled()).not.toThrow()
        expect(service.getWorktreesEnabled()).toBe(false)
    })

    it("answers consistently within a session even if the environment changes", () => {
        const env: Record<string, string | undefined> = { DLINE_EXPERIMENTAL_WORKTREE_EXP: "true" }
        const service = new FeatureFlagsService(new LocalFeatureFlagsProvider(env))

        expect(service.getWorktreesEnabled()).toBe(true)
        env.DLINE_EXPERIMENTAL_WORKTREE_EXP = "false"

        // A capability must not turn off underneath a caller mid-session.
        expect(service.getWorktreesEnabled()).toBe(true)
    })

    it("picks up an environment change after refresh()", () => {
        const env: Record<string, string | undefined> = { DLINE_EXPERIMENTAL_WORKTREE_EXP: "true" }
        const service = new FeatureFlagsService(new LocalFeatureFlagsProvider(env))
        expect(service.getWorktreesEnabled()).toBe(true)

        env.DLINE_EXPERIMENTAL_WORKTREE_EXP = "false"
        service.refresh()

        expect(service.getWorktreesEnabled()).toBe(false)
    })

    it("resolves once per session rather than on every read", () => {
        const resolveFlags = vi.fn().mockReturnValue({})
        const service = new FeatureFlagsService({
            resolveFlags,
            isEnabled: () => true,
            getSettings: () => ({ enabled: true }),
            dispose: async () => {},
        })

        service.getWorktreesEnabled()
        service.getAccountEnabled()

        expect(resolveFlags).toHaveBeenCalledTimes(1)
    })
})

describe("LocalFeatureFlagsProvider", () => {
    it("answers only the requested switches", () => {
        const provider = new LocalFeatureFlagsProvider({ IS_DEV: "true" })

        expect(provider.resolveFlags([ExperimentalFeatureFlag.WORKTREES])).toEqual({
            [ExperimentalFeatureFlag.WORKTREES]: true,
        })
    })

    it("makes no network request, so it reports no timeout", () => {
        expect(new LocalFeatureFlagsProvider({}).getSettings()).toEqual({ enabled: true })
    })

    it("leaves a switch no local source sets to the later layers", () => {
        expect(new LocalFeatureFlagsProvider({}, false).resolveFlags([ExperimentalFeatureFlag.ACCOUNT])).toEqual({})
        expect(new LocalFeatureFlagsProvider({}, true).resolveFlags([ExperimentalFeatureFlag.ACCOUNT])).toEqual({
            [ExperimentalFeatureFlag.ACCOUNT]: true,
        })
    })
})

describe("account rollout precedence", () => {
    function serviceWith(env: Record<string, string | undefined>, developmentBuild: boolean, remote: IFeatureFlagsProvider) {
        return new FeatureFlagsService(
            new LayeredFeatureFlagsProvider([new LocalFeatureFlagsProvider(env, developmentBuild), remote]),
        )
    }

    it("follows the rollout service in a release build", () => {
        expect(serviceWith({}, false, providerReturning({ account: true })).getAccountEnabled()).toBe(true)
        expect(serviceWith({}, false, providerReturning({ account: false })).getAccountEnabled()).toBe(false)
    })

    it("stays off when the service has no answer", () => {
        expect(serviceWith({}, false, providerReturning({})).getAccountEnabled()).toBe(false)
    })

    it("is on in a development build even when the service says no", () => {
        expect(serviceWith({}, true, providerReturning({ account: false })).getAccountEnabled()).toBe(true)
    })

    it("offers chat folding in a development build even when the service says no", () => {
        expect(serviceWith({}, true, providerReturning({ aggressive_rendering: false })).getAggressiveRenderingEnabled()).toBe(
            true,
        )
        expect(serviceWith({}, false, providerReturning({ aggressive_rendering: false })).getAggressiveRenderingEnabled()).toBe(
            false,
        )
    })

    it("lets an explicit variable override both", () => {
        const env = { DLINE_EXPERIMENTAL_ACCOUNT: "false" }
        expect(serviceWith(env, true, providerReturning({ account: true })).getAccountEnabled()).toBe(false)
    })

    it("still answers from the local layer when the rollout layer throws", () => {
        const broken: IFeatureFlagsProvider = {
            ...providerReturning({}),
            resolveFlags: () => {
                throw new Error("broken")
            },
        }
        expect(serviceWith({ DLINE_EXPERIMENTAL_ACCOUNT: "true" }, false, broken).getAccountEnabled()).toBe(true)
    })
})

describe("FeatureFlagsService.refresh", () => {
    it("notifies only when a switch actually changed", () => {
        let answers: Record<string, FeatureFlagPayload> = {}
        const service = new FeatureFlagsService({ ...providerReturning({}), resolveFlags: () => answers })
        const onChange = vi.fn()
        service.onDidChange(onChange)
        expect(service.getAccountEnabled()).toBe(false)

        service.refresh()
        expect(onChange).not.toHaveBeenCalled()

        answers = { account: true }
        service.refresh()
        expect(onChange).toHaveBeenCalledTimes(1)
        expect(service.getAccountEnabled()).toBe(true)
    })
})
