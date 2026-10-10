import { createTaskCapabilityToggles, parseTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    state: {} as Record<string, unknown>,
    updateTaskSettings: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => mocks.state,
}))

vi.mock("@/components/settings/utils/settingsHandlers", () => ({
    updateTaskSettings: mocks.updateTaskSettings,
}))

import { taskCapabilityMutationCoordinator } from "./TaskCapabilityMutationCoordinator"
import { useTaskCapabilityToggles } from "./useTaskCapabilityToggles"

const baseState = () => ({
    stateRevision: 0,
    currentTaskItem: undefined,
    taskViewState: undefined,
    taskCapabilityToggles: undefined,
    setTaskCapabilityToggles: vi.fn(),
    globalClineRulesToggles: {},
    localClineRulesToggles: {},
    localCursorRulesToggles: {},
    localWindsurfRulesToggles: {},
    localAgentsRulesToggles: {},
    globalWorkflowToggles: {},
    localWorkflowToggles: {},
    globalSkillsToggles: { "global-skill.md": false },
    localSkillsToggles: {},
    remoteSkillsToggles: {},
    remoteRulesToggles: {},
    remoteWorkflowToggles: {},
    mcpServers: [],
})

describe("useTaskCapabilityToggles", () => {
    beforeEach(() => {
        taskCapabilityMutationCoordinator.reset()
        mocks.state = baseState()
        mocks.updateTaskSettings.mockReset().mockResolvedValue(undefined)
    })

    it("keeps an empty Welcome screen in global scope", () => {
        const { result } = renderHook(() => useTaskCapabilityToggles())

        expect(result.current.isTaskScoped).toBe(false)
        expect(result.current.snapshot).toBeUndefined()
    })

    it("does not create task-scoped state before a task exists", async () => {
        const { result } = renderHook(() => useTaskCapabilityToggles())

        await act(() => result.current.updateToggle("globalSkillsToggles", "global-skill.md", true))

        expect(result.current.isTaskScoped).toBe(false)
        expect(mocks.state.setTaskCapabilityToggles).not.toHaveBeenCalled()
        expect(mocks.updateTaskSettings).not.toHaveBeenCalled()
    })

    it("persists active-task changes through task settings", async () => {
        mocks.state = {
            ...baseState(),
            taskViewState: { taskId: "task-1" },
            taskCapabilityToggles: createTaskCapabilityToggles({ mcpServers: { docs: true } }),
        }
        const { result } = renderHook(() => useTaskCapabilityToggles())

        await act(() => result.current.updateToggle("mcpServers", "docs", false))

        expect(mocks.updateTaskSettings).toHaveBeenCalledOnce()
        const [taskId, settings] = mocks.updateTaskSettings.mock.calls[0]
        expect(taskId).toBe("task-1")
        expect(parseTaskCapabilityToggles(settings.taskCapabilityToggles)?.mcpServers).toEqual({ docs: false })
    })

    it("keeps a pending intent over stale state revisions until a newer authoritative revision acknowledges it", async () => {
        let resolveWrite: (() => void) | undefined
        mocks.updateTaskSettings.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveWrite = resolve
                }),
        )
        mocks.state = {
            ...baseState(),
            stateRevision: 10,
            taskViewState: { taskId: "task-1" },
            taskCapabilityToggles: createTaskCapabilityToggles({ mcpServers: { docs: true } }),
        }
        const { result, rerender } = renderHook(() => useTaskCapabilityToggles())
        let write: Promise<void> | undefined

        act(() => {
            write = result.current.updateToggle("mcpServers", "docs", false)
        })
        expect(result.current.snapshot?.mcpServers.docs).toBe(false)

        mocks.state = { ...mocks.state, stateRevision: 10 }
        rerender()
        expect(result.current.snapshot?.mcpServers.docs).toBe(false)

        await act(async () => {
            resolveWrite?.()
            await write
        })
        mocks.state = {
            ...mocks.state,
            stateRevision: 11,
            taskCapabilityToggles: createTaskCapabilityToggles({ mcpServers: { docs: false } }),
        }
        rerender()
        expect(result.current.snapshot?.mcpServers.docs).toBe(false)
    })

    it("rolls back the pending display when task settings persistence fails", async () => {
        mocks.updateTaskSettings.mockRejectedValueOnce(new Error("write failed"))
        mocks.state = {
            ...baseState(),
            taskViewState: { taskId: "task-1" },
            taskCapabilityToggles: createTaskCapabilityToggles({ mcpServers: { docs: true } }),
        }
        const { result } = renderHook(() => useTaskCapabilityToggles())

        await act(async () => {
            await expect(result.current.updateToggle("mcpServers", "docs", false)).rejects.toThrow("write failed")
        })

        expect(result.current.snapshot?.mcpServers.docs).toBe(true)
        expect(mocks.state.setTaskCapabilityToggles).toHaveBeenLastCalledWith(
            createTaskCapabilityToggles({ mcpServers: { docs: true } }),
        )
    })

    it("isolates a delayed task write from the next task", async () => {
        let resolveWrite: (() => void) | undefined
        mocks.updateTaskSettings.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveWrite = resolve
                }),
        )
        mocks.state = {
            ...baseState(),
            taskViewState: { taskId: "task-1" },
            taskCapabilityToggles: createTaskCapabilityToggles({ mcpServers: { docs: true } }),
        }
        const { result, rerender } = renderHook(() => useTaskCapabilityToggles())
        let write: Promise<void> | undefined
        act(() => {
            write = result.current.updateToggle("mcpServers", "docs", false)
        })

        mocks.state = {
            ...baseState(),
            taskViewState: { taskId: "task-2" },
            taskCapabilityToggles: createTaskCapabilityToggles({ mcpServers: { docs: true } }),
        }
        rerender()
        expect(result.current.snapshot?.mcpServers.docs).toBe(true)
        mocks.state.setTaskCapabilityToggles.mockClear()

        await act(async () => {
            resolveWrite?.()
            await write
        })
        expect(result.current.snapshot?.mcpServers.docs).toBe(true)
        expect(mocks.state.setTaskCapabilityToggles).not.toHaveBeenCalled()
    })

    it("serializes rapid inverse writes so the newest intent is persisted last", async () => {
        const resolvers: Array<() => void> = []
        mocks.updateTaskSettings.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    resolvers.push(resolve)
                }),
        )
        mocks.state = {
            ...baseState(),
            taskViewState: { taskId: "task-1" },
            taskCapabilityToggles: createTaskCapabilityToggles({ mcpServers: { docs: true } }),
        }
        const { result } = renderHook(() => useTaskCapabilityToggles())
        let firstWrite: Promise<void> | undefined
        let secondWrite: Promise<void> | undefined

        act(() => {
            firstWrite = result.current.updateToggle("mcpServers", "docs", false)
            secondWrite = result.current.updateToggle("mcpServers", "docs", true)
        })
        expect(result.current.snapshot?.mcpServers.docs).toBe(true)
        expect(mocks.updateTaskSettings).toHaveBeenCalledTimes(1)

        await act(async () => {
            resolvers[0]()
            await firstWrite
        })
        await vi.waitFor(() => expect(mocks.updateTaskSettings).toHaveBeenCalledTimes(2))
        expect(parseTaskCapabilityToggles(mocks.updateTaskSettings.mock.calls[0][1].taskCapabilityToggles)?.mcpServers.docs).toBe(
            false,
        )
        expect(parseTaskCapabilityToggles(mocks.updateTaskSettings.mock.calls[1][1].taskCapabilityToggles)?.mcpServers.docs).toBe(
            true,
        )

        await act(async () => {
            resolvers[1]()
            await secondWrite
        })
        expect(result.current.snapshot?.mcpServers.docs).toBe(true)
    })

    it("does not roll back the newest intent when an earlier queued write fails", async () => {
        let rejectFirst: ((error: Error) => void) | undefined
        let resolveSecond: (() => void) | undefined
        mocks.updateTaskSettings
            .mockImplementationOnce(
                () =>
                    new Promise<void>((_resolve, reject) => {
                        rejectFirst = reject
                    }),
            )
            .mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        resolveSecond = resolve
                    }),
            )
        mocks.state = {
            ...baseState(),
            taskViewState: { taskId: "task-1" },
            taskCapabilityToggles: createTaskCapabilityToggles({ mcpServers: { docs: true } }),
        }
        const { result } = renderHook(() => useTaskCapabilityToggles())
        let firstWrite: Promise<void> | undefined
        let secondWrite: Promise<void> | undefined
        act(() => {
            firstWrite = result.current.updateToggle("mcpServers", "docs", false)
            secondWrite = result.current.updateToggle("mcpServers", "docs", true)
        })
        expect(result.current.snapshot?.mcpServers.docs).toBe(true)

        await act(async () => {
            rejectFirst?.(new Error("first write failed"))
            await expect(firstWrite).rejects.toThrow("first write failed")
        })
        await vi.waitFor(() => expect(mocks.updateTaskSettings).toHaveBeenCalledTimes(2))
        expect(result.current.snapshot?.mcpServers.docs).toBe(true)

        await act(async () => {
            resolveSecond?.()
            await secondWrite
        })
        expect(result.current.snapshot?.mcpServers.docs).toBe(true)
    })

    it("merges queued writes from independent hook consumers for the same task", async () => {
        let resolveFirst: (() => void) | undefined
        mocks.updateTaskSettings
            .mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        resolveFirst = resolve
                    }),
            )
            .mockResolvedValueOnce(undefined)
        mocks.state = {
            ...baseState(),
            taskViewState: { taskId: "task-1" },
            taskCapabilityToggles: createTaskCapabilityToggles({
                localSubagentsToggles: { agent: false },
                mcpServers: { docs: false },
            }),
        }
        const firstConsumer = renderHook(() => useTaskCapabilityToggles())
        const secondConsumer = renderHook(() => useTaskCapabilityToggles())
        let firstWrite: Promise<void> | undefined
        let secondWrite: Promise<void> | undefined

        act(() => {
            firstWrite = firstConsumer.result.current.updateToggle("localSubagentsToggles", "agent", true)
            secondWrite = secondConsumer.result.current.updateToggle("mcpServers", "docs", true)
        })
        expect(mocks.updateTaskSettings).toHaveBeenCalledTimes(1)

        await act(async () => {
            resolveFirst?.()
            await firstWrite
        })
        await vi.waitFor(() => expect(mocks.updateTaskSettings).toHaveBeenCalledTimes(2))
        const secondSnapshot = parseTaskCapabilityToggles(mocks.updateTaskSettings.mock.calls[1][1].taskCapabilityToggles)
        expect(secondSnapshot?.localSubagentsToggles.agent).toBe(true)
        expect(secondSnapshot?.mcpServers.docs).toBe(true)
        await act(async () => {
            await secondWrite
        })
    })

    it("reconciles discoveries without overwriting an existing task choice or pruning a temporarily missing resource", async () => {
        mocks.state = {
            ...baseState(),
            taskViewState: { taskId: "task-1" },
            taskCapabilityToggles: createTaskCapabilityToggles({
                localWorkflowToggles: { kept: false, stale: true },
            }),
        }
        const { result } = renderHook(() => useTaskCapabilityToggles())

        await act(() => result.current.reconcile({ localWorkflowToggles: { kept: true, added: true } }))

        const settings = mocks.updateTaskSettings.mock.calls[0][1]
        expect(parseTaskCapabilityToggles(settings.taskCapabilityToggles)?.localWorkflowToggles).toEqual({
            kept: false,
            stale: true,
            added: true,
        })
    })

    it("keeps reconcile and updateToggle referentially stable across state publishes", () => {
        mocks.state = {
            ...baseState(),
            stateRevision: 1,
            taskViewState: { taskId: "task-1" },
            taskCapabilityToggles: createTaskCapabilityToggles({ localWorkflowToggles: { kept: true } }),
        }
        const { result, rerender } = renderHook(() => useTaskCapabilityToggles())
        const firstReconcile = result.current.reconcile
        const firstUpdateToggle = result.current.updateToggle

        // Discovery polling republishes state constantly. Consumers list these
        // callbacks as effect dependencies, so a new identity would tear down and
        // immediately restart their polling, multiplying workspace scans.
        mocks.state = {
            ...mocks.state,
            stateRevision: 2,
            taskCapabilityToggles: createTaskCapabilityToggles({ localWorkflowToggles: { kept: true } }),
        }
        rerender()

        expect(result.current.reconcile).toBe(firstReconcile)
        expect(result.current.updateToggle).toBe(firstUpdateToggle)
    })

    it("reconciles against the latest authoritative snapshot even when called through a stable callback", async () => {
        mocks.state = {
            ...baseState(),
            stateRevision: 1,
            taskViewState: { taskId: "task-1" },
            taskCapabilityToggles: createTaskCapabilityToggles({ localWorkflowToggles: { kept: true } }),
        }
        const { result, rerender } = renderHook(() => useTaskCapabilityToggles())
        const stableReconcile = result.current.reconcile

        mocks.state = {
            ...mocks.state,
            stateRevision: 2,
            taskCapabilityToggles: createTaskCapabilityToggles({ localWorkflowToggles: { kept: false } }),
        }
        rerender()

        await act(() => stableReconcile({ localWorkflowToggles: { kept: true, added: true } }))

        const settings = mocks.updateTaskSettings.mock.calls[0][1]
        expect(parseTaskCapabilityToggles(settings.taskCapabilityToggles)?.localWorkflowToggles).toEqual({
            kept: false,
            added: true,
        })
    })
})
