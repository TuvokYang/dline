// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react"
import type { PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ExtensionStateContext, type ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { useModelProbe } from "./useModelProbe"
import { useProviderModelOptions } from "./useProviderModelOptions"

const mocks = vi.hoisted(() => ({
	getAvailableModels: vi.fn(),
	refreshProviderModels: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		getAvailableModels: mocks.getAvailableModels,
		refreshProviderModels: mocks.refreshProviderModels,
	},
}))

function catalogResponse() {
	return {
		providers: [
			{
				provider: "origin-test",
				providerName: "Origin Test",
				defaultModelId: "catalog-model",
				models: [
					{
						id: "catalog-model",
						name: "catalog-model",
						capabilities: {
							contextWindow: 71,
							thinking: { supported: true, mode: "effort", effortLevels: ["high"], defaultEnabled: true },
						},
						pricing: { inputPrice: 3 },
					},
				],
				defaultImageModelId: "",
				imageModels: [],
			},
		],
	}
}

const wrapper = ({ children }: PropsWithChildren) => (
	<ExtensionStateContext.Provider value={{ providersVersion: 1 } as ExtensionStateContextType}>
		{children}
	</ExtensionStateContext.Provider>
)

describe("useProviderModelOptions", () => {
	beforeEach(() => {
		mocks.getAvailableModels.mockReset()
		mocks.refreshProviderModels.mockReset()
		mocks.getAvailableModels.mockResolvedValue(catalogResponse())
	})

	it("marks ids the local catalog does not carry as remote", async () => {
		mocks.refreshProviderModels.mockResolvedValue({ values: ["catalog-model", "listing-only-model"] })

		const { result } = renderHook(
			() =>
				useProviderModelOptions({
					providerId: "origin-test",
					baseUrl: "https://example.test",
					apiKey: "key",
				}),
			{ wrapper },
		)

		await waitFor(() => expect(result.current.options).toHaveProperty("catalog-model"))
		act(() => result.current.refreshRemoteModels())
		await waitFor(() => expect(result.current.options).toHaveProperty("listing-only-model"))

		expect(result.current.optionOrigins["catalog-model"]).toBe("catalog")
		expect(result.current.optionOrigins["listing-only-model"]).toBe("remote")
		expect(result.current.options["catalog-model"]).toEqual(catalogResponse().providers[0].models[0])
		expect(result.current.options["listing-only-model"]).toEqual({
			id: "listing-only-model",
			name: "listing-only-model",
			userDefined: true,
		})
	})

	it("leaves a free-form selection without an origin", async () => {
		mocks.refreshProviderModels.mockResolvedValue({ values: [] })

		const { result } = renderHook(
			() =>
				useProviderModelOptions({
					providerId: "origin-test",
					selectedModelId: "hand-typed-model",
				}),
			{ wrapper },
		)

		await waitFor(() => expect(result.current.models).toHaveProperty("catalog-model"))
		expect(result.current.options["hand-typed-model"]).toEqual({ id: "hand-typed-model", name: "hand-typed-model" })
		expect(result.current.optionOrigins["hand-typed-model"]).toBeUndefined()
	})

	it("discards a previous endpoint's listing while preserving the catalog and fresh identities", async () => {
		let completeOld: ((response: { values: string[] }) => void) | undefined
		mocks.refreshProviderModels
			.mockImplementationOnce(() => new Promise<{ values: string[] }>((resolve) => (completeOld = resolve)))
			.mockResolvedValueOnce({ values: ["fresh-model", "catalog-model"] })
		const { result, rerender } = renderHook(
			({ baseUrl }) => useProviderModelOptions({ providerId: "origin-test", profileId: "test-profile", baseUrl }),
			{ wrapper, initialProps: { baseUrl: "https://old.test" } },
		)
		await waitFor(() => expect(result.current.models).toHaveProperty("catalog-model"))
		act(() => result.current.refreshRemoteModels())
		rerender({ baseUrl: "https://new.test" })
		const completeListing = completeOld
		if (!completeListing) throw new Error("Expected the first listing to remain pending")
		await act(async () => completeListing({ values: ["stale-model"] }))
		expect(result.current.options).not.toHaveProperty("stale-model")
		act(() => result.current.refreshRemoteModels())
		await waitFor(() => expect(result.current.options).toHaveProperty("fresh-model"))
		expect(result.current.options["fresh-model"]).toEqual({ id: "fresh-model", name: "fresh-model", userDefined: true })
		expect(result.current.options["catalog-model"]).toEqual(catalogResponse().providers[0].models[0])
		expect(mocks.refreshProviderModels.mock.calls[1][0]).toMatchObject({
			baseUrl: "https://new.test",
			profileId: "test-profile",
		})
	})

	it("keeps local probe identities minimal through a failed probe and successful retry", async () => {
		const probe = vi
			.fn()
			.mockRejectedValueOnce(new Error("listing failed"))
			.mockResolvedValueOnce(["local-model", "local-model"])
		const { result } = renderHook(() => useModelProbe({ probe, enabled: true, selectedModelId: "selected-local" }))
		act(() => result.current.refresh())
		await waitFor(() => expect(result.current.error?.message).toBe("listing failed"))
		expect(result.current.models).toEqual({
			"selected-local": { id: "selected-local", name: "selected-local", userDefined: true },
		})
		act(() => result.current.refresh())
		await waitFor(() => expect(result.current.models).toHaveProperty("local-model"))
		expect(result.current.error).toBeUndefined()
		expect(result.current.models).toEqual({
			"selected-local": { id: "selected-local", name: "selected-local", userDefined: true },
			"local-model": { id: "local-model", name: "local-model", userDefined: true },
		})
	})
})
