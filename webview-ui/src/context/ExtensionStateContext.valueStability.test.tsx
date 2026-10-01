import { OpenRouterCompatibleModelInfo } from "@shared/proto/dline/models"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useEffect, useRef } from "react"
import { describe, expect, it, vi } from "vitest"
import { HuggingFaceModelPicker } from "../components/settings/HuggingFaceModelPicker"
import { ExtensionStateContextProvider, useExtensionState } from "./ExtensionStateContext"

const modelMocks = vi.hoisted(() => ({ refreshHicap: vi.fn(), refreshHuggingFace: vi.fn() }))
vi.mock("../components/history/HistoryView", () => ({ highlight: vi.fn(() => []) }))

vi.mock("@/services/grpc-client", () => {
	const neverResolving = () => new Promise(() => {})
	const stream = () => () => {}
	return {
		StateServiceClient: {
			subscribeToState: stream,
			getLatestState: neverResolving,
			getAvailableTerminalProfiles: neverResolving,
			subscribeToPartialMessage: stream,
		},
		UiServiceClient: {
			initializeWebview: neverResolving,
			subscribeToPartialMessage: stream,
			subscribeToTheme: stream,
			subscribeToMcpButtonClicked: stream,
			subscribeToHistoryButtonClicked: stream,
			subscribeToChatButtonClicked: stream,
			subscribeToAccountButtonClicked: stream,
			subscribeToSettingsButtonClicked: stream,
			subscribeToWorktreesButtonClicked: stream,
			subscribeToFocusChatInput: stream,
			subscribeToRelinquishControl: stream,
			subscribeToAddToInput: stream,
		},
		ModelsServiceClient: {
			subscribeToOpenRouterModels: stream,
			subscribeToLiteLlmModels: stream,
			refreshOpenRouterModelsRpc: neverResolving,
			refreshHicapModels: modelMocks.refreshHicap,
			refreshHuggingFaceModels: modelMocks.refreshHuggingFace,
			refreshLiteLlmModelsRpc: neverResolving,
			refreshBasetenModelsRpc: neverResolving,
			refreshVercelAiGatewayModelsRpc: neverResolving,
			refreshClineModelsRpc: neverResolving,
		},
		McpServiceClient: {
			subscribeToMcpServers: stream,
			subscribeToMcpMarketplaceCatalog: stream,
		},
		FileServiceClient: {
			subscribeToWorkspaceUpdates: stream,
		},
		TaskServiceClient: {
			fetchMessage: neverResolving,
		},
		AccountServiceClient: {},
		WorktreeServiceClient: {},
	}
})

/**
 * Records every context value the provider hands to consumers, plus how many
 * times the consumer re-rendered. The consumer itself holds no state, so a new
 * render can only come from the provider publishing a new value.
 */
function createValueProbe() {
	const values: unknown[] = []
	const Probe = () => {
		const value = useExtensionState()
		const renderCount = useRef(0)
		renderCount.current += 1
		values.push(value)
		return null
	}
	return { values, Probe }
}

/** Drives a provider-internal state update without changing observable data. */
function createUnrelatedUpdateTrigger() {
	let trigger: (() => void) | undefined
	const Trigger = () => {
		const { setTotalTasksSize } = useExtensionState()
		useEffect(() => {
			trigger = () => setTotalTasksSize(0)
		}, [setTotalTasksSize])
		return null
	}
	return { Trigger, fire: () => trigger?.() }
}

function modelListing() {
	return OpenRouterCompatibleModelInfo.create({
		models: {
			complete: {
				supportsReasoning: true,
				modelInfo: {
					id: "payload-id-is-not-the-map-key",
					name: "Complete fixture",
					userDefined: true,
					apiFormats: [],
					capabilities: {
						supportsReasoning: false,
						thinking: {
							supported: false,
							mode: "both",
							effortLevels: [],
							defaultEnabled: false,
							minBudget: 0,
							maxBudget: 0,
						},
					},
					pricing: { thinkingOutputPrice: 0 },
				},
			},
			"legacy-unknown": {},
			"legacy-thinking": {
				thinkingConfig: { supported: true, mode: "effort", effortLevels: [], defaultEnabled: false, minBudget: 0 },
			},
		},
	})
}

function ModelListingProbe({ provider }: { provider: "hicap" | "huggingface" }) {
	const { hicapModels, huggingFaceModels, refreshHicapModels } = useExtensionState()
	return (
		<>
			<button onClick={refreshHicapModels} type="button">
				Refresh Hicap
			</button>
			<span data-testid="discovered-models">{JSON.stringify(provider === "hicap" ? hicapModels : huggingFaceModels)}</span>
		</>
	)
}

