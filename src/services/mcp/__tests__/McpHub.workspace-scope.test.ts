import type { McpServer } from "@shared/mcp"
import { describe, expect, it } from "vitest"
import { McpHub } from "../McpHub"

function server(name: string, source: McpServer["source"], disabled = false): McpServer {
    return {
        name,
        config: JSON.stringify({ type: "stdio", command: "node" }),
        status: disabled ? "disconnected" : "connected",
        disabled,
        source,
    }
}

function createScopedHub(): McpHub {
    const hub = Object.create(McpHub.prototype) as McpHub
    ;(hub as any).connections = [
        { server: server("global-docs", "settings"), client: {}, transport: {} },
        { server: server("alpha-docs@aaaaaaaa", "workspace"), client: {}, transport: {} },
        { server: server("beta-docs@bbbbbbbb", "workspace"), client: {}, transport: {} },
        { server: server("alpha-disabled@aaaaaaaa", "workspace", true), client: {}, transport: {} },
        { server: server("global-disabled", "settings", true), client: {}, transport: {} },
    ]
    ;(hub as any).workspaceMcpRegistry = {
        getDescriptorsForOwner(ownerId: string) {
            return ownerId === "alpha"
                ? [{ internalName: "alpha-docs@aaaaaaaa" }, { internalName: "alpha-disabled@aaaaaaaa" }]
                : ownerId === "beta"
                  ? [{ internalName: "beta-docs@bbbbbbbb" }]
                  : []
        },
    }
    return hub
}

describe("McpHub workspace ownership", () => {
    it("returns settings servers plus only the owner's workspace servers", () => {
        const hub = createScopedHub()

        expect(hub.getServersForOwner("alpha").map((entry) => entry.name)).toEqual(["global-docs", "alpha-docs@aaaaaaaa"])
        expect(hub.getServersForOwner("beta").map((entry) => entry.name)).toEqual(["global-docs", "beta-docs@bbbbbbbb"])
    })

    it("does not expose any workspace server to an unregistered owner", () => {
        const hub = createScopedHub()
        expect(hub.getServersForOwner("unknown").map((entry) => entry.name)).toEqual(["global-docs"])
    })

    it("returns disabled workspace servers when building capability defaults", () => {
        const hub = createScopedHub()

        expect(hub.getAllServersForOwner("alpha").map((entry) => [entry.name, entry.disabled])).toEqual([
            ["global-docs", false],
            ["alpha-docs@aaaaaaaa", false],
            ["alpha-disabled@aaaaaaaa", true],
            ["global-disabled", true],
        ])
    })
})
