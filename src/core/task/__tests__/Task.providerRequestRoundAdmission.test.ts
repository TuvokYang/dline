import {
    bindProviderAttemptScope,
    observeProviderCall,
    type ProviderAttemptIdentity,
    type ProviderAttemptObserver,
    type ProviderTelemetryRole,
    withProviderAttemptIdentity,
} from "@shared/provider-attempt-observer"
import { describe, expect, it, vi } from "vitest"
import type { BlockPhase } from "../kernel"
import type { ApiRequestRoundScopeInput } from "../performance/api-request-round-lifecycle"
import type { ApiRequestRoundHandle } from "../performance/api-request-round-tracker"
import type { ApiRequestRoundUsage } from "../performance/api-request-round-types"
import type { ProviderRequestRoundAdmission } from "../performance/provider-request-round-port"
import { TaskProviderRequestRoundOwner } from "../performance/TaskProviderRequestRoundOwner"
import type { UsageToolCall } from "../telemetry/UsageToolCalls"

interface ProviderExecutionBlock {
    readonly blockId: string
    readonly phase: BlockPhase
    readonly invocationRef?: string
}

function attemptHandle(input: ApiRequestRoundScopeInput, providerAttempt = 0): ApiRequestRoundHandle {
    return {
        roundId: `${input.logicalRequestId}:provider:${providerAttempt}`,
        logicalRequestId: input.logicalRequestId,
        apiIndex: input.apiIndex,
        taskAttempt: input.taskAttempt,
        providerAttempt,
        role: input.role ?? "task",
        policyGeneration: input.policyGeneration ?? 0,
        startedAtMs: 1,
        startedMonotonicMs: 1,
    }
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
    for await (const _ of stream) {
        // Drain the observed send.
    }
}

async function* observedSend(): AsyncGenerator<never> {
    await observeProviderCall(async () => undefined)
}

async function* identifiedSend(identity: ProviderAttemptIdentity): AsyncGenerator<never> {
    await withProviderAttemptIdentity(identity, () => observeProviderCall(async () => undefined))
}

function createAdmission(): ProviderRequestRoundAdmission {
    return {
        createAttemptObserver: () => ({ beginAttempt: () => undefined, finishAttempt: () => undefined }),
        attachExactUsage: vi.fn(),
        completeProviderOnly: vi.fn(),
        completeTools: vi.fn(),
        completeTurnEndAwaitingUser: vi.fn(),
    }
}

function createOwner(
    blocks: readonly ProviderExecutionBlock[] = [],
    options: {
        readonly cancelling?: boolean
        readonly resolveExecutionToolCalls?: () => Promise<readonly UsageToolCall[]>
    } = {},
): TaskProviderRequestRoundOwner {
    return new TaskProviderRequestRoundOwner({
        lifecycle: {
            createObserver: vi.fn((input) => ({
                beginAttempt: () => attemptHandle(input),
                finishAttempt: () => undefined,
            })),
            attachExactUsage: vi.fn(),
            finalizeTokens: vi.fn(),
            completeProviderOnly: vi.fn(),
            completeTools: vi.fn(),
            completeTurnEndAwaitingUser: vi.fn(),
        },
        readExecutionBlocks: () => blocks,
        isExecutionCancelling: () => options.cancelling ?? false,
        resolveExecutionToolCalls: options.resolveExecutionToolCalls,
    })
}

