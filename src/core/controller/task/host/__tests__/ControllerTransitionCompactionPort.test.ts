import type { ApiHandler } from "@core/api"
import { CompactionRequestScopes } from "@core/task/compaction/CompactionRequestScopes"
import { createInitialTaskState, type TaskState } from "@core/task/kernel"
import type { ActiveTaskSession } from "@core/task/session/ActiveTaskSession"
import { describe, expect, it } from "vitest"
import { ControllerTransitionCompactionPort } from "../ControllerTransitionCompactionPort"

/** A session whose kernel schedules the requested compaction and then reports it completed. */
function sessionThatCompacts(
    scopes: CompactionRequestScopes,
    observed: { scope?: unknown; compactionId?: string },
): ActiveTaskSession {
    let state: TaskState = createInitialTaskState("task-1")
    return {
        state: () => state,
        owners: { compactionScopes: scopes },
        payloads: { put: async () => "ctx-ref" },
        conversation: { read: async () => ({ messages: [], span: { from: 0, to: 1 } }) },
        assembly: {
            runtime: {
                submit: async (event: { compactionId: string; attempt: string }) => {
                    // The run resolves its handler when it starts, which is right after admission.
                    observed.compactionId = event.compactionId
                    observed.scope = scopes.resolve(event.compactionId)
                    state = {
                        ...state,
                        flow: {
                            ...state.flow,
                            compaction: {
                                compactionId: event.compactionId,
                                attempt: event.attempt,
                                contextRef: "ctx-ref",
                                status: "completed",
                            },
                        },
                    } as TaskState
                    return { kind: "accepted" }
                },
            },
        },
    } as unknown as ActiveTaskSession
}

function sessionWithNothingToCompact(submitted: string[]): ActiveTaskSession {
    const state = createInitialTaskState("task-1")
    return {
        state: () => state,
        payloads: { put: async () => "ctx-ref" },
        // Only the opening request exists, so there is no answered span to condense.
        conversation: { read: async () => ({ messages: [] }) },
        assembly: {
            runtime: {
                submit: async (event: { type: string }) => {
                    submitted.push(event.type)
                    return { kind: "accepted" }
                },
            },
        },
    } as unknown as ActiveTaskSession
}

describe("ControllerTransitionCompactionPort", () => {
    it("refuses a transition without a request when the conversation has nothing to condense", async () => {
        const submitted: string[] = []
        const port = new ControllerTransitionCompactionPort({ getSession: () => sessionWithNothingToCompact(submitted) })

        const outcome = await port.compact({ operationId: "transition-1" } as Parameters<typeof port.compact>[0])

        // Nothing got smaller, so a transition that needed room must not commit
        // its target as though compaction had made it fit.
        expect(outcome).toBe("failed")
        expect(submitted).toEqual([])
    })

    it("condenses with the target handler and forgets it once the run ends", async () => {
        const scopes = new CompactionRequestScopes()
        const observed: { scope?: unknown; compactionId?: string } = {}
        const targetApi = { getModel: () => ({ id: "target" }) } as unknown as ApiHandler
        const port = new ControllerTransitionCompactionPort({ getSession: () => sessionThatCompacts(scopes, observed) })

        const outcome = await port.compact({
            trigger: "mode_switch",
            operationId: "transition-1",
            targetApi,
            targetMode: "plan",
        })

        expect(outcome).toBe("completed")
        expect(observed.scope).toEqual({ api: targetApi, mode: "plan" })
        // Only a live transition may redirect a run; once it ends the run id resolves to the task's own handler.
        expect(observed.compactionId).toMatch(/^compaction:/)
        expect(scopes.resolve(observed.compactionId ?? "")).toBeUndefined()
    })

    it("fails a transition when no task is open", async () => {
        const port = new ControllerTransitionCompactionPort({ getSession: () => undefined })

        await expect(port.compact({ operationId: "transition-1" } as Parameters<typeof port.compact>[0])).resolves.toBe("failed")
    })
})
