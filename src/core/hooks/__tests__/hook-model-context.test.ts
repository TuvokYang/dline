import { beforeEach, describe, it, vi } from "vitest"
import "should"
import { getHookModelContext } from "../hook-model-context"

const { mockFindEnabledProfileByName } = vi.hoisted(() => ({
	mockFindEnabledProfileByName: vi.fn(),
}))

vi.mock("@core/controller/file/getApiProfiles", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@core/controller/file/getApiProfiles")>()
	return {
		...actual,
		findEnabledProfileByName: mockFindEnabledProfileByName,
	}
})

describe("getHookModelContext", () => {
	beforeEach(() => {
		mockFindEnabledProfileByName.mockReset()
		mockFindEnabledProfileByName.mockImplementation((profileName?: string) => {
			const profiles = [
				{ name: "Plan Profile", provider: "openrouter" },
				{ name: "Act Profile", provider: "openai" },
			]
			return profiles.find((profile) => profile.name === profileName)
		})
	})

	it("should return the plan profile's provider and the active handler's model for plan mode", () => {
		const api = {
			getModel: () => ({ id: "anthropic/claude-sonnet-4.5" }),
		} as any

		const stateManager = {
			getGlobalSettingsKey: (key: string) => (key === "mode" ? "plan" : undefined),
			getApiConfiguration: () => ({
				planModeProfile: "Plan Profile",
				actModeProfile: "Act Profile",
			}),
		} as any

		const context = getHookModelContext(api, stateManager)
		context.provider?.should.equal("openrouter")
		context.slug?.should.equal("anthropic/claude-sonnet-4.5")
	})

	it("should return the act profile's provider and the active handler's model for act mode", () => {
		const api = {
			getModel: () => ({ id: "gpt-5" }),
		} as any

		const stateManager = {
			getGlobalSettingsKey: (key: string) => (key === "mode" ? "act" : undefined),
			getApiConfiguration: () => ({
				planModeProfile: "Plan Profile",
				actModeProfile: "Act Profile",
			}),
		} as any

		const context = getHookModelContext(api, stateManager)
		context.provider?.should.equal("openai")
		context.slug?.should.equal("gpt-5")
	})

	it("should fall back to unknown values when provider/slug are unavailable", () => {
		const api = {
			getModel: () => ({ id: "" }),
		} as any

		const stateManager = {
			getGlobalSettingsKey: (_: string) => "act",
			getApiConfiguration: () => ({
				planModeProfile: "Plan Profile",
				actModeProfile: "Missing Profile",
			}),
		} as any

		const context = getHookModelContext(api, stateManager)
		context.provider?.should.equal("unknown")
		context.slug?.should.equal("unknown")
	})
})