for (const provider of ["hicap", "huggingface"] as const) {
	it(`preserves model declarations through compatibility ${provider} refresh`, async () => {
		const refresh = provider === "hicap" ? modelMocks.refreshHicap : modelMocks.refreshHuggingFace
		refresh.mockResolvedValueOnce(modelListing())
		render(
			<ExtensionStateContextProvider>
				{provider === "huggingface" && <HuggingFaceModelPicker />}
				<ModelListingProbe provider={provider} />
			</ExtensionStateContextProvider>,
		)
		if (provider === "hicap") fireEvent.click(screen.getByRole("button", { name: "Refresh Hicap" }))
		await waitFor(() => expect(screen.getByTestId("discovered-models")).toHaveTextContent("legacy-unknown"))
		const models = JSON.parse(screen.getByTestId("discovered-models").textContent ?? "null")
		expect(models.complete).toEqual({
			id: "complete",
			name: "Complete fixture",
			userDefined: true,
			apiFormats: [],
			capabilities: {
				supportsReasoning: false,
				thinking: { supported: false, mode: "both", effortLevels: [], defaultEnabled: false, minBudget: 0, maxBudget: 0 },
			},
			pricing: { thinkingOutputPrice: 0 },
		})
		expect(models["legacy-unknown"].capabilities).not.toHaveProperty("supportsReasoning")
		expect(models["legacy-unknown"].capabilities).not.toHaveProperty("thinking")
		expect(models["legacy-thinking"].capabilities.thinking).toEqual({
			supported: true,
			mode: "effort",
			effortLevels: [],
			defaultEnabled: false,
			minBudget: 0,
		})
	})
}

it("keeps the last compatibility Hicap listing when a refresh fails", async () => {
	const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {})
	try {
		modelMocks.refreshHicap
			.mockResolvedValueOnce(modelListing())
			.mockRejectedValueOnce(new Error("synthetic listing failure"))
		render(
			<ExtensionStateContextProvider>
				<ModelListingProbe provider="hicap" />
			</ExtensionStateContextProvider>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Refresh Hicap" }))
		await waitFor(() => expect(screen.getByTestId("discovered-models")).toHaveTextContent("legacy-unknown"))
		const previous = screen.getByTestId("discovered-models").textContent
		fireEvent.click(screen.getByRole("button", { name: "Refresh Hicap" }))
		await waitFor(() => expect(diagnostic).toHaveBeenCalledWith("Failed to refresh Hicap models:", expect.any(Error)))
		expect(screen.getByTestId("discovered-models").textContent).toBe(previous)
	} finally {
		diagnostic.mockRestore()
	}
})

describe("ExtensionStateContext provider value stability", () => {
	it("keeps the context value referentially stable across re-renders with unchanged state", async () => {
		const { values, Probe } = createValueProbe()

		const { rerender } = render(
			<ExtensionStateContextProvider>
				<Probe />
			</ExtensionStateContextProvider>,
		)

		const initialValue = values[values.length - 1]

		// Re-render the provider itself without touching any of its state.
		rerender(
			<ExtensionStateContextProvider>
				<Probe />
			</ExtensionStateContextProvider>,
		)

		expect(values[values.length - 1]).toBe(initialValue)
	})

	it("exposes stable function identities so consumer effects do not re-run", () => {
		const { values, Probe } = createValueProbe()

		const { rerender } = render(
			<ExtensionStateContextProvider>
				<Probe />
			</ExtensionStateContextProvider>,
		)

		const first = values[values.length - 1] as Record<string, unknown>

		rerender(
			<ExtensionStateContextProvider>
				<Probe />
			</ExtensionStateContextProvider>,
		)

		const second = values[values.length - 1] as Record<string, unknown>

		const functionKeys = Object.keys(first).filter((key) => typeof first[key] === "function")
		expect(functionKeys.length).toBeGreaterThan(0)

		const unstable = functionKeys.filter((key) => first[key] !== second[key])
		expect(unstable).toEqual([])
	})

	it("publishes a new value when observable state actually changes", () => {
		const { values, Probe } = createValueProbe()
		const { Trigger, fire } = createUnrelatedUpdateTrigger()

		render(
			<ExtensionStateContextProvider>
				<Trigger />
				<Probe />
			</ExtensionStateContextProvider>,
		)

		const before = values[values.length - 1] as Record<string, unknown>
		expect(before.totalTasksSize).not.toBe(0)

		act(() => {
			fire()
		})

		const after = values[values.length - 1] as Record<string, unknown>
		expect(after).not.toBe(before)
		expect(after.totalTasksSize).toBe(0)
	})
})
