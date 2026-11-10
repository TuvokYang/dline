import type { ApiHandler } from "@core/api"
import type { ApiStreamChunk } from "@core/api/transform/stream"
import { describe, expect, it, vi } from "vitest"
import type { TaskEventSink } from "../../executors/contracts"
import { DialogCommandExecutor } from "../../executors/dialog/DialogCommandExecutor"
import { HaltCommandExecutor } from "../../executors/halt/HaltCommandExecutor"
import { CallbackHaltParticipant } from "../../executors/halt/participants"
import type { ProductionProviderChunk } from "../../executors/provider/ProductionProviderAdapter"
import { DefaultProductionProviderService } from "../../executors/provider/service/DefaultProductionProviderService"
import type { PreparedProviderRequest } from "../../executors/provider/service/ProviderRequest"
import { ProviderRetryGate } from "../../executors/provider/service/ProviderRetryGate"
import { ALL_HALT_PARTICIPANTS, createInitialTaskState, type DialogInteraction, type TaskState } from "../../kernel"
import type { MessageStateHandler } from "../../message-state"
import { TaskRuntime } from "../../runtime"
import { deferred } from "../../runtime/deferred"
import { InMemoryCommandPublicationStore, InMemoryStateVault, InMemoryTaskPayloadStore, InMemoryTaskViewPort } from "../../stores"
import type { ProviderDraftEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import type { ActiveTaskSession } from "../ActiveTaskSession"
import { TaskInteractionOwner } from "../TaskInteractionOwner"

function preparedResponse(kind: DialogInteraction["kind"], actionId: string): TaskState {
    const state = createInitialTaskState("prepared-retry")
    return {
        ...state,
        flow: {
            phase: "waiting",
            compose: {
                commandId: "compose-prepared",
                originRevision: 0,
                status: "completed",
                turnId: "turn-prepared",
                admittedEntryIds: [],
                draftRef: "sha256:prepared-draft",
            },
        },
        dialog: {
            ...state.dialog,
            primary: {
                interactionId: "failed-request",
                turnId: "turn-prepared",
                kind,
                status: "resolving",
                createdRevision: 0,
                presentationRef: "sha256:failure",
                actionRules: [{ actionId, payloadPolicy: "none" }],
                receiverGeneration: 0,
                acceptedResponse: {
                    actionId,
                    stateRevision: 0,
                    receiverGeneration: 0,
                    retryPreparedRound: true,
                },
            },
        },
    }
}

function fixture(
    options: {
        kind?: DialogInteraction["kind"]
        actionId?: "retry" | "resume"
        runtimeWritable?: boolean
        sessionWritable?: boolean
        vault?: InMemoryStateVault
    } = {},
) {
    const state = preparedResponse(options.kind ?? "error_retry", options.actionId ?? "retry")
    const retry = new ProviderRetryGate()
    // Keep the real wait/release lifecycle without spending seconds on the schedule.
    vi.spyOn(retry, "delayMs").mockReturnValue(0)
    const failure = Object.assign(new Error("Service Unavailable"), { status: 503 })
    const sends: string[] = []
    const api = {
        createMessage: async function* (): AsyncGenerator<ApiStreamChunk> {
            sends.push("send")
            throw failure
        },
        getProviderId: () => "openai",
        getModel: () => ({ id: "test-model", info: {} }),
    } as unknown as ApiHandler
    const request = {
        api,
        systemPrompt: "frozen prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "original request" }] }],
        nativeTools: false,
        mode: "serial",
        profile: "standard",
        turnId: "turn-prepared",
    } as unknown as PreparedProviderRequest
    const provider = new DefaultProductionProviderService({ requests: { prepare: async () => request }, retry })
    const notices: ProductionProviderChunk[] = []
    const failures: unknown[] = []
    const startedDrafts: string[] = []
    const send = async (draftRef: string) => {
        try {
            for await (const chunk of provider.start({
                draftRef,
                draft: {} as ProviderDraftEnvelope,
                signal: new AbortController().signal,
            })) {
                notices.push(chunk)
            }
        } catch (error) {
            failures.push(error instanceof Error && error.cause !== undefined ? error.cause : error)
        }
    }
    const continuation = { accepts: () => true, continue: vi.fn(async () => "continued" as const) }
    const owner = new TaskInteractionOwner({} as MessageStateHandler, new InMemoryTaskPayloadStore(), continuation)
    let runtime!: TaskRuntime
    const events: TaskEventSink = {
        submit: async (event) => {
            const result = await runtime.submit(event)
            return result.kind === "accepted" ? { kind: "accepted", durable: result.receipt.durable } : { kind: "rejected" }
        },
    }
    const dialog = new DialogCommandExecutor(
        {
            prepare: async () => ({
                journalRef: "journal:0",
                journalWatermark: { seq: 0 },
                receiverGeneration: runtime.getState().generation,
                disposition: "existing",
            }),
            reveal: async () => ({ disposition: "revealed" }),
        },
        events,
        owner,
    )
    // Only dialog suspension is exercised; all other domains have no live resources.
    const halt = new HaltCommandExecutor(
        ALL_HALT_PARTICIPANTS.map((id) => (id === "dialog" ? dialog : new CallbackHaltParticipant({ id, fence: () => {} }))),
        events,
    )
    runtime = new TaskRuntime({
        initialState: state,
        vault: options.vault ?? new InMemoryStateVault(),
        taskView: new InMemoryTaskViewPort(),
        publications: new InMemoryCommandPublicationStore(),
        deferRestoredCommands: options.runtimeWritable === false,
        executors: [
            dialog,
            halt,
            {
                domain: "provider",
                execute: async (command) => {
                    if (command.type !== "provider.start") throw new Error("Unexpected provider command")
                    startedDrafts.push(command.draftRef)
                    await send(command.draftRef)
                },
            },
        ],
    })
    owner.bind({
        writable: options.sessionWritable !== false,
        state: () => runtime.getState(),
        assembly: { runtime },
        owners: { providerRetry: retry },
    } as unknown as ActiveTaskSession)
    return { owner, runtime, halt, retry, send, sends, notices, failures, failure, startedDrafts, continuation }
}

describe("prepared-round manual Retry", () => {
    it("replays the prepared request once and returns its failure without another automatic countdown", async () => {
        const h = fixture()
        try {
            expect(await h.owner.resolve("failed-request", { actionId: "retry" })).toBe(true)
            await h.runtime.waitForQuiescence()
            expect(h.startedDrafts).toEqual(["sha256:prepared-draft"])
            expect(h.sends).toHaveLength(1)
            expect(h.notices.filter((chunk) => chunk.kind === "retry")).toEqual([])
            expect(h.failures).toEqual([h.failure])
            expect(h.runtime.getState().dialog.primary).toBeUndefined()
            expect(h.continuation.continue).not.toHaveBeenCalled()
            expect(h.retry.active).toBe(false)

            await h.send("later-ordinary-request")
            expect(h.sends).toHaveLength(7)
            expect(h.notices.filter((chunk) => chunk.kind === "retry")).toHaveLength(5)
        } finally {
            await h.runtime.disposeDeadlines()
        }
    })

    it("keeps the accepted manual request's retry budget when its retirement snapshot is recovered", async () => {
        const vault = new InMemoryStateVault()
        vi.spyOn(vault, "save").mockRejectedValueOnce(new Error("ENOSPC: snapshot unavailable"))
        const h = fixture({ vault })
        try {
            expect(await h.owner.resolve("failed-request", { actionId: "retry" })).toBe(false)
            expect(h.startedDrafts).toEqual([])
            expect(h.sends).toEqual([])
            await h.runtime.waitForDurable(h.runtime.getState().revision)
            await h.runtime.waitForQuiescence()
            expect(h.startedDrafts).toEqual(["sha256:prepared-draft"])
            expect(h.sends).toHaveLength(1)
            expect(h.notices.filter((chunk) => chunk.kind === "retry")).toEqual([])
            expect(h.failures).toEqual([h.failure])
        } finally {
            await h.runtime.disposeDeadlines()
        }
    })

    it("does not give a cancelled unclaimed manual request's budget to a later ordinary request", async () => {
        const vault = new InMemoryStateVault()
        const saving = deferred<void>()
        const release = deferred<void>()
        const save = vault.save.bind(vault)
        vi.spyOn(vault, "save").mockImplementationOnce(async (snapshot) => {
            saving.resolve()
            await release.promise
            await save(snapshot)
        })
        const h = fixture({ vault })
        try {
            const retirement = h.owner.resolve("failed-request", { actionId: "retry" })
            await saving.promise
            const cancelled = await h.runtime.submit({ type: "user.cancel", generation: 0, haltId: "cancel-before-send" })
            expect(cancelled.kind).toBe("accepted")
            release.resolve()
            expect(await retirement).toBe(true)
            await h.runtime.waitForQuiescence()
            expect(h.runtime.getState().halt.status).toBe("idle")
            expect(h.runtime.getState().flow.phase).toBe("paused")
            expect(h.startedDrafts).toEqual([])
            expect(h.sends).toEqual([])
            await h.halt.rearm("cancel-before-send")
            await h.send("later-ordinary-request")
            expect(h.sends).toHaveLength(6)
            expect(h.notices.filter((chunk) => chunk.kind === "retry")).toHaveLength(5)
            expect(h.failures).toEqual([h.failure])
        } finally {
            release.resolve()
            await h.runtime.disposeDeadlines()
        }
    })

    it.each(["resume", "cancelled_resume"] as const)("keeps automatic retries for a prepared %s", async (kind) => {
        const h = fixture({ kind, actionId: "resume" })
        try {
            expect(await h.owner.resolve("failed-request", { actionId: "resume" })).toBe(true)
            await h.runtime.waitForQuiescence()
            expect(h.startedDrafts).toEqual(["sha256:prepared-draft"])
            expect(h.sends).toHaveLength(6)
            expect(h.notices.filter((chunk) => chunk.kind === "retry")).toHaveLength(5)
            expect(h.failures).toEqual([h.failure])
            expect(h.continuation.continue).not.toHaveBeenCalled()
        } finally {
            await h.runtime.disposeDeadlines()
        }
    })

    it.each([
        { runtimeWritable: false, sessionWritable: true },
        { runtimeWritable: true, sessionWritable: false },
    ])("does not spend a later request's retries when retirement is refused (%j)", async (options) => {
        const h = fixture(options)
        try {
            expect(await h.owner.resolve("failed-request", { actionId: "retry" })).toBe(false)
            await h.runtime.waitForQuiescence()
            expect(h.startedDrafts).toEqual([])
            expect(h.runtime.getState().dialog.primary?.interactionId).toBe("failed-request")
            await h.send("later-ordinary-request")
            expect(h.sends).toHaveLength(6)
            expect(h.notices.filter((chunk) => chunk.kind === "retry")).toHaveLength(5)
            expect(h.failures).toEqual([h.failure])
        } finally {
            await h.runtime.disposeDeadlines()
        }
    })
})
