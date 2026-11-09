import { afterEach, describe, expect, it, vi } from "vitest"
import { ProductionComposeAdapter } from "../../executors/compose/ProductionComposeAdapter"
import { JournalConversationView } from "../../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../../executors/provider/service/ProviderJournalMessageMaterializer"
import { createDeniedSurface } from "../../executors/tool/ToolDomainSurface"
import { TurnToolScheduler } from "../../executors/tool/TurnToolScheduler"
import { createInitialTaskState } from "../../kernel"
import type { MessageStateHandler } from "../../message-state"
import type { TaskRuntime } from "../../runtime"
import { createTaskExecutorAssembly } from "../../shell/TaskExecutorAssembly"
import { TaskShell } from "../../shell/TaskShell"
import {
    InMemoryCommandPublicationStore,
    InMemoryConversationJournal,
    InMemoryStateVault,
    InMemoryTaskPayloadStore,
    InMemoryTaskViewPort,
} from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { ProviderDraftEnvelope, ToolInvocationEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import type { ActiveTaskSession } from "../ActiveTaskSession"
import { RestoredToolDialogContinuation } from "../RestoredToolDialogContinuation"
import { TaskInteractionOwner } from "../TaskInteractionOwner"
import { ResumeDialogContinuation, type ResumptionInput } from "../UnownedDialogContinuation"

const runtimes: TaskRuntime[] = []
afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.disposeDeadlines()))
    vi.useRealTimers()
})

function gate() {
    let release!: () => void
    const promise = new Promise<void>((resolve) => (release = resolve))
    return { promise, release }
}

async function harness(source: "command" | "ask_timeout" | undefined) {
    const payloads = new InMemoryTaskPayloadStore()
    const journal = new InMemoryConversationJournal()
    const vault = new InMemoryStateVault()
    const publications = new InMemoryCommandPublicationStore()
    const rows = {
        clineMessages: [],
        addToClineMessages: vi.fn(async () => {}),
        flushUiMessages: vi.fn(async () => {}),
    } as unknown as MessageStateHandler
    let runtime!: TaskRuntime
    let shell!: TaskShell
    let nextInput = 0
    const materialize = async (input: ResumptionInput) => ({
        entryId: `continued:${++nextInput}`,
        payloadRef: await payloads.put(encodeTaskPayload({ kind: "user_input", text: input.text ?? "" })),
    })
    const resumption = {
        materialize: vi.fn(materialize),
        materializeAnswer: vi.fn(materialize),
        submit: vi.fn((input: { entryId: string; payloadRef: string }) => shell.submitInput(input)),
    }
    const continuation = new RestoredToolDialogContinuation(
        {
            state: () => runtime.getState(),
            payloads,
            journal,
            messages: rows,
            nextPresentationId: () => ++nextInput,
            admitReply: async () => undefined,
        },
        resumption,
        new ResumeDialogContinuation(resumption),
    )
    const owner = new TaskInteractionOwner(rows, payloads, continuation)
    const sent: ProviderDraftEnvelope[] = []
    const runner = vi.fn(async () => undefined)
    const initialState = {
        ...createInitialTaskState("planned-resume"),
        away: {
            configuration: { enabled: true, automatic: source === undefined, modeRevocation: 0, automaticRevocation: 0 },
            ...(source ? { mode: { source, enteredRevision: 0, modeRevocation: 0 } } : {}),
        },
        flow: {
            phase: "running" as const,
            provider: { commandId: "provider", originRevision: 0, status: "running" as const },
        },
    }
    const assembly = createTaskExecutorAssembly({
        taskId: initialState.taskId,
        initialState,
        persistence: { vault, journal, publications, taskView: new InMemoryTaskViewPort() },
        execution: {
            compose: new ProductionComposeAdapter({ payloads, journal, readState: () => runtime.getState() }),
            provider: {
                execution: {
                    start: async function* (input) {
                        sent.push(decodeTaskPayload<ProviderDraftEnvelope>(await payloads.read(input.draftRef)))
                    },
                },
            },
            automaticResponses: { deliver: (command) => owner.deliverAutomatic(command) },
            compaction: { run: async () => ({ resultRef: "unused" }) },
            policy: { evaluate: async () => ({ approved: true }) },
            dialog: {
                waiters: owner,
                execution: {
                    prepare: async () => ({
                        journalRef: "approval",
                        journalWatermark: journal.watermark(),
                        receiverGeneration: runtime.getState().generation,
                        disposition: "created",
                    }),
                    reveal: async () => ({ disposition: "revealed" }),
                },
            },
            tool: {
                runner: { runBlock: runner, release: async () => {} },
                surface: createDeniedSurface("detached_domain"),
                scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
            },
        },
    })
    runtime = assembly.runtime
    shell = new TaskShell(runtime, assembly.halt)
    runtimes.push(runtime)
    owner.bind({
        taskId: initialState.taskId,
        writable: true,
        state: () => runtime.getState(),
        task: shell,
        assembly,
    } as unknown as ActiveTaskSession)
    const invocationRef = await payloads.put(
        encodeTaskPayload<ToolInvocationEnvelope>({
            kind: "tool_invocation",
            toolName: "execute_command",
            input: { command: "echo not-executed", requires_approval: "true" },
            functionId: "call",
            dlineTid: "command",
            presentationId: 1,
            isNativeToolCall: true,
        }),
    )
    const finalPayloadRef = await payloads.put(
        encodeTaskPayload({
            kind: "provider_final",
            content: [
                {
                    type: "tool_use",
                    function_id: "call",
                    dline_tid: "command",
                    name: "execute_command",
                    input: { command: "echo not-executed", requires_approval: "true" },
                },
            ],
        }),
    )
    await journal.append({
        operationId: "provider.final:provider",
        source: "provider",
        payloadRef: finalPayloadRef,
        causation: { turnId: "turn" },
    })
    expect(
        await runtime.submit({
            type: "provider.turn_ready",
            generation: 0,
            commandId: "provider",
            originRevision: 0,
            turnId: "turn",
            finalPayloadRef,
            journalWatermark: journal.watermark(),
            turnPlan: {
                mode: "serial",
                blocks: [
                    {
                        blockId: "command",
                        index: 0,
                        attempt: "attempt",
                        lanes: [],
                        turnEnding: false,
                        invocationRef,
                        approval: {
                            kind: "manual",
                            interactionId: "approval",
                            presentationRef: "echo not-executed",
                            presentationAsk: "command",
                            ...(source ? { externalCommand: true as const } : {}),
                            actionRules: [
                                { actionId: "approve", payloadPolicy: "none" },
                                { actionId: "reject", payloadPolicy: "draft" },
                            ],
                        },
                    },
                ],
            },
        }),
    ).toMatchObject({ kind: "accepted" })
    await runtime.waitForQuiescence()
    runtime.allowRestoredCommands()
    return { runtime, shell, owner, runner, sent, resumption, payloads, journal, vault, rows }
}

