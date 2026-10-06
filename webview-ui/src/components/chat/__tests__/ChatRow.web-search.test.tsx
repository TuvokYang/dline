import { fireEvent, render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { ChatRowContent } from "../ChatRow"

void React

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		backgroundEditEnabled: true,
		mcpServers: [],
		mcpMarketplaceCatalog: [],
		onRelinquishControl: () => () => undefined,
		vscodeTerminalExecutionMode: "backgroundExec",
		clineMessages: [],
		showFeatureTips: false,
		taskViewState: undefined,
		currentTaskItem: { id: "task-1" },
	}),
}))

const baseProps = {
	isExpanded: false,
	isLast: true,
	onSetQuote: vi.fn(),
	onToggleExpand: vi.fn(),
}

describe("ChatRow hosted Web Search rendering", () => {
	it("does not render a duplicate external icon on the Web Search card", () => {
		const { container } = render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 1,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "webSearch",
						path: "Dline web search",
						content: "Searching for: Dline web search",
						operationIsLocatedInWorkspace: false,
						webSearch: {
							schemaVersion: 1,
							status: "completed",
							source: {
								id: "deepseek-hosted",
								label: "DeepSeek Web Search",
								execution: "hosted",
								provider: "deepseek",
							},
							query: "Dline web search",
							items: [
								{
									title: "Dline result",
									url: "https://example.com/dline",
									snippet: "Provider-compressed search result",
								},
							],
						},
					}),
				}}
			/>,
		)

		expect(container.querySelector(".codicon-sign-out")).toBeNull()
	})

	it("renders the actual source and provider-compressed results", () => {
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 1,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "webSearch",
						path: "Dline web search",
						content: "Searching for: Dline web search",
						operationIsLocatedInWorkspace: false,
						webSearch: {
							schemaVersion: 1,
							status: "completed",
							source: {
								id: "deepseek-hosted",
								label: "DeepSeek Web Search",
								execution: "hosted",
								provider: "deepseek",
							},
							query: "Dline web search",
							items: [
								{
									title: "Dline result",
									url: "https://example.com/dline",
									snippet: "Provider-compressed search result",
								},
							],
						},
					}),
				}}
			/>,
		)

		expect(screen.getByText("DeepSeek Web Search (Hosted)")).toBeInTheDocument()
		const toggle = screen.getByTestId("web-search-details-toggle")
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByTestId("web-search-results")).not.toBeInTheDocument()
		expect(screen.queryByText("Dline result")).not.toBeInTheDocument()

		fireEvent.click(toggle)

		expect(toggle).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByText("Dline result")).toBeInTheDocument()
		expect(screen.getByText("https://example.com/dline")).toBeInTheDocument()
		expect(screen.getByText("Provider-compressed search result")).toBeInTheDocument()
		expect(screen.getByTestId("web-search-card")).toHaveClass("max-h-[40vh]", "overflow-hidden")
		expect(screen.getByTestId("web-search-card")).not.toHaveClass("overflow-y-auto")
		expect(screen.getByTestId("web-search-results")).toHaveClass("overflow-y-auto")
	})

	it("renders all normalized search queries instead of the generic hosted placeholder", () => {
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 5,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "webSearch",
						path: "Provider-hosted web search",
						webSearch: {
							schemaVersion: 1,
							status: "completed",
							operation: {
								type: "search",
								queries: ["Dline hosted search", "OpenAI Responses"],
							},
						},
					}),
				}}
			/>,
		)

		expect(screen.getByText("Dline searched the web for:")).toBeInTheDocument()
		expect(screen.getByText("Dline hosted search")).toBeInTheDocument()
		expect(screen.getByText("OpenAI Responses")).toBeInTheDocument()
		expect(screen.queryByText("Provider-hosted web search")).not.toBeInTheDocument()
	})

	it("renders open_page with its actual URL and operation-specific title", () => {
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 6,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "webSearch",
						path: "Provider-hosted web search",
						webSearch: {
							schemaVersion: 1,
							status: "completed",
							operation: {
								type: "open_page",
								url: "https://example.com/current",
							},
						},
					}),
				}}
			/>,
		)

		expect(screen.getByText("Dline opened a web page:")).toBeInTheDocument()
		expect(screen.getByText("https://example.com/current")).toBeInTheDocument()
		expect(screen.queryByText("Provider-hosted web search")).not.toBeInTheDocument()
	})

	it("renders find_in_page with its URL, pattern, and operation-specific title", () => {
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 7,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "webSearch",
						path: "Provider-hosted web search",
						webSearch: {
							schemaVersion: 1,
							status: "completed",
							operation: {
								type: "find_in_page",
								url: "https://example.com/docs",
								pattern: "hosted search action",
							},
						},
					}),
				}}
			/>,
		)

		expect(screen.getByText("Dline searched within a web page:")).toBeInTheDocument()
		expect(screen.getByText("https://example.com/docs")).toBeInTheDocument()
		expect(screen.getByText("hosted search action")).toBeInTheDocument()
		expect(screen.queryByText("Provider-hosted web search")).not.toBeInTheDocument()
	})

	it("falls back to the legacy query when a persisted message has no operation", () => {
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 8,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "webSearch",
						path: "legacy path",
						webSearch: {
							schemaVersion: 1,
							status: "completed",
							query: "legacy persisted query",
						},
					}),
				}}
			/>,
		)

		expect(screen.getByText("Dline searched the web for:")).toBeInTheDocument()
		expect(screen.getByText("legacy persisted query")).toBeInTheDocument()
	})

	it("renders URL-only hosted sources with a readable fallback title", () => {
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 3,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "webSearch",
						path: "URL only",
						webSearch: {
							schemaVersion: 1,
							status: "completed",
							query: "URL only",
							items: [{ url: "https://docs.example.com/current" }],
						},
					}),
				}}
			/>,
		)

		fireEvent.click(screen.getByTestId("web-search-details-toggle"))
		expect(screen.getByText("docs.example.com")).toBeInTheDocument()
		expect(screen.getByText("https://docs.example.com/current")).toBeInTheDocument()
	})

	it("renders the hosted source and routing failure", () => {
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 2,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "webSearch",
						path: "current OpenAI news",
						webSearch: {
							schemaVersion: 1,
							status: "failed",
							source: {
								id: "openai-hosted",
								label: "OpenAI Web Search",
								execution: "hosted",
								provider: "openai",
							},
							query: "current OpenAI news",
							error: "OpenAI hosted Web Search returned a local function call; falling back to Dline local Web Search.",
						},
					}),
				}}
			/>,
		)

		expect(screen.getByText("OpenAI Web Search (Hosted)")).toBeInTheDocument()
		expect(
			screen.getByText("OpenAI hosted Web Search returned a local function call; falling back to Dline local Web Search."),
		).toBeInTheDocument()
	})

	it("renders the selected Dline engine and actionable error", () => {
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 2,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "webSearch",
						path: "Dline timeout",
						webSearch: {
							schemaVersion: 1,
							status: "failed",
							source: { id: "bing", label: "Browser / Bing", execution: "dline" },
							query: "Dline timeout",
							error: "Browser / Bing search failed: navigation timed out",
						},
					}),
				}}
			/>,
		)

		expect(screen.getByText("Browser / Bing (Dline)")).toBeInTheDocument()
		expect(screen.getByText("Browser / Bing search failed: navigation timed out")).toBeInTheDocument()
	})

	it("renders the complete URL in a pending Web Fetch approval", () => {
		const url = "https://example.com/a/long/path/to/current/api/documentation"
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 3,
					type: "ask",
					ask: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "webFetch",
						path: url,
						webFetch: {
							schemaVersion: 1,
							status: "running",
							url,
							prompt: "Read the current API documentation",
						},
					}),
				}}
			/>,
		)

		const link = screen.getByRole("button", { name: url })
		expect(link).toHaveTextContent(url)
		expect(link.firstElementChild).toHaveClass("break-all", "text-left", "[direction:ltr]")
	})

	it("renders completed Web Fetch content in a 40vh scroll container", () => {
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 4,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "webFetch",
						path: "https://example.com/docs",
						webFetch: {
							schemaVersion: 1,
							status: "completed",
							source: { id: "browser", label: "Browser Web Fetch", execution: "dline" },
							url: "https://example.com/docs",
							prompt: "Extract the current docs",
							content: "# Current docs\n\nFetched content marker",
						},
					}),
				}}
			/>,
		)

		expect(screen.getByText("Browser Web Fetch (Dline)")).toBeInTheDocument()
		const toggle = screen.getByTestId("web-fetch-details-toggle")
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByTestId("web-fetch-results")).not.toBeInTheDocument()
		expect(screen.queryByText("Fetched content marker", { exact: false })).not.toBeInTheDocument()

		fireEvent.click(toggle)

		expect(toggle).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByText("Fetched content marker", { exact: false })).toBeInTheDocument()
		expect(screen.getByTestId("web-fetch-card")).toHaveClass("max-h-[40vh]", "overflow-y-auto")
		expect(screen.getByTestId("web-fetch-results")).not.toHaveClass("max-h-[40vh]", "overflow-y-auto")
	})

	it("explains that a deferred hosted search waits for the next request", () => {
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 8,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "webSearch",
						path: "deferred search",
						webSearch: {
							schemaVersion: 1,
							status: "deferred",
							source: { id: "anthropic-hosted", label: "Anthropic Web Search", execution: "hosted" },
							query: "deferred search",
							hostedCall: { functionId: "srvtoolu_deferred", traceId: "trace-search" },
						},
					}),
				}}
			/>,
		)

		const notice = screen.getByTestId("web-search-deferred")
		expect(notice).toHaveTextContent("Waiting for the local tool results")
		expect(notice).toHaveTextContent("next request")
		expect(screen.getByText("deferred search")).toBeInTheDocument()
		expect(screen.getByTestId("web-search-card").querySelector(".animate-spin")).toBeNull()
	})

	it("explains that a deferred hosted fetch waits for the next request", () => {
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 9,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "webFetch",
						path: "https://example.com/deferred",
						webFetch: {
							schemaVersion: 1,
							status: "deferred",
							source: { id: "anthropic-hosted", label: "Anthropic Web Fetch", execution: "hosted" },
							url: "https://example.com/deferred",
							hostedCall: { functionId: "srvtoolu_fetch", traceId: "trace-fetch" },
						},
					}),
				}}
			/>,
		)

		const notice = screen.getByTestId("web-fetch-deferred")
		expect(notice).toHaveTextContent("Waiting for the local tool results")
		expect(notice).toHaveTextContent("next request")
		expect(screen.getByTestId("web-fetch-card").querySelector(".animate-spin")).toBeNull()
	})

	it("does not show the deferral notice once the hosted search completes", () => {
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 10,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "webSearch",
						path: "deferred search",
						webSearch: {
							schemaVersion: 1,
							status: "completed",
							query: "deferred search",
							hostedCall: { functionId: "srvtoolu_deferred", traceId: "trace-search" },
						},
					}),
				}}
			/>,
		)

		expect(screen.queryByTestId("web-search-deferred")).not.toBeInTheDocument()
	})
})
