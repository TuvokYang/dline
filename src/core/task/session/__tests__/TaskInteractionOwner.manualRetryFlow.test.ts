import type { ApiHandler } from "@core/api"
import type { ApiStreamChunk } from "@core/api/transform/stream"
import type { Controller } from "@core/controller"
import { dispatchInteraction } from "@core/controller/task/dispatchInteraction"
import type { UiMessage } from "@shared/ExtensionMessage"
import { DispatchInteractionRequest } from "@shared/proto/dline/task"
import { expect, it, vi } from "vitest"
import { ProductionProviderAdapter } from "../../executors/provider/ProductionProviderAdapter"
import { DefaultProductionProviderService } from "../../executors/provider/service/DefaultProductionProviderService"
import type { PreparedProviderRequest } from "../../executors/provider/service/ProviderRequest"
import { ProviderRetryGate } from "../../executors/provider/service/ProviderRetryGate"
import { createDeniedSurface } from "../../executors/tool/ToolDomainSurface"
import { TurnToolScheduler } from "../../executors/tool/TurnToolScheduler"
import type { MessageStateHandler } from "../../message-state"
import { PromptCacheHealthTracker } from "../../prompt-cache/PromptCacheHealthTracker"
import { openTaskShell } from "../../shell/TaskShellFactory"
import {
    InMemoryCommandPublicationStore,
    InMemoryConversationJournal,
    InMemoryStateVault,
    InMemoryTaskPayloadStore,
    InMemoryTaskViewPort,
} from "../../stores"
import { encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { ActiveTaskSession } from "../ActiveTaskSession"
import { TaskInteractionOwner } from "../TaskInteractionOwner"
import { TaskProviderRequestReporter } from "../TaskProviderRequestReporter"

it("dispatches repeated empty manual Retries through the prepared provider and restores one answerable failure without countdown cards", async () => {
    const payloads = new InMemoryTaskPayloadStore()
    const rows: UiMessage[] = []
    const messages = {
        taskUlid: "manual-retry",
        get clineMessages() {
            return rows
        },
        addToClineMessages: async (message: UiMessage) => void rows.push(message),
        updateClineMessage: async (index: number, changes: Partial<UiMessage>) => {
            rows[index] = { ...rows[index], ...changes }
        },
        removeMessagesByTs: async (timestamps: number[]) => {
            for (const ts of timestamps) {
                const index = rows.findIndex((row) => row.ts === ts)
                if (index >= 0) rows.splice(index, 1)
            }
        },
        flushMessageUpdate: async () => {},
        flushUiMessages: async () => {},
    } as unknown as MessageStateHandler
    let next = 0
    const nextPresentationId = () => ++next
    const retry = new ProviderRetryGate()
    vi.spyOn(retry, "delayMs").mockReturnValue(0)
    let sends = 0
    const api = {
        createMessage: async function* (): AsyncGenerator<ApiStreamChunk> {
            sends++
            throw Object.assign(new Error("Service Unavailable"), { status: 503 })
        },
        getProviderId: () => "openai",
        getModel: () => ({ id: "test-model", info: { capabilities: { contextWindow: 8192 } } }),
    } as unknown as ApiHandler
    const request = {
        api,
        systemPrompt: "original system prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "original request" }] }],
        nativeTools: false,
        mode: "serial",
        profile: "standard",
        turnId: "turn-prepared",
    } as unknown as PreparedProviderRequest
    const provider = new ProductionProviderAdapter({
        payloads,
        service: new DefaultProductionProviderService({ requests: { prepare: async () => request }, retry, nextPresentationId }),
    })
    const started = vi.spyOn(provider, "start")
    const draftRef = await payloads.put(
        encodeTaskPayload({ kind: "provider_draft", admittedEntryIds: ["input"], inputPayloadRefs: [] }),
    )
    const compose = vi.fn(async () => ({ draftRef }))
    const owner = new TaskInteractionOwner(messages, payloads, { accepts: () => false, continue: async () => "declined" })
    const reporter = new TaskProviderRequestReporter({
        messages,
        nextPresentationId,
        api: () => api,
        promptCache: new PromptCacheHealthTracker("manual-retry", { debug: () => {}, warn: () => {} }),
        usageTelemetry: { record: () => {} },
    })
    const opened = await openTaskShell({
        taskId: "manual-retry",
        openReason: "new",
        taskView: new InMemoryTaskViewPort(),
        persistence: {
            payloads,
            ports: {
                vault: new InMemoryStateVault(),
                journal: new InMemoryConversationJournal(),
                publications: new InMemoryCommandPublicationStore(),
            },
        },
        execution: {
            compose: { compose },
            provider: { execution: provider, report: reporter },
            compaction: { run: async () => ({ resultRef: "compacted" }) },
            policy: { evaluate: async () => ({ approved: true }) },
            dialog: {
                execution: {
                    prepare: async () => ({
                        journalRef: "journal:0",
                        journalWatermark: { seq: 0 },
                        receiverGeneration: 0,
                        disposition: "existing",
                    }),
                    reveal: async () => ({ disposition: "revealed" }),
                },
                waiters: owner,
            },
            tool: {
                runner: { runBlock: async () => undefined, release: async () => undefined },
                surface: createDeniedSurface("detached_domain"),
                scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
            },
        },
    })
    const session = {
        taskId: "manual-retry",
        taskInstanceId: "opening",
        writable: true,
        state: () => opened.runtime.getState(),
        task: opened.shell,
        assembly: opened.assembly,
        payloads,
        messages,
        inputs: { reviewReply: async () => undefined },
        owners: { interactions: owner, providerRetry: retry, nextPresentationId },
    } as unknown as ActiveTaskSession
    owner.bind(session)
    try {
        await opened.shell.open()
        const inputRef = await payloads.put(encodeTaskPayload({ kind: "user_input", text: "original request" }))
        const submitted = await opened.runtime.submit({
            type: "user.submit",
            generation: 0,
            entryId: "input",
            payloadRef: inputRef,
        })
        expect(submitted.kind).toBe("accepted")
        await opened.runtime.waitForQuiescence()
        expect(sends).toBe(6)
        expect(rows.filter((row) => row.say === "error_retry")).toHaveLength(1)
        const failures = new Set<string>()

        for (const expectedSends of [7, 8]) {
            const before = opened.runtime.getState()
            const interaction = before.dialog.primary!
            expect(interaction).toMatchObject({ kind: "error_retry", status: "awaiting" })
            expect(failures.has(interaction.interactionId)).toBe(false)
            failures.add(interaction.interactionId)
            const response = await dispatchInteraction(
                { task: session, postStateToWebview: async () => {} } as unknown as Controller,
                DispatchInteractionRequest.create({
                    taskId: session.taskId,
                    taskInstanceId: session.taskInstanceId,
                    turnId: interaction.turnId,
                    interactionId: interaction.interactionId,
                    stateRevision: before.revision,
                    actionId: "retry",
                    draft: { text: "", images: [], files: [] },
                }),
            )
            expect(response.accepted).toBe(true)
            await opened.runtime.waitForQuiescence()
            expect(sends).toBe(expectedSends)
            expect(rows.filter((row) => row.say === "error_retry")).toEqual([])
            expect(opened.runtime.getState().dialog.primary).toMatchObject({ kind: "error_retry", status: "awaiting" })
            expect(opened.runtime.getState().dialog.primary?.interactionId).not.toBe(interaction.interactionId)
            expect(compose).toHaveBeenCalledTimes(1)
            expect(started.mock.calls.map(([input]) => input.draftRef)).toEqual(Array(expectedSends - 5).fill(draftRef))
        }
        expect(rows.filter((row) => row.say === "api_req_started")).toHaveLength(3)
        expect(retry.active).toBe(false)
    } finally {
        await opened.runtime.disposeDeadlines()
    }
})
