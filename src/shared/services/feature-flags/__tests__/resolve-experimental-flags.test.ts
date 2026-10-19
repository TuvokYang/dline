import { describe, expect, it } from "vitest"
import { ExperimentalFeatureFlag } from "../feature-flags"
import {
    environmentVariableNameFor,
    resolveExperimentalFlag,
    resolveExperimentalFlags,
    resolveLocalExperimentalFlag,
} from "../resolve-experimental-flags"

const WORKTREES_VAR = "DLINE_EXPERIMENTAL_WORKTREE_EXP"
const WORKTREES = ExperimentalFeatureFlag.WORKTREES

describe("environmentVariableNameFor", () => {
    it("uppercases the flag and prefixes it", () => {
        expect(environmentVariableNameFor(ExperimentalFeatureFlag.ACCOUNT)).toBe("DLINE_EXPERIMENTAL_ACCOUNT")
    })

    it("collapses the separators a flag value may use", () => {
        expect(environmentVariableNameFor(WORKTREES)).toBe(WORKTREES_VAR)
    })
})

describe("resolveExperimentalFlag", () => {
    it("falls back to the static default when nothing is set", () => {
        expect(resolveExperimentalFlag(WORKTREES, {})).toBe(false)
    })

    it("turns every switch on under IS_DEV", () => {
        expect(resolveExperimentalFlag(WORKTREES, { IS_DEV: "true" })).toBe(true)
    })

    it("lets the variable enable a switch that is off by default", () => {
        expect(resolveExperimentalFlag(WORKTREES, { [WORKTREES_VAR]: "true" })).toBe(true)
    })

    it("lets the variable disable a switch that IS_DEV would enable", () => {
        const env = { IS_DEV: "true", [WORKTREES_VAR]: "false" }

        expect(resolveExperimentalFlag(WORKTREES, env)).toBe(false)
        // The override is per switch; the others still follow IS_DEV.
        expect(resolveExperimentalFlag(ExperimentalFeatureFlag.ACCOUNT, env)).toBe(true)
    })

    it("accepts 1 and 0 as well as true and false", () => {
        expect(resolveExperimentalFlag(WORKTREES, { [WORKTREES_VAR]: "1" })).toBe(true)
        expect(resolveExperimentalFlag(WORKTREES, { IS_DEV: "1", [WORKTREES_VAR]: "0" })).toBe(false)
    })

    it("ignores case and surrounding whitespace", () => {
        expect(resolveExperimentalFlag(WORKTREES, { [WORKTREES_VAR]: " TRUE " })).toBe(true)
        expect(resolveExperimentalFlag(WORKTREES, { IS_DEV: "true", [WORKTREES_VAR]: " False " })).toBe(false)
    })

    it("falls through to the next source when the value is unrecognised", () => {
        // A typo must not read as "off": that would silently disable a switch
        // the developer had turned on with IS_DEV.
        expect(resolveExperimentalFlag(WORKTREES, { IS_DEV: "true", [WORKTREES_VAR]: "yes" })).toBe(true)
        expect(resolveExperimentalFlag(WORKTREES, { [WORKTREES_VAR]: "yes" })).toBe(false)
    })

    it("treats an empty value as unset rather than as off", () => {
        expect(resolveExperimentalFlag(WORKTREES, { IS_DEV: "true", [WORKTREES_VAR]: "" })).toBe(true)
    })

    it("does not let IS_DEV=false suppress an explicit variable", () => {
        expect(resolveExperimentalFlag(WORKTREES, { IS_DEV: "false", [WORKTREES_VAR]: "true" })).toBe(true)
    })

    it("turns on only the switches with a development default in a development build", () => {
        expect(resolveExperimentalFlag(ExperimentalFeatureFlag.ACCOUNT, {}, true)).toBe(true)
        expect(resolveExperimentalFlag(ExperimentalFeatureFlag.ACCOUNT, {}, false)).toBe(false)
        // Switches without one keep their static default, so development bundles
        // and the E2E runs built from them do not change behavior.
        expect(resolveExperimentalFlag(WORKTREES, {}, true)).toBe(false)
    })

    it("lets the variable turn a development default off", () => {
        expect(resolveExperimentalFlag(ExperimentalFeatureFlag.ACCOUNT, { DLINE_EXPERIMENTAL_ACCOUNT: "false" }, true)).toBe(
            false,
        )
    })
})

describe("resolveLocalExperimentalFlag", () => {
    it("has no opinion when no local source sets the switch", () => {
        // The feature service is consulted only in this case.
        expect(resolveLocalExperimentalFlag(ExperimentalFeatureFlag.ACCOUNT, {}, false)).toBeUndefined()
        expect(resolveLocalExperimentalFlag(WORKTREES, {}, true)).toBeUndefined()
    })

    it("reports an explicit off as an opinion", () => {
        expect(resolveLocalExperimentalFlag(ExperimentalFeatureFlag.ACCOUNT, { DLINE_EXPERIMENTAL_ACCOUNT: "0" }, false)).toBe(
            false,
        )
    })
})

describe("resolveExperimentalFlags", () => {
    it("answers every known switch", () => {
        expect(resolveExperimentalFlags({})).toEqual({
            [ExperimentalFeatureFlag.WORKTREES]: false,
            [ExperimentalFeatureFlag.ACCOUNT]: false,
        })
    })

    it("enables all of them under IS_DEV", () => {
        expect(resolveExperimentalFlags({ IS_DEV: "true" })).toEqual({
            [ExperimentalFeatureFlag.WORKTREES]: true,
            [ExperimentalFeatureFlag.ACCOUNT]: true,
        })
    })
})
