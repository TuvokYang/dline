import { ApiProfile } from "@shared/proto/dline/profile"
import { act, renderHook, waitFor } from "@testing-library/react"
import React, { type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ExtensionStateContext, type ExtensionStateContextType } from "../../../context/ExtensionStateContext"
import {
	applyProfileUpdate,
	buildProfileSettings,
	reorderProfilesById,
	shouldUseTaskProfileSettings,
	useApiProfiles,
} from "./useApiProfiles"

const mocks = vi.hoisted(() => ({
	getApiProfiles: vi.fn(),
	updateApiProfiles: vi.fn(),
}))

vi.mock("../../../services/grpc-client", () => ({
	FileServiceClient: {
		getApiProfiles: mocks.getApiProfiles,
		updateApiProfiles: mocks.updateApiProfiles,
	},
	StateServiceClient: {
		requestProfileSwitch: vi.fn(),
	},
}))

describe("useApiProfiles", () => {
	beforeEach(() => {
		mocks.getApiProfiles.mockReset()
		mocks.updateApiProfiles.mockReset().mockResolvedValue({})
	})

	it("creates a Profile and exposes its shared expanded identity", async () => {
		mocks.getApiProfiles.mockResolvedValue({ profiles: [] })
		const wrapper = ({ children }: PropsWithChildren) =>
			React.createElement(
				ExtensionStateContext.Provider,
				{ value: { profileCatalogRevision: 200 } as ExtensionStateContextType },
				children,
			)
		const { result } = renderHook(() => useApiProfiles(), { wrapper })

		await waitFor(() => expect(result.current.loaded).to.equal(true))
		let profileId: string | undefined
		act(() => {
			profileId = result.current.addProfile()
		})

		expect(profileId).to.be.a("string")
		await waitFor(() => expect(result.current.expandedId).to.equal(profileId))
		expect(result.current.profiles).to.have.length(1)
		expect(result.current.profiles[0]?.id).to.equal(profileId)
	})

	it("keeps an optimistic reorder while a revision reload predates its durable commit", async () => {
		let revision = 301
		const first = ApiProfile.create({ id: "first", name: "First" })
		const second = ApiProfile.create({ id: "second", name: "Second" })
		let resolveUpdate!: (value: object) => void
		mocks.getApiProfiles
			.mockResolvedValueOnce({ profiles: [first, second] })
			.mockResolvedValueOnce({ profiles: [first, second] })
			.mockResolvedValueOnce({ profiles: [second, first] })
		mocks.updateApiProfiles.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveUpdate = resolve
			}),
		)
		const wrapper = ({ children }: PropsWithChildren) =>
			React.createElement(
				ExtensionStateContext.Provider,
				{ value: { profileCatalogRevision: revision } as ExtensionStateContextType },
				children,
			)
		const { result, rerender } = renderHook(() => useApiProfiles(), { wrapper })

		await waitFor(() => expect(result.current.profiles.map(({ id }) => id)).to.deep.equal(["first", "second"]))
		act(() => result.current.reorderProfiles("first", "second"))
		expect(result.current.profiles.map(({ id }) => id)).to.deep.equal(["second", "first"])

		revision = 302
		rerender()
		await waitFor(() => expect(mocks.getApiProfiles).toHaveBeenCalledTimes(2))
		expect(result.current.profiles.map(({ id }) => id)).to.deep.equal(["second", "first"])

		await act(async () => resolveUpdate({}))
		await waitFor(() => expect(mocks.getApiProfiles).toHaveBeenCalledTimes(3))
		expect(result.current.profiles.map(({ id }) => id)).to.deep.equal(["second", "first"])
	})

	it("reloads the shared Catalog when profileCatalogRevision changes", async () => {
		let revision = 101
		mocks.getApiProfiles
			.mockResolvedValueOnce({
				profiles: [ApiProfile.create({ id: "before", name: "Before" })],
			})
			.mockResolvedValueOnce({
				profiles: [ApiProfile.create({ id: "after", name: "After" })],
			})
		const wrapper = ({ children }: PropsWithChildren) =>
			React.createElement(
				ExtensionStateContext.Provider,
				{ value: { profileCatalogRevision: revision } as ExtensionStateContextType },
				children,
			)
		const { result, rerender } = renderHook(() => useApiProfiles(), { wrapper })

		await waitFor(() => expect(result.current.profiles[0]?.id).to.equal("before"))
		expect(mocks.getApiProfiles).toHaveBeenCalledTimes(1)

		revision = 102
		rerender()

		await waitFor(() => expect(result.current.profiles[0]?.id).to.equal("after"))
		expect(mocks.getApiProfiles).toHaveBeenCalledTimes(2)
	})
})