describe("Task Provider request round admission", () => {
    it("creates a new logical request for task attempt zero and attaches usage by its exact terminal handle", async () => {
        const observedScopes: ApiRequestRoundScopeInput[] = []
        const attachedUsage: Array<{ handle: ApiRequestRoundHandle; usage: ApiRequestRoundUsage }> = []
        const finalizedHandles: ApiRequestRoundHandle[] = []
        let providerAttempt = 0
        const owner = new TaskProviderRequestRoundOwner({
            lifecycle: {
                createObserver: vi.fn((input) => {
                    observedScopes.push(input)
                    const observer: ProviderAttemptObserver<ApiRequestRoundHandle> = {
                        beginAttempt: () => attemptHandle(input, providerAttempt++),
                        finishAttempt: () => undefined,
                    }
                    return observer
                }),
                attachExactUsage: vi.fn((handle, usage) => {
                    attachedUsage.push({ handle, usage })
                }),
                finalizeTokens: vi.fn((handle) => {
                    finalizedHandles.push(handle)
                }),
                completeProviderOnly: vi.fn(),
                completeTools: vi.fn(),
                completeTurnEndAwaitingUser: vi.fn(),
            },
            readExecutionBlocks: () => [],
            isExecutionCancelling: () => false,
        })
        const first = owner.admitOrdinary(7, 0)
        const retry = owner.admitOrdinary(7, 1)
        expect(retry).toBe(first)
        await drain(bindProviderAttemptScope(observedSend(), first.createAttemptObserver(0)))
        await drain(bindProviderAttemptScope(observedSend(), retry.createAttemptObserver(1)))

        const restored = owner.admitOrdinary(7, 0)
        expect(restored).not.toBe(first)
        await drain(bindProviderAttemptScope(observedSend(), restored.createAttemptObserver(0)))

        const [firstScope, retryScope, restoredScope] = observedScopes
        expect(firstScope).toMatchObject({ apiIndex: 7, taskAttempt: 0 })
        expect(retryScope).toMatchObject({ apiIndex: 7, taskAttempt: 1 })
        expect(retryScope?.logicalRequestId).toBe(firstScope?.logicalRequestId)
        expect(restoredScope).toMatchObject({ apiIndex: 7, taskAttempt: 0 })
        expect(restoredScope?.logicalRequestId).not.toBe(firstScope?.logicalRequestId)

        const usage: ApiRequestRoundUsage = {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheUsageReported: true,
        }
        owner.attachOrdinaryExactUsage(7, usage)
        expect(attachedUsage).toEqual([
            { handle: expect.objectContaining({ logicalRequestId: restoredScope?.logicalRequestId }), usage },
        ])
        // The wrapper's single accumulated usage also closes that same send's finalization window.
        expect(finalizedHandles).toEqual([attachedUsage[0]?.handle])
    })

    it("freezes the contract model identity from the Profile selection mode and never forwards the raw wire model", async () => {
        const observedIdentities: Array<ProviderAttemptIdentity | undefined> = []
        const owner = new TaskProviderRequestRoundOwner({
            lifecycle: {
                createObserver: vi.fn((input) => ({
                    beginAttempt: (identity: ProviderAttemptIdentity | undefined) => {
                        observedIdentities.push(identity)
                        return attemptHandle(input)
                    },
                    finishAttempt: () => undefined,
                })),
                attachExactUsage: vi.fn(),
                finalizeTokens: vi.fn(),
                completeProviderOnly: vi.fn(),
                completeTools: vi.fn(),
                completeTurnEndAwaitingUser: vi.fn(),
            },
            readExecutionBlocks: () => [],
            isExecutionCancelling: () => false,
        })
        const sends: ProviderAttemptIdentity[] = [
            { provider: "openai", modelId: "GPT-4o", thinking: "level:high" },
            { provider: "openai", modelId: "Secret Tuned/Model", thinking: "state:default", customModel: true },
            { provider: "ollama", modelId: "C:\\models\\llama.gguf", thinking: "state:off", customModel: true },
        ]

        const admission = owner.admit({ source: "task" })
        for (const [index, identity] of sends.entries()) {
            await drain(bindProviderAttemptScope(identifiedSend(identity), admission.createAttemptObserver(index)))
        }

        expect(observedIdentities.map((identity) => identity?.modelId)).toEqual([
            "catalog:gpt-4o",
            "custom:secret_tuned/model",
            "state:private",
        ])
        expect(observedIdentities.map((identity) => identity?.thinking)).toEqual(["level:high", "state:default", "state:off"])
        expect(observedIdentities.some((identity) => identity?.modelId.includes("llama.gguf"))).toBe(false)
    })

    it("passes the frozen five-role catalog into every attempt scope and recognizes reviewer subagents", () => {
        const observedRoles: string[] = []
        const owner = new TaskProviderRequestRoundOwner({
            lifecycle: {
                createObserver: vi.fn((input) => {
                    observedRoles.push(input.role ?? "missing")
                    return { beginAttempt: () => attemptHandle(input), finishAttempt: () => undefined }
                }),
                attachExactUsage: vi.fn(),
                finalizeTokens: vi.fn(),
                completeProviderOnly: vi.fn(),
                completeTools: vi.fn(),
                completeTurnEndAwaitingUser: vi.fn(),
            },
            readExecutionBlocks: () => [],
            isExecutionCancelling: () => false,
        })
        const sources: ProviderTelemetryRole[] = ["task", "subagent", "compaction", "reviewer", "other"]

        for (const source of sources) owner.admit({ source }).createAttemptObserver(0)

        expect(observedRoles).toEqual(sources)
    })

    it("completes a Provider-only execution when no tool turn was registered", () => {
        const admission = createAdmission()
        const owner = createOwner()

        owner.completeTurn(admission)

        expect(admission.completeProviderOnly).toHaveBeenCalledOnce()
        expect(admission.completeTools).not.toHaveBeenCalled()
    })

    it("summarizes every terminal block in an all-settled parallel tool turn", () => {
        const admission = createAdmission()
        const owner = createOwner([
            { blockId: "completed", phase: "completed" },
            { blockId: "failed", phase: "rejected" },
            { blockId: "skipped", phase: "skipped" },
            { blockId: "cancelled", phase: "cancelled" },
        ])
        owner.registerExecution(admission, {
            turnId: "turn:parallel",
            toolCount: 4,
            turnEndInteractions: [],
        })

        owner.completeTurn(admission)

        expect(admission.completeTools).toHaveBeenCalledWith({
            toolCount: 4,
            completedToolCount: 1,
            failedToolCount: 1,
            cancelledToolCount: 2,
        })
    })

    it("waits for name-safe tool resolution and forwards one call per settled block", async () => {
        const admission = createAdmission()
        const toolCalls: readonly UsageToolCall[] = [
            { outcome: "completed", toolName: "read_file" },
            { outcome: "failed", toolName: "execute_command" },
            { outcome: "cancelled" },
        ]
        const owner = createOwner(
            [
                { blockId: "read", phase: "completed", invocationRef: "invocation:read" },
                { blockId: "exec", phase: "failed", invocationRef: "invocation:exec" },
                { blockId: "pending", phase: "pending", invocationRef: "invocation:private" },
            ],
            { resolveExecutionToolCalls: async () => toolCalls },
        )
        owner.registerExecution(admission, {
            turnId: "turn:named-tools",
            toolCount: 3,
            turnEndInteractions: [],
        })

        owner.completeTurn(admission)
        expect(admission.completeTools).not.toHaveBeenCalled()
        await owner.waitForCompletions()

        expect(admission.completeTools).toHaveBeenCalledWith(
            {
                toolCount: 3,
                completedToolCount: 1,
                failedToolCount: 1,
                cancelledToolCount: 1,
            },
            toolCalls,
        )
    })

    it("leaves Task-aborted executions for lifecycle abort instead of writing tools-settled", () => {
        const admission = createAdmission()
        const owner = createOwner([{ blockId: "tool", phase: "executing" }], { cancelling: true })
        owner.registerExecution(admission, {
            turnId: "turn:parallel",
            toolCount: 1,
            turnEndInteractions: [{ interactionId: "interaction-1", blockId: "tool" }],
        })

        owner.completeTurn(admission)
        owner.completeAtAwaitingUser("turn:parallel", "interaction-1")

        expect(admission.completeProviderOnly).not.toHaveBeenCalled()
        expect(admission.completeTools).not.toHaveBeenCalled()
        expect(admission.completeTurnEndAwaitingUser).not.toHaveBeenCalled()
    })

    it("terminals TURN-END at the durable awaiting-user boundary without counting later user wait", () => {
        const admission = createAdmission()
        const owner = createOwner([
            { blockId: "regular", phase: "completed" },
            { blockId: "turn-end", phase: "awaiting_approval" },
            { blockId: "later", phase: "pending" },
        ])
        owner.registerExecution(admission, {
            turnId: "turn:turn-end",
            toolCount: 3,
            turnEndInteractions: [{ interactionId: "interaction-1", blockId: "turn-end" }],
        })

        owner.completeAtAwaitingUser("turn:turn-end", "interaction-1")
        owner.completeAtAwaitingUser("turn:turn-end", "interaction-1")

        expect(admission.completeTurnEndAwaitingUser).toHaveBeenCalledOnce()
        expect(admission.completeTurnEndAwaitingUser).toHaveBeenCalledWith({
            toolCount: 3,
            completedToolCount: 2,
            failedToolCount: 0,
            cancelledToolCount: 1,
        })
    })
})