// Real live owner, halt participants, durable outbox, shell and compose. Only
// payload I/O is gated: no hydration or replacement of the live Task state.
describe("Away planned approval live Cancel -> Resume", () => {
    it.each([
        { source: undefined, timeoutMs: 600000, resumeText: "" },
        { source: "command" as const, timeoutMs: 60000, resumeText: "" },
        { source: "ask_timeout" as const, timeoutMs: 60000, resumeText: "Keep the same workspace scope." },
    ])("releases the accepted timeout once after Resume: $source", async ({ source, timeoutMs, resumeText }) => {
        vi.useFakeTimers()
        vi.setSystemTime(1000)
        const h = await harness(source)
        expect(h.runtime.getState().dialog.approvalsByBlock.command).toMatchObject({
            status: "awaiting",
            deadline: { kind: source ? "external_command" : "command_approval", deadlineAt: 1000 + timeoutMs },
        })
        const deliveryWrite = gate()
        const put = h.payloads.put.bind(h.payloads)
        const deliveries = vi.spyOn(h.owner, "deliverAutomatic")
        const submissions = vi.spyOn(h.runtime, "submit")
        let draftWrites = 0
        vi.spyOn(h.payloads, "put").mockImplementation(async (bytes) => {
            if (decodeTaskPayload<{ kind: string }>(bytes).kind === "dialog_draft") {
                draftWrites++
                if (draftWrites === 1) await deliveryWrite.promise
            }
            return put(bytes)
        })
        try {
            await vi.advanceTimersByTimeAsync(timeoutMs)
            await vi.waitFor(() => expect(draftWrites).toBe(1))
            const accepted = h.runtime.getState().dialog.approvalsByBlock.command.acceptedResponse
            expect(accepted).toMatchObject({ origin: "timeout", actionId: "reject" })
            expect((await h.vault.load("planned-resume"))!.state.dialog.approvalsByBlock.command.acceptedResponse).toEqual(
                accepted,
            )
            const cancelling = h.shell.cancel("cancel")
            await vi.waitFor(() => {
                expect(h.runtime.getState().generation).toBe(1)
                expect(h.runtime.getState().flow.phase).toBe("paused")
            })
            deliveryWrite.release()
            expect(await cancelling).toMatchObject({ kind: "accepted" })
            await h.runtime.waitForQuiescence()
            expect(h.runtime.getState().dialog.approvalsByBlock.command.acceptedResponse).toEqual(accepted)
            expect(h.runtime.getState().turn.blocks[0].phase).toBe("awaiting_approval")
            const resume = h.runtime.getState().dialog.primary!
            expect(resume).toMatchObject({ kind: "cancelled_resume", status: "awaiting" })
            await vi.advanceTimersByTimeAsync(600000)
            expect(h.sent).toEqual([])
            expect(h.runner).not.toHaveBeenCalled()
            expect(h.resumption.submit).not.toHaveBeenCalled()
            expect((await h.journal.read()).filter((entry) => entry.operationId === "tool.terminal_manifest:turn")).toEqual([])

            const draftRef = await h.payloads.put(
                encodeTaskPayload({ kind: "dialog_draft", text: resumeText, images: [], files: [] }),
            )
            const response = await h.shell.respond({
                type: "dialog.respond",
                taskId: "planned-resume",
                turnId: resume.turnId,
                interactionId: resume.interactionId,
                stateRevision: h.runtime.getState().revision,
                receiverGeneration: resume.receiverGeneration!,
                actionId: "resume",
                draftRef,
            })
            expect(response.kind).toBe("accepted")
            if (response.kind !== "accepted") throw new Error(response.diagnostic.message)
            await response.receipt.durable
            expect(
                await h.owner.resolve(resume.interactionId, {
                    actionId: "resume",
                    draft: { text: resumeText, images: [], files: [] },
                }),
            ).toBe(true)
            await h.runtime.waitForQuiescence()

            expect(h.resumption.materializeAnswer).not.toHaveBeenCalled()
            expect(h.resumption.submit).not.toHaveBeenCalled()
            expect(h.runner).not.toHaveBeenCalled()
            expect(h.sent).toHaveLength(1)
            expect(h.runtime.getState().away?.mode?.source).toBe(source ?? "ask_timeout")
            expect(h.runtime.getState().turn.blocks[0]).toMatchObject({ phase: "rejected", approvalTimedOut: true })
            expect(h.runtime.getState().turn.blocks[0].deniedByUser).toBeUndefined()
            expect(h.runtime.getState().dialog).toMatchObject({ approvalsByBlock: {} })
            // The capture-only provider port ends without a final chunk. Its normal
            // error dialog is unrelated to, and must not restore, the retired Resume.
            expect(h.runtime.getState().dialog.primary?.kind).toBe("error_retry")
            expect(h.runtime.getState().dialog.interrupted).toBeUndefined()
            expect(deliveries.mock.calls.map(([command]) => command.generation)).toEqual([0, 1])
            expect(submissions.mock.calls.map(([event]) => event).filter((event) => event.type === "approval.responded")).toEqual(
                [expect.objectContaining({ generation: 1, blockId: "command", approved: false, origin: "timeout" })],
            )
            const terminalEntries = (await h.journal.read()).filter(
                (entry) => entry.operationId === "tool.terminal_manifest:turn",
            )
            expect(terminalEntries).toHaveLength(1)
            const view = new JournalConversationView(h.journal, new ProviderJournalMessageMaterializer(h.payloads))
            const results = (await view.entries())
                .filter((entry) => entry.kind === "tool_terminal_manifest")
                .flatMap((entry) => entry.messages)
                .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
            expect(results).toHaveLength(1)
            expect(results[0]).toMatchObject({
                type: "tool_result",
                function_id: "call",
                dline_tid: "command",
                content: [{ type: "text", text: expect.stringMatching(/workspace.*already authorized/i) }],
            })
            expect(results[0]).not.toHaveProperty("is_error")
            expect(h.sent[0].materialPlan?.inputs.filter((input) => input.source === "dialog")).toMatchObject([
                { payloadRef: draftRef },
            ])
            expect(h.rows.addToClineMessages).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(600000)
            await h.runtime.waitForQuiescence()
            expect(h.sent).toHaveLength(1)
            expect(deliveries).toHaveBeenCalledTimes(2)
        } finally {
            deliveryWrite.release()
            await h.runtime.waitForQuiescence()
        }
    })
})