describe("applyProfileUpdate", () => {
	it("returns unchanged profiles when an update is a no-op", () => {
		const profile = ApiProfile.create({
			id: "profile-1",
			name: "openai:model-a",
			provider: "openai",
			modelId: "model-a",
		})
		const profiles = [profile]

		const result = applyProfileUpdate(profiles, "profile-1", { modelId: "model-a" })

		expect(result.changed).to.equal(false)
		expect(result.profiles).to.equal(profiles)
	})

	it("returns changed profiles when an update modifies a profile", () => {
		const profile = ApiProfile.create({
			id: "profile-1",
			name: "openai:model-a",
			provider: "openai",
			modelId: "model-a",
		})
		const profiles = [profile]

		const result = applyProfileUpdate(profiles, "profile-1", { modelId: "model-b" })

		expect(result.changed).to.equal(true)
		expect(result.profiles).not.to.equal(profiles)
		expect(result.profiles[0]?.modelId).to.equal("model-b")
	})

	it("preserves an explicit profile name that starts with the provider prefix", () => {
		const profile = ApiProfile.create({
			id: "profile-1",
			name: "openai:model-a",
			provider: "openai",
			modelId: "model-a",
		})
		const profiles = [profile]

		const result = applyProfileUpdate(profiles, "profile-1", { name: "openai:custom" })

		expect(result.changed).to.equal(true)
		expect(result.profiles[0]?.name).to.equal("openai:custom")
	})
})

describe("reorderProfilesById", () => {
	const profiles = ["a", "b", "c"].map((id) => ApiProfile.create({ id, name: id, enabled: true }))

	it("moves a Profile by stable ID without recreating unaffected entries", () => {
		const result = reorderProfilesById(profiles, "a", "c")

		expect(result.map((profile) => profile.id)).to.deep.equal(["b", "c", "a"])
		expect(result[0]).to.equal(profiles[1])
		expect(result[1]).to.equal(profiles[2])
	})

	it("returns the original array for an invalid or unchanged drop", () => {
		expect(reorderProfilesById(profiles, "missing", "c")).to.equal(profiles)
		expect(reorderProfilesById(profiles, "a", "missing")).to.equal(profiles)
		expect(reorderProfilesById(profiles, "b", "b")).to.equal(profiles)
	})
})

describe("buildProfileSettings", () => {
	it("builds stable identity and display name for unified selection", () => {
		const result = buildProfileSettings("deepseek-id", "deepseek-selected", ["plan", "act"])

		expect(result).to.deep.equal({
			planModeProfileId: "deepseek-id",
			planModeProfile: "deepseek-selected",
			actModeProfileId: "deepseek-id",
			actModeProfile: "deepseek-selected",
		})
	})

	it("builds stable identity and display name only for the target mode", () => {
		const result = buildProfileSettings("anthropic-id", "anthropic-plan", ["plan"])

		expect(result).to.deep.equal({
			planModeProfileId: "anthropic-id",
			planModeProfile: "anthropic-plan",
		})
	})
})

describe("shouldUseTaskProfileSettings", () => {
	it("keeps profile selection task-scoped before the history item id is available", () => {
		expect(shouldUseTaskProfileSettings(undefined, true)).to.equal(true)
	})

	it("uses global profile settings when no task exists", () => {
		expect(shouldUseTaskProfileSettings(undefined, false)).to.equal(false)
	})
})
