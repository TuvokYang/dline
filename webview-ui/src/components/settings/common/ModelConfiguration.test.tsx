// @vitest-environment jsdom
import type { ModelInfo } from "@shared/proto/dline/models"
import { type ModelCapabilities, type ModelPricing, ServerTool } from "@shared/proto/dline/models/metadata"
import { fireEvent, render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { ModelConfiguration } from "./ModelConfiguration"

vi.mock("@/components/ui/label", () => ({
	Label: ({ children, className, style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) => (
		<div className={className} style={style}>
			{children}
		</div>
	),
}))

vi.mock("@/components/ui/select", () => ({
	Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SelectValue: () => <span />,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({
		children,
		onClick,
	}: {
		children: React.ReactNode
		onClick?: React.MouseEventHandler<HTMLButtonElement>
	}) => (
		<button onClick={onClick} type="button">
			{children}
		</button>
	),
	VSCodeCheckbox: ({
		checked,
		children,
		onChange,
	}: {
		checked?: boolean
		children: React.ReactNode
		onChange?: React.ChangeEventHandler<HTMLInputElement>
	}) => (
		<label>
			<input checked={checked} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
}))

vi.mock("./DebouncedTextField", () => ({
	DebouncedTextField: ({
		ariaLabel,
		children,
		className,
		id,
		initialValue,
		onChange,
	}: {
		ariaLabel?: string
		children?: React.ReactNode
		className?: string
		id?: string
		initialValue?: string
		onChange: (value: string) => void
	}) => {
		const input = (
			<input
				aria-label={ariaLabel}
				className={className}
				defaultValue={initialValue}
				id={id}
				onChange={(event) => onChange(event.target.value)}
			/>
		)
		return children ? (
			<label>
				{children}
				{input}
			</label>
		) : (
			input
		)
	},
}))

describe("ModelConfiguration", () => {
	it("keeps checkbox draft state while persisted props are stale", () => {
		const onCapabilitiesUpdate = vi.fn()
		const { rerender } = render(
			<ModelConfiguration
				capabilities={{ supportsImages: false } as ModelCapabilities}
				fields={{ capabilities: ["supportsImages"] }}
				onCapabilitiesUpdate={onCapabilitiesUpdate}
				onPricingUpdate={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		fireEvent.click(screen.getByLabelText("Supports Images"))
		expect(screen.getByLabelText("Supports Images")).toBeChecked()

		rerender(
			<ModelConfiguration
				capabilities={{ supportsImages: false } as ModelCapabilities}
				fields={{ capabilities: ["supportsImages"] }}
				onCapabilitiesUpdate={onCapabilitiesUpdate}
				onPricingUpdate={vi.fn()}
			/>,
		)
		expect(screen.getByLabelText("Supports Images")).toBeChecked()
	})

	it("adds and edits custom context and pricing tiers", () => {
		const onCapabilitiesUpdate = vi.fn()
		const onPricingUpdate = vi.fn()

		render(
			<ModelConfiguration
				capabilities={{ contextWindowTiers: [] } as unknown as ModelCapabilities}
				fields={{ capabilities: ["contextWindowTiers"], pricing: ["pricingTiers"] }}
				onCapabilitiesUpdate={onCapabilitiesUpdate}
				onPricingUpdate={onPricingUpdate}
				pricing={{ tiers: [] } as unknown as ModelPricing}
				tiersEditable={true}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		fireEvent.click(screen.getByRole("button", { name: "Add Context Tier" }))
		expect(onCapabilitiesUpdate).toHaveBeenCalledWith({
			contextWindowTiers: [{ id: "standard", contextWindow: 128_000, label: "128K", apiModelSuffix: "" }],
		})

		fireEvent.change(screen.getByLabelText("Context Tier ID"), { target: { value: "long" } })
		expect(onCapabilitiesUpdate).toHaveBeenLastCalledWith({
			contextWindowTiers: [{ id: "long", contextWindow: 128_000, label: "128K", apiModelSuffix: "" }],
		})

		fireEvent.click(screen.getByRole("button", { name: "Add Pricing Tier" }))
		expect(onPricingUpdate).toHaveBeenCalledWith({
			tiers: [{ contextWindow: 128_000, inputPrice: 0, outputPrice: 0, cacheWritesPrice: 0, cacheReadsPrice: 0 }],
		})
	})

	it("renders official tiers without add or remove controls", () => {
		render(
			<ModelConfiguration
				capabilities={
					{
						contextWindowTiers: [{ id: "standard", contextWindow: 272_000, label: "272K" }],
					} as unknown as ModelCapabilities
				}
				fields={{ capabilities: ["contextWindowTiers"] }}
				onCapabilitiesUpdate={vi.fn()}
				onPricingUpdate={vi.fn()}
				tiersEditable={false}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		expect(screen.getByText("standard")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Add Context Tier" })).toBeNull()
		expect(screen.queryByRole("button", { name: "Remove Context Tier" })).toBeNull()
	})

	it("shows registry default context and pricing tiers when no overrides exist", () => {
		const defaults: Partial<ModelInfo> = {
			capabilities: {
				contextWindowTiers: [{ id: "standard", contextWindow: 272_000, label: "272K" }],
			} as ModelCapabilities,
			pricing: {
				tiers: [{ contextWindow: 128_000, inputPrice: 1, outputPrice: 2 }],
			} as ModelPricing,
		}

		render(
			<ModelConfiguration
				defaults={defaults}
				fields={{ capabilities: ["contextWindowTiers"], pricing: ["pricingTiers"] }}
				onCapabilitiesUpdate={vi.fn()}
				onPricingUpdate={vi.fn()}
				tiersEditable={true}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		expect(screen.getByLabelText("Context Tier ID")).toHaveValue("standard")
		expect(screen.getByLabelText("Context Tier Window")).toHaveValue("272000")
		expect(screen.getByLabelText("Up To Input Tokens")).toHaveValue("128000")
		expect(screen.getByRole("button", { name: "Add Context Tier" })).toBeTruthy()
		expect(screen.getByRole("button", { name: "Add Pricing Tier" })).toBeTruthy()
	})

	it("does not restore registry pricing tiers after an explicit empty override", () => {
		render(
			<ModelConfiguration
				defaults={{
					pricing: {
						tiers: [{ contextWindow: 128_000, inputPrice: 1, outputPrice: 2 }],
					} as ModelPricing,
				}}
				fields={{ pricing: ["pricingTiers"] }}
				onCapabilitiesUpdate={vi.fn()}
				onPricingUpdate={vi.fn()}
				pricing={{ tiers: [] } as unknown as ModelPricing}
				pricingTiersEnabled={true}
				tiersEditable={true}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		expect(screen.queryByLabelText("Up To Input Tokens")).toBeNull()
		expect(screen.getByRole("button", { name: "Add Pricing Tier" })).toBeTruthy()
	})

	it("persists edits to registry default tiers as provider overrides", () => {
		const onCapabilitiesUpdate = vi.fn()
		const defaults: Partial<ModelInfo> = {
			capabilities: {
				contextWindowTiers: [{ id: "standard", contextWindow: 272_000, label: "272K" }],
			} as ModelCapabilities,
		}

		render(
			<ModelConfiguration
				defaults={defaults}
				fields={{ capabilities: ["contextWindowTiers"] }}
				onCapabilitiesUpdate={onCapabilitiesUpdate}
				onPricingUpdate={vi.fn()}
				tiersEditable={true}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		fireEvent.change(screen.getByLabelText("Context Tier ID"), { target: { value: "long" } })

		expect(onCapabilitiesUpdate).toHaveBeenCalledWith({
			contextWindowTiers: [{ id: "long", contextWindow: 272_000, label: "272K" }],
		})
	})

	it("writes checkbox changes to provider capabilities", () => {
		const onCapabilitiesUpdate = vi.fn()

		render(
			<ModelConfiguration
				capabilities={{ supportsImages: false } as ModelCapabilities}
				fields={{ capabilities: ["supportsImages"] }}
				onCapabilitiesUpdate={onCapabilitiesUpdate}
				onPricingUpdate={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		fireEvent.click(screen.getByLabelText("Supports Images"))

		expect(onCapabilitiesUpdate).toHaveBeenCalledWith({ supportsImages: true })
	})

	it("writes native tool support changes to provider capabilities", () => {
		const onCapabilitiesUpdate = vi.fn()

		render(
			<ModelConfiguration
				capabilities={{ supportsTools: false } as ModelCapabilities}
				fields={{ capabilities: ["supportsTools"] }}
				onCapabilitiesUpdate={onCapabilitiesUpdate}
				onPricingUpdate={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		fireEvent.click(screen.getByLabelText("Supports Native Tool Calls"))

		expect(onCapabilitiesUpdate).toHaveBeenCalledWith({ supportsTools: true })
	})

	it("turns the hosted Web Search switch off without touching the model declaration", () => {
		const onCapabilitiesUpdate = vi.fn()
		const onDisabledServerToolsUpdate = vi.fn()

		render(
			<ModelConfiguration
				defaults={{ capabilities: { tools: [ServerTool.WEB_SEARCH] } as ModelCapabilities }}
				fields={{ capabilities: ["hostedWebSearch"] }}
				onCapabilitiesUpdate={onCapabilitiesUpdate}
				onDisabledServerToolsUpdate={onDisabledServerToolsUpdate}
				onPricingUpdate={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		expect(screen.getByLabelText("Use hosted Web Search")).toBeChecked()
		fireEvent.click(screen.getByLabelText("Use hosted Web Search"))

		expect(onDisabledServerToolsUpdate).toHaveBeenCalledWith([ServerTool.WEB_SEARCH])
		expect(onCapabilitiesUpdate).not.toHaveBeenCalled()
	})

	it("switches hosted Web Fetch independently of hosted Web Search", () => {
		const onCapabilitiesUpdate = vi.fn()
		const onDisabledServerToolsUpdate = vi.fn()

		render(
			<ModelConfiguration
				defaults={{ capabilities: { tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH] } as ModelCapabilities }}
				disabledServerTools={[ServerTool.WEB_SEARCH]}
				fields={{ capabilities: ["hostedWebSearch", "hostedWebFetch"] }}
				onCapabilitiesUpdate={onCapabilitiesUpdate}
				onDisabledServerToolsUpdate={onDisabledServerToolsUpdate}
				onPricingUpdate={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		expect(screen.getByLabelText("Use hosted Web Search")).not.toBeChecked()
		expect(screen.getByLabelText("Use hosted Web Fetch")).toBeChecked()
		fireEvent.click(screen.getByLabelText("Use hosted Web Fetch"))

		expect(onDisabledServerToolsUpdate).toHaveBeenCalledWith([ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH])
		expect(onCapabilitiesUpdate).not.toHaveBeenCalled()
	})

	it("labels hosted Web Fetch as unavailable when the model does not declare it", () => {
		render(
			<ModelConfiguration
				defaults={{ capabilities: { tools: [ServerTool.WEB_SEARCH] } as ModelCapabilities }}
				fields={{ capabilities: ["hostedWebFetch"] }}
				onCapabilitiesUpdate={vi.fn()}
				onDisabledServerToolsUpdate={vi.fn()}
				onPricingUpdate={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		expect(screen.getByLabelText("Use hosted Web Fetch (not offered by this model)")).not.toBeChecked()
		expect(screen.queryByLabelText("Use hosted Web Fetch")).not.toBeInTheDocument()
	})

	it("re-enables a hosted tool by clearing it from the disable list", () => {
		const onDisabledServerToolsUpdate = vi.fn()

		render(
			<ModelConfiguration
				defaults={{ capabilities: { tools: [ServerTool.WEB_SEARCH] } as ModelCapabilities }}
				disabledServerTools={[ServerTool.WEB_SEARCH, ServerTool.CODE_EXECUTION]}
				fields={{ capabilities: ["hostedWebSearch"] }}
				onCapabilitiesUpdate={vi.fn()}
				onDisabledServerToolsUpdate={onDisabledServerToolsUpdate}
				onPricingUpdate={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		expect(screen.getByLabelText("Use hosted Web Search")).not.toBeChecked()
		fireEvent.click(screen.getByLabelText("Use hosted Web Search"))

		expect(onDisabledServerToolsUpdate).toHaveBeenCalledWith([ServerTool.CODE_EXECUTION])
	})

	it("disables the hosted switch when the model declares no hosted Web Search", () => {
		render(
			<ModelConfiguration
				defaults={{ capabilities: { tools: [] } as ModelCapabilities }}
				fields={{ capabilities: ["hostedWebSearch"] }}
				onCapabilitiesUpdate={vi.fn()}
				onDisabledServerToolsUpdate={vi.fn()}
				onPricingUpdate={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		// The label carries the reason; the toolkit checkbox does not upgrade under jsdom,
		// so its disabled state is not observable as a DOM attribute here.
		const control = screen.getByLabelText("Use hosted Web Search (not offered by this model)")
		expect(control).not.toBeChecked()
		expect(screen.queryByLabelText("Use hosted Web Search")).not.toBeInTheDocument()
	})

	it("saves Browser Actions and Images as independent capabilities", () => {
		const onCapabilitiesUpdate = vi.fn()

		render(
			<ModelConfiguration
				capabilities={{ supportsBrowserAction: false, supportsImages: false } as ModelCapabilities}
				fields={{ capabilities: ["supportsBrowserAction", "supportsImages"] }}
				onCapabilitiesUpdate={onCapabilitiesUpdate}
				onPricingUpdate={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		fireEvent.click(screen.getByLabelText("Supports Browser Actions"))
		fireEvent.click(screen.getByLabelText("Supports Images"))

		expect(onCapabilitiesUpdate).toHaveBeenNthCalledWith(1, { supportsBrowserAction: true })
		expect(onCapabilitiesUpdate).toHaveBeenNthCalledWith(2, { supportsImages: true })
	})

	it("inherits native tool support from the selected model defaults", () => {
		render(
			<ModelConfiguration
				defaults={{ capabilities: { supportsTools: true } as ModelCapabilities }}
				fields={{ capabilities: ["supportsTools"] }}
				onCapabilitiesUpdate={vi.fn()}
				onPricingUpdate={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))

		expect(screen.getByLabelText("Supports Native Tool Calls")).toBeChecked()
	})

	it("writes temperature changes to provider capabilities", () => {
		const onCapabilitiesUpdate = vi.fn()

		render(
			<ModelConfiguration
				capabilities={{ temperature: 0.1 } as ModelCapabilities}
				fields={{ capabilities: ["temperature"] }}
				onCapabilitiesUpdate={onCapabilitiesUpdate}
				onPricingUpdate={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		fireEvent.change(screen.getByLabelText("Temperature"), { target: { value: "0.7" } })

		expect(onCapabilitiesUpdate).toHaveBeenCalledWith({ temperature: 0.7 })
	})

	it("writes pricing changes to provider pricing", () => {
		const onPricingUpdate = vi.fn()

		render(
			<ModelConfiguration
				fields={{ pricing: ["inputPrice"] }}
				onCapabilitiesUpdate={vi.fn()}
				onPricingUpdate={onPricingUpdate}
				pricing={{ inputPrice: 1 } as ModelPricing}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		fireEvent.change(screen.getByLabelText(/Input Price/), { target: { value: "0.5" } })

		expect(onPricingUpdate).toHaveBeenCalledWith({ inputPrice: 0.5 })
	})

	it("places options with temperature before capabilities and pricing", () => {
		render(
			<ModelConfiguration
				capabilities={{ supportsPromptCache: true, temperature: 0.2 } as ModelCapabilities}
				fields={{
					capabilities: ["supportsImages", "supportsPromptCache", "temperature", "contextWindow", "maxTokens"],
					pricing: ["inputPrice", "outputPrice"],
				}}
				onCapabilitiesUpdate={vi.fn()}
				onPricingUpdate={vi.fn()}
				pricing={{ inputPrice: 1, outputPrice: 2 } as ModelPricing}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))

		const options = screen.getByText("Options")
		const temperature = screen.getByLabelText("Temperature")
		const capabilities = screen.getByText("Capabilities")
		const contextWindow = screen.getByLabelText("Context Window Size")
		const maxOutput = screen.getByLabelText("Max Output Tokens")
		const pricing = screen.getByText("Pricing")
		const inputPrice = screen.getByLabelText(/Input Price/)

		expect(options.compareDocumentPosition(temperature)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
		expect(temperature.compareDocumentPosition(capabilities)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
		expect(capabilities.compareDocumentPosition(contextWindow)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
		expect(contextWindow.compareDocumentPosition(maxOutput)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
		expect(maxOutput.compareDocumentPosition(pricing)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
		expect(pricing.compareDocumentPosition(inputPrice)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
	})

	it("hides cache pricing when prompt cache support is disabled", () => {
		render(
			<ModelConfiguration
				capabilities={{ supportsPromptCache: false } as ModelCapabilities}
				fields={{
					capabilities: ["supportsPromptCache"],
					pricing: ["inputPrice", "cacheWritesPrice", "cacheReadsPrice"],
				}}
				onCapabilitiesUpdate={vi.fn()}
				onPricingUpdate={vi.fn()}
				pricing={{ cacheReadsPrice: 0.1, cacheWritesPrice: 0.2, inputPrice: 1 } as ModelPricing}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))

		expect(screen.getByLabelText(/Input Price/)).toBeTruthy()
		expect(screen.queryByLabelText(/Cache Writes/)).toBeNull()
		expect(screen.queryByLabelText(/Cache Reads/)).toBeNull()
	})

	it("delegates context window edits to a provider-selected handler", () => {
		const onCapabilitiesUpdate = vi.fn()
		const onContextWindowUpdate = vi.fn()
		render(
			<ModelConfiguration
				capabilities={{ contextWindow: 128_000 } as ModelCapabilities}
				contextWindowValue={1_200_000}
				fields={{ capabilities: ["contextWindow"] }}
				onCapabilitiesUpdate={onCapabilitiesUpdate}
				onContextWindowUpdate={onContextWindowUpdate}
				onPricingUpdate={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))
		fireEvent.change(screen.getByLabelText("Context Window Size"), { target: { value: "1500000" } })

		expect(screen.getByLabelText("Context Window Size")).toHaveValue("1500000")
		expect(onContextWindowUpdate).toHaveBeenCalledWith(1_500_000)
		expect(onCapabilitiesUpdate).not.toHaveBeenCalled()
	})

	it("uses built-in defaults for context and max output", () => {
		render(
			<ModelConfiguration
				fields={{ capabilities: ["contextWindow", "maxTokens"] }}
				onCapabilitiesUpdate={vi.fn()}
				onPricingUpdate={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))

		expect(screen.getByLabelText("Context Window Size")).toHaveValue("128000")
		expect(screen.getByLabelText("Max Output Tokens")).toHaveValue("8192")
	})

	it("lets provider defaults override built-in context and max output", () => {
		const defaults: Partial<ModelInfo> = {
			capabilities: {
				contextWindow: 256_000,
				maxTokens: 16_384,
			} as ModelCapabilities,
		}

		render(
			<ModelConfiguration
				defaults={defaults}
				fields={{ capabilities: ["contextWindow", "maxTokens"] }}
				onCapabilitiesUpdate={vi.fn()}
				onPricingUpdate={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))

		expect(screen.getByLabelText("Context Window Size")).toHaveValue("256000")
		expect(screen.getByLabelText("Max Output Tokens")).toHaveValue("16384")
	})

	it("uses accessible VS Code settings hierarchy and responsive grids", () => {
		render(
			<ModelConfiguration
				capabilities={{ contextWindow: 128_000 } as ModelCapabilities}
				fields={{ capabilities: ["contextWindow"] }}
				onCapabilitiesUpdate={vi.fn()}
				onPricingUpdate={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Model Configuration/i }))

		const disclosure = screen.getByRole("button", { name: "Model Configuration" })
		expect(disclosure).toHaveClass("text-sm", "font-semibold")
		expect(screen.getByText("Capabilities")).toHaveClass("text-xs", "font-semibold")
		expect(screen.getByText("Context Window Size")).toHaveClass("text-sm", "font-medium")
		expect(screen.getByLabelText("Context Window Size").closest(".profile-field")?.parentElement).toHaveClass(
			"grid-cols-1",
			"xs:grid-cols-2",
		)
	})
})
