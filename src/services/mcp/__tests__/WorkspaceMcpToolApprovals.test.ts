import type { StateManager } from "@core/storage/StateManager"
import { describe, expect, it } from "vitest"
import { WorkspaceMcpToolApprovals, workspaceDescriptorFingerprint } from "../WorkspaceMcpToolApprovals"

/** Workspace settings document stand-in with the scoped read/mutate contract StateManager exposes. */
function workspaceSettings(hasWorkspaceScope = true) {
    const values: Record<string, unknown> = {}
    const stateManager = {
        hasWorkspaceScope,
        getScopedCapabilityToggles: (scope: string, key: string) => {
            expect(scope).toBe("workspace")
            return values[key] ?? {}
        },
        mutateScopedCapabilityToggles: async (scope: string, key: string, resolve: (current: unknown) => unknown) => {
            expect(scope).toBe("workspace")
            values[key] = resolve(values[key] ?? {})
            return values[key]
        },
    } as unknown as StateManager
    return { values, approvals: new WorkspaceMcpToolApprovals(() => stateManager) }
}

const SERVER = "security-ops@a1b2c3d4"
const DESCRIPTOR = { type: "streamableHttp", url: "http://127.0.0.1:8050/mcp", autoApprove: [] }

describe("WorkspaceMcpToolApprovals", () => {
    it("approves nothing until the user grants it", () => {
        const { approvals } = workspaceSettings()

        expect(approvals.isApproved(SERVER, workspaceDescriptorFingerprint(DESCRIPTOR), "bans_list")).toBe(false)
    })

    it("approves exactly the granted tools and keeps the grant in workspace settings", async () => {
        const { approvals, values } = workspaceSettings()
        const fingerprint = workspaceDescriptorFingerprint(DESCRIPTOR)

        await approvals.update(SERVER, fingerprint, ["bans_list", "ban_history"], true)

        expect(approvals.isApproved(SERVER, fingerprint, "bans_list")).toBe(true)
        expect(approvals.isApproved(SERVER, fingerprint, "ban_history")).toBe(true)
        expect(approvals.isApproved(SERVER, fingerprint, "monitor_summary")).toBe(false)
        expect(approvals.isApproved("other@a1b2c3d4", fingerprint, "bans_list")).toBe(false)
        expect(values.workspaceMcpToolAutoApprove).toEqual({
            [SERVER]: { fingerprint, tools: ["ban_history", "bans_list"] },
        })
    })

    it("withdraws a tool and drops the server entry once no tool is approved", async () => {
        const { approvals, values } = workspaceSettings()
        const fingerprint = workspaceDescriptorFingerprint(DESCRIPTOR)
        await approvals.update(SERVER, fingerprint, ["bans_list", "ban_history"], true)

        await approvals.update(SERVER, fingerprint, ["bans_list"], false)
        expect(approvals.isApproved(SERVER, fingerprint, "bans_list")).toBe(false)
        expect(approvals.isApproved(SERVER, fingerprint, "ban_history")).toBe(true)

        await approvals.update(SERVER, fingerprint, ["ban_history"], false)
        expect(values.workspaceMcpToolAutoApprove).toEqual({})
    })

    it("does not carry a grant over to an edited descriptor", async () => {
        const { approvals } = workspaceSettings()
        const original = workspaceDescriptorFingerprint(DESCRIPTOR)
        const edited = workspaceDescriptorFingerprint({ ...DESCRIPTOR, url: "http://attacker.example/mcp" })
        await approvals.update(SERVER, original, ["bans_list", "ban_history"], true)

        expect(approvals.isApproved(SERVER, edited, "bans_list")).toBe(false)

        // Granting under the edited descriptor starts from nothing instead of reviving the old grant.
        await approvals.update(SERVER, edited, ["monitor_summary"], true)
        expect(approvals.isApproved(SERVER, edited, "monitor_summary")).toBe(true)
        expect(approvals.isApproved(SERVER, edited, "ban_history")).toBe(false)
        expect(approvals.isApproved(SERVER, original, "ban_history")).toBe(false)
    })

    it("fingerprints descriptor content independently of key order", () => {
        expect(workspaceDescriptorFingerprint({ url: "u", type: "sse" })).toBe(
            workspaceDescriptorFingerprint({ type: "sse", url: "u" }),
        )
    })

    it("approves nothing without an open workspace", () => {
        const { approvals } = workspaceSettings(false)

        expect(approvals.isApproved(SERVER, workspaceDescriptorFingerprint(DESCRIPTOR), "bans_list")).toBe(false)
    })
})
