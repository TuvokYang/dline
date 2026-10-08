import { describe, expect, it } from "vitest"
import {
	assertChannelVersion,
	createInsidersVersion,
	isPreReleaseMinor,
	parseReleaseVersion,
} from "../../scripts/release-version-policy.mjs"

const NOW_MS = 1_791_500_000_123

describe("release version policy", () => {
	it("parses only plain major.minor.patch versions", () => {
		expect(parseReleaseVersion("0.10.0")).toEqual({ major: 0, minor: 10, patch: 0 })
		expect(() => parseReleaseVersion("0.10.0-rc.1")).toThrow("not a plain major.minor.patch")
		expect(() => parseReleaseVersion("0.10")).toThrow("not a plain major.minor.patch")
	})

	it("reserves odd minors for pre-releases", () => {
		expect(isPreReleaseMinor(9)).toBe(true)
		expect(isPreReleaseMinor(11)).toBe(true)
		expect(isPreReleaseMinor(10)).toBe(false)
		expect(isPreReleaseMinor(0)).toBe(false)
	})

	it("accepts production on even minors and pre-release on odd minors", () => {
		expect(() => assertChannelVersion("production", "0.10.0")).not.toThrow()
		expect(() => assertChannelVersion("production", "1.0.3")).not.toThrow()
		expect(() => assertChannelVersion("pre-release", "0.11.0")).not.toThrow()
		expect(() => assertChannelVersion("pre-release", "0.11.4")).not.toThrow()
	})

	it("rejects a release whose minor belongs to the other channel", () => {
		expect(() => assertChannelVersion("production", "0.9.4")).toThrow("Production version 0.9.4 has an odd minor")
		expect(() => assertChannelVersion("pre-release", "0.10.0")).toThrow("Pre-release version 0.10.0 has an even minor")
	})

	it("keeps Insiders on the pre-release line above the production it follows", () => {
		const timestamp = Math.floor(NOW_MS / 1000)

		// An even package minor is a production version; Insiders moves to the next odd line.
		expect(createInsidersVersion("0.10.0", NOW_MS)).toBe(`0.11.${timestamp}`)
		// An odd package minor is already the pre-release line.
		expect(createInsidersVersion("0.11.2", NOW_MS)).toBe(`0.11.${timestamp}`)
		expect(createInsidersVersion("1.0.0", NOW_MS)).toBe(`1.1.${timestamp}`)
	})

	it("rejects a malformed package version instead of inventing an Insiders version", () => {
		expect(() => createInsidersVersion("next", NOW_MS)).toThrow("not a plain major.minor.patch")
	})
})
