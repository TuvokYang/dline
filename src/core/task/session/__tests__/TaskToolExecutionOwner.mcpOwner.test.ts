import type { McpServer } from "@shared/mcp"
import { emptyTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { describe, expect, it, vi } from "vitest"
import type { TaskConfig } from "../../tools/types/TaskConfig"
import { TaskToolExecutionOwner, type TaskToolExecutionOwnerOptions } from "../TaskToolExecutionOwner"

function owner(getMcpServersForOwner?: TaskConfig["getMcpServersForOwner"]) {
    const api = {
        getProviderId: () => "anthropic",
        getModel: () => ({ id: "test-model", info: { capabilities: { contextWindow: 200_000 } } }),
    }
    return new TaskToolExecutionOwner({
        taskId: "task-id",
        taskIncarnationId: "incarnation-id",
        cwd: "/workspace",
        stateManager: { getGlobalSettingsKey: () => false, getCanonicalSettingsKey: () => false, getGlobalStateKey: () => false },
        settings: { mode: "act" },
        api: { current: () => api },
        services: {
            mcpHub: {
                getServers: () => {
                    throw new Error("Unscoped MCP discovery is forbidden")
                },
            },
        },
        readState: () => ({ turn: { blocks: [] } }),
        readTurnAuthority: () => undefined,
        readCapabilityToggles: emptyTaskCapabilityToggles,
        getMcpServersForOwner,
        usesNativeToolCalls: () => false,
    } as unknown as TaskToolExecutionOwnerOptions)
}

describe("TaskToolExecutionOwner MCP owner-bound port", () => {
    it("forwards the existing host closure without resolving a new owner or freezing its live view", () => {
        let visible: McpServer[] = [{ name: "docs@owner-a", config: "{}", status: "connected" }]
        const getMcpServersForOwner = vi.fn(() => visible)
        const execution = owner(getMcpServersForOwner)
        const first = execution.create({ coordinator: {} as TaskConfig["coordinator"] })
        const second = execution.create({ coordinator: {} as TaskConfig["coordinator"] })

        expect(first.getMcpServersForOwner).toBe(getMcpServersForOwner)
        expect(second.getMcpServersForOwner).toBe(getMcpServersForOwner)
        expect(getMcpServersForOwner).not.toHaveBeenCalled()
        expect(first.getMcpServersForOwner?.()).toEqual(visible)
        visible = []
        expect(first.getMcpServersForOwner?.()).toEqual([])
        expect(second.getMcpServersForOwner?.()).toEqual([])
    })

    it("keeps an absent port absent instead of falling back to taskId, ulid, cwd or Hub.getServers", () => {
        const config = owner().create({ coordinator: {} as TaskConfig["coordinator"] })
        expect(config.getMcpServersForOwner).toBeUndefined()
        expect(config.subagentCapabilitySelection).toBeUndefined()
        expect(config.isSubagentExecution).toBe(false)
    })
})
