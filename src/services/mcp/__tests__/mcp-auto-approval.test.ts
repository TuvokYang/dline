import { describe, expect, it } from "vitest"
import { isMcpToolAutoApproved, resolveMcpToolAutoApprove, updateMcpToolAutoApproveConfig } from "../mcp-auto-approval"

describe("MCP tool auto-approval policy", () => {
    it("uses the global MCP switch as a hard gate", () => {
        expect(isMcpToolAutoApproved({ forceApprove: false, globalEnabled: false, toolEnabled: true })).toBe(false)
        expect(isMcpToolAutoApproved({ forceApprove: false, globalEnabled: true, toolEnabled: false })).toBe(false)
        expect(isMcpToolAutoApproved({ forceApprove: false, globalEnabled: true, toolEnabled: true })).toBe(true)
    })

    it("lets YOLO or Auto Approve All override both gates", () => {
        expect(isMcpToolAutoApproved({ forceApprove: true, globalEnabled: false, toolEnabled: false })).toBe(true)
    })
})

describe("MCP tool auto-approval configuration", () => {
    const toolNames = ["search", "fetch"]

    it("defaults new configurations to auto-approve every tool", () => {
        expect(resolveMcpToolAutoApprove({}, "search")).toBe(true)
        expect(resolveMcpToolAutoApprove({}, "fetch")).toBe(true)
    })

    it("interprets the legacy autoApprove allowlist without expanding authorization", () => {
        const config = { autoApprove: ["search"] }
        expect(resolveMcpToolAutoApprove(config, "search")).toBe(true)
        expect(resolveMcpToolAutoApprove(config, "fetch")).toBe(false)
    })

    it("uses disabledAutoApprove as the new per-tool deny list", () => {
        const config = { disabledAutoApprove: ["fetch"] }
        expect(resolveMcpToolAutoApprove(config, "search")).toBe(true)
        expect(resolveMcpToolAutoApprove(config, "fetch")).toBe(false)
    })

    it("migrates a legacy allowlist before changing one tool", () => {
        const updated = updateMcpToolAutoApproveConfig({ autoApprove: ["search"] }, ["search"], false, toolNames)
        expect(updated).toEqual({ disabledAutoApprove: ["fetch", "search"] })
    })

    it("records only explicit disables for new configurations", () => {
        const updated = updateMcpToolAutoApproveConfig({}, ["fetch"], false, toolNames)
        expect(updated).toEqual({ disabledAutoApprove: ["fetch"] })
    })
})
