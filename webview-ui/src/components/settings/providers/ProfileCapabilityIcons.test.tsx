import { type ModelCapabilities, ServerTool } from "@shared/proto/dline/models/metadata"
import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ProfileCapabilityIcons } from "./ProfileCapabilityIcons"
import { ProfileUsageBadges } from "./ProfileUsageBadges"

describe("Profile summary indicators", () => {
	it("renders capabilities in a stable right-aligned order", () => {
		render(
			<ProfileCapabilityIcons
				capabilities={
					{
						supportsReasoning: true,
						supportsImages: true,
						supportsPromptCache: true,
						supportsBrowserAction: true,
						tools: [ServerTool.WEB_SEARCH],
					} as ModelCapabilities
				}
			/>,
		)

		const group = screen.getByRole("list", { name: "Model capabilities" })
		expect(group).toHaveClass("justify-end", "shrink-0")
		const items = within(group).getAllByRole("listitem")
		expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
			"Reasoning",
			"Image input",
			"Prompt cache",
			"Browser actions",
			"Web search",
		])
		expect(group.querySelectorAll("svg")).toHaveLength(5)
		expect(group.querySelector("[style*='mask']")).not.toBeInTheDocument()
		for (const iconContainer of group.querySelectorAll("li > span")) expect(iconContainer).toHaveClass("size-5")
	})

	it("shows hosted Web Fetch as its own capability", () => {
		render(
			<ProfileCapabilityIcons
				capabilities={{ tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH] } as ModelCapabilities}
			/>,
		)
		expect(screen.getByLabelText("Web search")).toBeInTheDocument()
		expect(screen.getByLabelText("Web fetch")).toBeInTheDocument()
	})

	it("omits capabilities that are false or unknown", () => {
		render(<ProfileCapabilityIcons capabilities={{ supportsImages: true } as ModelCapabilities} />)
		expect(screen.getByLabelText("Image input")).toBeInTheDocument()
		expect(screen.queryByLabelText("Reasoning")).not.toBeInTheDocument()
	})

	it("renders profile uses in canonical order", () => {
		render(<ProfileUsageBadges usedFor={["subagents", "act", "plan"]} />)
		const uses = screen.getByRole("group", { name: "Profile uses" })
		expect(uses).toHaveClass("justify-end", "shrink-0")
		expect(uses).toHaveTextContent("ACTPLANSUB")
	})
})
