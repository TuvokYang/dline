import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { describe, expect, it, vi } from "vitest"
import { TaskCapabilityMutationCoordinator } from "./TaskCapabilityMutationCoordinator"

describe("TaskCapabilityMutationCoordinator", () => {
    it("serializes and merges deltas submitted by independent consumers for the same task", async () => {
        const coordinator = new TaskCapabilityMutationCoordinator()
        const initial = createTaskCapabilityToggles({
            localSubagentsToggles: { agent: false },
            mcpServers: { docs: false },
        })
        let releaseFirst: (() => void) | undefined
        const persist = vi
            .fn<(snapshot: typeof initial) => Promise<void>>()
            .mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        releaseFirst = resolve
                    }),
            )
            .mockResolvedValueOnce(undefined)
        const publish = vi.fn()

        const first = coordinator.updateToggle({
            taskId: "task-1",
            authoritative: initial,
            authoritativeRevision: 1,
            key: "localSubagentsToggles",
            resourceId: "agent",
            enabled: true,
            persist,
            publish,
        })
        const second = coordinator.updateToggle({
            taskId: "task-1",
            authoritative: initial,
            authoritativeRevision: 1,
            key: "mcpServers",
            resourceId: "docs",
            enabled: true,
            persist,
            publish,
        })

        await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
        expect(persist.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                localSubagentsToggles: { agent: true },
                mcpServers: { docs: false },
            }),
        )

        releaseFirst?.()
        await first
        await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2))
        expect(persist.mock.calls[1][0]).toEqual(
            expect.objectContaining({
                localSubagentsToggles: { agent: true },
                mcpServers: { docs: true },
            }),
        )
        await second
        expect(coordinator.getSnapshot("task-1")).toEqual(
            expect.objectContaining({
                localSubagentsToggles: { agent: true },
                mcpServers: { docs: true },
            }),
        )
    })
})
