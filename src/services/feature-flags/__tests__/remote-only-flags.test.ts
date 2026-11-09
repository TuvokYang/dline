import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
    EXPERIMENTAL_FEATURE_FLAGS,
    ExperimentalFeatureFlag,
    ExperimentalFeatureFlagDefaultValue,
    REMOTE_ONLY_EXPERIMENTAL_FEATURE_FLAGS,
} from "@/shared/services/feature-flags/feature-flags"
import { resolveExperimentalFlag, resolveLocalExperimentalFlag } from "@/shared/services/feature-flags/resolve-experimental-flags"
import { FeatureFlagsService } from "../FeatureFlagsService"
import type { FeatureFlagPayload, IFeatureFlagsProvider } from "../providers/IFeatureFlagsProvider"
import { LayeredFeatureFlagsProvider } from "../providers/LayeredFeatureFlagsProvider"
import { LocalFeatureFlagsProvider } from "../providers/LocalFeatureFlagsProvider"

// Exercise the classification without assigning mutually exclusive semantics to a real product flag.
const fixture = "remote-only-test" as ExperimentalFeatureFlag
const remoteOnly = REMOTE_ONLY_EXPERIMENTAL_FEATURE_FLAGS as Set<ExperimentalFeatureFlag>

beforeEach(() => {
    EXPERIMENTAL_FEATURE_FLAGS.push(fixture)
    remoteOnly.add(fixture)
    ExperimentalFeatureFlagDefaultValue[fixture] = true
})

afterEach(() => {
    EXPERIMENTAL_FEATURE_FLAGS.splice(EXPERIMENTAL_FEATURE_FLAGS.indexOf(fixture), 1)
    remoteOnly.delete(fixture)
    delete ExperimentalFeatureFlagDefaultValue[fixture]
})

function remote(flags: Record<string, FeatureFlagPayload>, fail = false): IFeatureFlagsProvider {
    return {
        resolveFlags: () => {
            if (fail) throw new Error("remote unavailable")
            return flags
        },
        isEnabled: () => true,
        getSettings: () => ({ enabled: true }),
        dispose: async () => {},
    }
}

function service(provider: IFeatureFlagsProvider, override: string) {
    return new FeatureFlagsService(
        new LayeredFeatureFlagsProvider([
            new LocalFeatureFlagsProvider({ IS_DEV: "true", DLINE_EXPERIMENTAL_REMOTE_ONLY_TEST: override }, true),
            provider,
        ]),
    )
}

describe("remote-only rollout authority", () => {
    it.each(["true", "false"])("ignores local override %s and both development sources", (override) => {
        expect(
            resolveLocalExperimentalFlag(fixture, { IS_DEV: "true", DLINE_EXPERIMENTAL_REMOTE_ONLY_TEST: override }, true),
        ).toBeUndefined()
        expect(service(remote({ [fixture]: true }), override).getBooleanFlagEnabled(fixture)).toBe(true)
        expect(service(remote({ [fixture]: false }), override).getBooleanFlagEnabled(fixture)).toBe(false)
    })

    it("fails closed without a remote answer even when the static default is true", () => {
        expect(service(remote({}), "true").getBooleanFlagEnabled(fixture)).toBe(false)
        expect(resolveExperimentalFlag(fixture, { IS_DEV: "true" }, true)).toBe(false)
    })

    it("fails closed when the remote layer fails", () => {
        expect(service(remote({}, true), "true").getBooleanFlagEnabled(fixture)).toBe(false)
        expect(new FeatureFlagsService(remote({}, true)).getBooleanFlagEnabled(fixture)).toBe(false)
    })
})
