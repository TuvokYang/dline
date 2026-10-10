import { describe, expect, it } from "vitest"
import { capabilityInventoryFrom } from "../input-semantic-catalog"

describe("capabilityInventoryFrom", () => {
    it("keeps only the sections that carry a capability identity", () => {
        const inventory = capabilityInventoryFrom(
            [
                { name: "compact", section: "default" },
                { name: "release", section: "workflow" },
                { name: "use-e2e", section: "skill" },
                { name: "status", section: "cli" },
            ],
            [],
        )

        expect(inventory.workflows).toEqual(["release"])
        expect(inventory.skills).toEqual(["use-e2e"])
    })

    it("addresses an MCP prompt by server and prompt identity", () => {
        const inventory = capabilityInventoryFrom(
            [],
            [{ name: "docs", prompts: [{ name: "search" }, { name: "summarize" }] }, { name: "silent" }],
        )

        expect(inventory.mcpPrompts).toEqual([
            { server: "docs", prompt: "search" },
            { server: "docs", prompt: "summarize" },
        ])
    })
})
