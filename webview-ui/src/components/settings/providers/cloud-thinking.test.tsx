// @vitest-environment jsdom
import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiProfile } from "@shared/proto/dline/profile"
import { fireEvent, render, screen } from "@testing-library/react"
import type { AnchorHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react"
import { describe, expect, it, vi } from "vitest"
import { BedrockProvider } from "./BedrockProvider"
import { GeminiProvider } from "./GeminiProvider"
import { VercelAIGatewayProvider } from "./VercelAIGatewayProvider"
import { VertexProvider } from "./VertexProvider"

const models: Record<string, ModelInfo> = {
	"effort-alias": {
		id: "effort-alias",
		capabilities: {
			thinking: {
				supported: true,
				mode: "effort",
				effortLevels: ["low"],
				defaultEffort: "low",
				defaultEnabled: true,
				canDisable: false,
			},
		},
	},
	"budget-alias": {
		id: "budget-alias",
		capabilities: { thinking: { supported: true, mode: "budget", maxBudget: 3000, defaultEnabled: true } },
	},
}

vi.mock("./useProviderModels", () => ({
	useProviderModels: () => ({ models, defaultModelId: "effort-alias", modelInfoSaneDefaults: models["effort-alias"] }),
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ remoteConfigSettings: {} }) }))
vi.mock("../ApiOptions", () => ({
	DROPDOWN_Z_INDEX: 1000,
	DropdownContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("../common/ModelSelector", () => ({
	DropdownContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	ModelSelector: ({ onChange }: { onChange: React.ChangeEventHandler<HTMLInputElement> }) => (
		<input aria-label="Model" onChange={onChange} />
	),
}))
vi.mock("../common/ModelInfoView", () => ({
	ModelInfoView: ({ modelInfo }: { modelInfo: ModelInfo }) => <span data-testid="model-id">{modelInfo.id}</span>,
}))
vi.mock("../common/DebouncedTextField", () => ({ DebouncedTextField: () => <div /> }))
vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => <div /> }))
vi.mock("../common/BaseUrlField", () => ({ BaseUrlField: () => <div /> }))
vi.mock("../common/RemotelyConfiguredInputWrapper", () => ({
	RemotelyConfiguredInputWrapper: ({ children }: { children: ReactNode }) => <>{children}</>,
	LockIcon: () => <span />,
}))
vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
	TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
	TooltipContent: () => null,
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ checked, disabled, onChange, children }: InputHTMLAttributes<HTMLInputElement>) => (
		<label>
			<input checked={checked} disabled={disabled} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
	VSCodeDropdown: (props: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
	VSCodeOption: ({ children, value }: { children: ReactNode; value: string }) => <option value={value}>{children}</option>,
	VSCodeRadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	VSCodeRadio: ({ children }: { children: ReactNode }) => <span>{children}</span>,
	VSCodeTextField: ({ children: _children, ...props }: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
	VSCodeLink: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}))

for (const [provider, configKey, Panel] of [
	["vertex", "vertex", VertexProvider],
	["bedrock", "bedrock", BedrockProvider],
	["gemini", "gemini", GeminiProvider],
	["vercel-ai-gateway", "vercelAiGateway", VercelAIGatewayProvider],
] as const) {
	describe(`${provider} thinking controls`, () => {
		it("uses an opaque model's declared effort, default and disable constraint", () => {
			const profile = ApiProfile.create({ provider, modelId: "effort-alias" })
			render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
			const checkbox = screen.getByRole("checkbox", { name: "Enable Thinking" })
			expect(checkbox).toBeChecked()
			expect(checkbox).toBeDisabled()
			expect(screen.getAllByRole("combobox").filter((item) => item.textContent === "Low")).toHaveLength(1)
			expect(screen.queryByRole("slider")).not.toBeInTheDocument()
		})

		it("does not authorize thinking from a known-looking name, stale metadata or a preference", () => {
			const profile = ApiProfile.create({
				provider,
				modelId: "claude-opus-4-7-unknown",
				modelInfo: models["effort-alias"],
				[configKey]: { reasoning: { enableThinking: true, effort: "high", thinkingBudget: 2000 } },
			})
			render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
			expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
			expect(screen.getByTestId("model-id")).toHaveTextContent("claude-opus-4-7-unknown")
		})

		it("honors an explicit false capability override", () => {
			const profile = ApiProfile.create({
				provider,
				modelId: "effort-alias",
				[configKey]: { capabilities: { thinking: { supported: false } } },
			})
			render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
			expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
		})

		it("uses the effective minimum override rather than a provider constant", () => {
			const onUpdate = vi.fn()
			const profile = ApiProfile.create({
				provider,
				modelId: "budget-alias",
				[configKey]: { capabilities: { thinking: { minBudget: 17 } }, reasoning: { thinkingBudget: 1500 } },
			})
			render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
			const slider = screen.getByRole("slider")
			expect(slider).toHaveAttribute("min", "17")
			fireEvent.change(slider, { target: { value: "3" } })
			fireEvent.mouseUp(slider)
			expect(onUpdate.mock.calls[0][0][configKey].reasoning.thinkingBudget).toBe(17)
		})

		it("persists a bounded budget edit with the existing display preference", () => {
			const onUpdate = vi.fn()
			const profile = ApiProfile.create({
				provider,
				modelId: "budget-alias",
				[configKey]: { reasoning: { thinkingBudget: 1500, display: "omitted" } },
			})
			render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
			const slider = screen.getByRole("slider")
			expect(slider).toHaveAttribute("max", "3000")
			fireEvent.change(slider, { target: { value: "2400" } })
			fireEvent.mouseUp(slider)
			expect(onUpdate).toHaveBeenCalledWith({
				[configKey]: {
					...profile[configKey],
					reasoning: { enableThinking: true, effort: undefined, thinkingBudget: 2400, display: "omitted" },
				},
			})
		})
	})
}

describe("Bedrock custom base thinking", () => {
	it("uses only the explicitly selected base declaration while preserving the custom ARN", () => {
		const profile = ApiProfile.create({
			provider: "bedrock",
			modelId: "arn:custom",
			bedrock: { awsBedrockCustomSelected: true, awsBedrockCustomModelBaseId: "effort-alias" },
		})
		render(<BedrockProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
		expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeDisabled()
		expect(screen.getByTestId("model-id")).toHaveTextContent("arn:custom")
	})

	it("does not borrow the provider default for an unknown explicit base", () => {
		const profile = ApiProfile.create({
			provider: "bedrock",
			modelId: "arn:custom",
			bedrock: { awsBedrockCustomSelected: true, awsBedrockCustomModelBaseId: "unknown-base" },
		})
		render(<BedrockProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
		expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
	})
})
