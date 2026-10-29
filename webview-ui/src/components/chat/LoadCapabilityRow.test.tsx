import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import LoadCapabilityRow from "./LoadCapabilityRow"

/**
 * Render a load capability row with a no-op expander.
 *
 * @param status Payload status to render.
 * @param isExpanded Whether the detail section is expanded.
 */
function renderRow(status: "loading" | "completed" | "failed", isExpanded = false): string {
    return renderToStaticMarkup(
        <LoadCapabilityRow
            isExpanded={isExpanded}
            onToggleExpand={() => undefined}
            payload={{
                tool: "loadCapability",
                kind: "skill",
                status,
                name: "review-code",
                source: "project",
                summary: status === "failed" ? undefined : "review-code: Review code safely",
                details: status === "completed" ? [{ label: "Source", value: "project" }] : undefined,
                body: status === "completed" ? "Follow every review step." : undefined,
                error: status === "failed" ? "Unknown or disabled skill 'review-code'." : undefined,
            }}
        />,
    )
}

describe("LoadCapabilityRow", () => {
    it("renders loading state with capability name", () => {
        const html = renderRow("loading")

        expect(html).toContain("Loading Skill")
        expect(html).toContain("review-code")
    })

    it("renders expanded completed details and body", () => {
        const html = renderRow("completed", true)

        expect(html).toContain("Loaded Skill")
        expect(html).toContain("review-code: Review code safely")
        expect(html).toContain("Source")
        expect(html).toContain("Follow every review step.")
        expect(html).toContain("max-h-[60vh]")
        expect(html).toContain("overflow-y-auto")
        expect(html).toContain("overscroll-x-contain")
    })

    it("renders failed state with clear error", () => {
        const html = renderRow("failed")

        expect(html).toContain("Failed to load Skill")
        expect(html).toContain("Unknown or disabled skill &#x27;review-code&#x27;.")
    })
})
