import { describe, expect, it } from "vitest"
import { ExperimentalFeatureFlag } from "../feature-flags"
import { environmentVariableNameFor, resolveExperimentalFlag, resolveExperimentalFlags } from "../resolve-experimental-flags"

const WEBTOOLS_VAR = "DLINE_EXPERIMENTAL_WEBTOOLS"
const WORKTREES_VAR = "DLINE_EXPERIMENTAL_WORKTREE_EXP"

describe("environmentVariableNameFor", () => {
	it("uppercases the flag and prefixes it", () => {
		expect(environmentVariableNameFor(ExperimentalFeatureFlag.WEBTOOLS)).toBe(WEBTOOLS_VAR)
	})

	it("collapses the separators a flag value may use", () => {
		expect(environmentVariableNameFor(ExperimentalFeatureFlag.WORKTREES)).toBe(WORKTREES_VAR)
		expect(environmentVariableNameFor(ExperimentalFeatureFlag.OPENAI_RESPONSES_WEBSOCKET_MODE)).toBe(
			"DLINE_EXPERIMENTAL_OPENAI_RESPONSES_WEBSOCKET_MODE",
		)
	})
})

describe("resolveExperimentalFlag", () => {
	it("falls back to the static default when nothing is set", () => {
		expect(resolveExperimentalFlag(ExperimentalFeatureFlag.WEBTOOLS, {})).toBe(false)
	})

	it("turns every switch on under IS_DEV", () => {
		expect(resolveExperimentalFlag(ExperimentalFeatureFlag.WEBTOOLS, { IS_DEV: "true" })).toBe(true)
	})

	it("lets the variable enable a switch that is off by default", () => {
		expect(resolveExperimentalFlag(ExperimentalFeatureFlag.WEBTOOLS, { [WEBTOOLS_VAR]: "true" })).toBe(true)
	})

	it("lets the variable disable a switch that IS_DEV would enable", () => {
		const env = { IS_DEV: "true", [WEBTOOLS_VAR]: "false" }

		expect(resolveExperimentalFlag(ExperimentalFeatureFlag.WEBTOOLS, env)).toBe(false)
		// The override is per switch; the others still follow IS_DEV.
		expect(resolveExperimentalFlag(ExperimentalFeatureFlag.WORKTREES, env)).toBe(true)
	})

	it("accepts 1 and 0 as well as true and false", () => {
		expect(resolveExperimentalFlag(ExperimentalFeatureFlag.WEBTOOLS, { [WEBTOOLS_VAR]: "1" })).toBe(true)
		expect(resolveExperimentalFlag(ExperimentalFeatureFlag.WEBTOOLS, { IS_DEV: "1", [WEBTOOLS_VAR]: "0" })).toBe(false)
	})

	it("ignores case and surrounding whitespace", () => {
		expect(resolveExperimentalFlag(ExperimentalFeatureFlag.WEBTOOLS, { [WEBTOOLS_VAR]: " TRUE " })).toBe(true)
		expect(resolveExperimentalFlag(ExperimentalFeatureFlag.WEBTOOLS, { IS_DEV: "true", [WEBTOOLS_VAR]: " False " })).toBe(
			false,
		)
	})

	it("falls through to the next source when the value is unrecognised", () => {
		// A typo must not read as "off": that would silently disable a switch
		// the developer had turned on with IS_DEV.
		expect(resolveExperimentalFlag(ExperimentalFeatureFlag.WEBTOOLS, { IS_DEV: "true", [WEBTOOLS_VAR]: "yes" })).toBe(true)
		expect(resolveExperimentalFlag(ExperimentalFeatureFlag.WEBTOOLS, { [WEBTOOLS_VAR]: "yes" })).toBe(false)
	})

	it("treats an empty value as unset rather than as off", () => {
		expect(resolveExperimentalFlag(ExperimentalFeatureFlag.WEBTOOLS, { IS_DEV: "true", [WEBTOOLS_VAR]: "" })).toBe(true)
	})

	it("does not let IS_DEV=false suppress an explicit variable", () => {
		expect(resolveExperimentalFlag(ExperimentalFeatureFlag.WEBTOOLS, { IS_DEV: "false", [WEBTOOLS_VAR]: "true" })).toBe(true)
	})
})

describe("resolveExperimentalFlags", () => {
	it("answers every known switch", () => {
		expect(resolveExperimentalFlags({})).toEqual({
			[ExperimentalFeatureFlag.WEBTOOLS]: false,
			[ExperimentalFeatureFlag.WORKTREES]: false,
			[ExperimentalFeatureFlag.OPENAI_RESPONSES_WEBSOCKET_MODE]: false,
		})
	})

	it("enables all of them under IS_DEV", () => {
		expect(resolveExperimentalFlags({ IS_DEV: "true" })).toEqual({
			[ExperimentalFeatureFlag.WEBTOOLS]: true,
			[ExperimentalFeatureFlag.WORKTREES]: true,
			[ExperimentalFeatureFlag.OPENAI_RESPONSES_WEBSOCKET_MODE]: true,
		})
	})
})
