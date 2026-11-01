import type { Controller } from "@core/controller"
import { dispatchInteraction } from "@core/controller/task/dispatchInteraction"
import { LegacyInputAdapter } from "@core/input-semantics/LegacyInputAdapter"
import { SemanticInputAdmissionService } from "@core/input-semantics/SemanticInputAdmissionService"
import { TaskSemanticInputAdmission } from "@core/input-semantics/TaskSemanticInputAdmission"
import { BUILTIN_INPUT_SEMANTICS } from "@shared/input-semantics/catalog"
import { DispatchInteractionRequest } from "@shared/proto/dline/task"
import { expect, it, vi } from "vitest"
import { ProductionComposeAdapter } from "../executors/compose/ProductionComposeAdapter"
import { JournalConversationView } from "../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../executors/provider/service/ProviderJournalMessageMaterializer"
import { createDeniedSurface } from "../executors/tool/ToolDomainSurface"
import { TurnToolScheduler } from "../executors/tool/TurnToolScheduler"
import { createInitialTaskState, type TaskState } from "../kernel"
import type { MessageStateHandler } from "../message-state"
import { TaskRuntime } from "../runtime"
import type { ActiveTaskSession } from "../session/ActiveTaskSession"
import { RestoredToolDialogContinuation } from "../session/RestoredToolDialogContinuation"
import { TaskInputMaterializer } from "../session/TaskInputMaterializer"
import { TaskInteractionOwner } from "../session/TaskInteractionOwner"
import { ResumeDialogContinuation, type TaskResumptionPort } from "../session/UnownedDialogContinuation"
import {
    InMemoryCommandPublicationStore,
    InMemoryConversationJournal,
    InMemoryStateVault,
    InMemoryTaskPayloadStore,
    InMemoryTaskViewPort,
} from "../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { ProviderDraftEnvelope, ToolInvocationEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import { openTaskShell } from "./TaskShellFactory"

// Provider/network and UI row storage are ports; the durable acceptance, shell
// restart, Resume dispatcher, continuation, result writer and compose stay real.
it.each([
    true,
    false,
])("resumes an accepted ask timeout after a real shell restart with one paired Provider result (native=%s)", async (native) => {
    const payloads = new InMemoryTaskPayloadStore()
    const journal = new InMemoryConversationJournal()
    const vault = new InMemoryStateVault()
    const call: ToolInvocationEnvelope = {
        kind: "tool_invocation",
        toolName: "ask_followup_question",
        input: { question: "Choose" },
        functionId: "call",
        dlineTid: "question",
        presentationId: 1,
        isNativeToolCall: native,
        ...(native ? {} : { resultReplay: "text" as const }),
    }
    const invocationRef = await payloads.put(encodeTaskPayload(call))
    const presentationRef = await payloads.put(
        encodeTaskPayload({ kind: "dialog_presentation", presentationKind: "followup", body: "Choose" }),
    )
    await journal.append({
        operationId: "provider.final:previous",
        source: "provider",
        causation: { turnId: "turn" },
        payloadRef: await payloads.put(
            encodeTaskPayload({
                kind: "provider_final",
                content: native
                    ? [
                          {
                              type: "tool_use",
                              function_id: "call",
                              dline_tid: "question",
                              name: "ask_followup_question",
                              input: { question: "Choose" },
                          },
                      ]
                    : [{ type: "text", text: "<ask_followup_question><question>Choose</question></ask_followup_question>" }],
            }),
        ),
    })
    const base = createInitialTaskState("timeout-restart")
    const initialState: TaskState = {
        ...base,
        flow: { phase: "running" },
        away: {
            configuration: {
                enabled: true,
                automatic: true,
                modeRevocation: 0,
                automaticRevocation: 0,
            },
        },
        turn: {
            ...base.turn,
            turnId: "turn",
            executingBlockIds: ["question"],
            blocks: [
                {
                    blockId: "question",
                    index: 0,
                    phase: "executing",
                    lanes: [],
                    turnEnding: true,
                    invocationRef,
                    attempt: "attempt",
                },
            ],
        },
        dialog: {
            approvalsByBlock: {},
            primary: {
                interactionId: "question",
                turnId: "turn",
                kind: "followup",
                status: "awaiting",
                createdRevision: 0,
                receiverGeneration: 0,
                presentationRef,
                actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
                deadline: { kind: "ask", deadlineAt: 601000, modeRevocation: 0, automaticRevocation: 0 },
            },
        },
    }
    const source = new TaskRuntime({
        initialState,
        vault,
        taskView: new InMemoryTaskViewPort(),
        publications: new InMemoryCommandPublicationStore(),
        executors: [],
        automaticResponses: { deliver: async () => {} },
    })
    const due = await source.submit({
        type: "away.deadline_due",
        generation: 0,
        interactionId: "question",
        turnId: "turn",
        receiverGeneration: 0,
        deadlineAt: 601000,
        now: 601000,
    })
    expect(due.kind).toBe("accepted")
    await source.waitForQuiescence()
    expect((await vault.load("timeout-restart"))!.state.dialog.primary?.acceptedResponse?.origin).toBe("timeout")
    await source.disposeDeadlines()

    let reopened!: Awaited<ReturnType<typeof openTaskShell>>
    let next = 0
    const catalog = { revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS }
    const inputs = new TaskInputMaterializer(
        payloads,
        { nextEntryId: () => `resume:${++next}`, nextSequence: () => next },
        new TaskSemanticInputAdmission(
            new LegacyInputAdapter(
                async () => catalog,
                () => `document:${next}`,
            ),
            new SemanticInputAdmissionService({
                catalog: () => catalog,
                commands: { expand: async () => undefined },
                mentions: { resolve: async () => "" },
            }),
        ),
    )
    const resumption: TaskResumptionPort = {
        materialize: (input) => inputs.materialize(input),
        materializeAnswer: (input) => inputs.materializeAnswer(input),
        submit: (input) => reopened.shell.submitInput(input),
    }
    const rows = {
        clineMessages: [],
        addToClineMessages: vi.fn(async () => {}),
        flushUiMessages: vi.fn(async () => {}),
        updateClineMessage: vi.fn(),
        flushMessageUpdate: vi.fn(),
    } as unknown as MessageStateHandler
    const continuation = new RestoredToolDialogContinuation(
        {
            state: () => reopened.runtime.getState(),
            payloads,
            journal,
            messages: rows,
            nextPresentationId: () => ++next,
            admitReply: (input) => inputs.admitReply(input),
        },
        resumption,
        new ResumeDialogContinuation(resumption),
    )
    const owner = new TaskInteractionOwner(rows, payloads, continuation)
    const sent: ProviderDraftEnvelope[] = []
    reopened = await openTaskShell({
        taskId: "timeout-restart",
        openReason: "crash_recovery",
        taskView: new InMemoryTaskViewPort(),
        persistence: { payloads, ports: { vault, journal, publications: new InMemoryCommandPublicationStore() } },
        execution: {
            compose: new ProductionComposeAdapter({ payloads, journal, readState: () => reopened.runtime.getState() }),
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
                execution: {
                    prepare: async () => ({
                        journalRef: "journal:1",
                        journalWatermark: journal.watermark(),
                        receiverGeneration: 1,
                        disposition: "existing",
                    }),
                    reveal: async () => ({ disposition: "revealed" }),
                },
            },
            tool: {
                runner: { runBlock: async () => undefined, release: async () => undefined },
                surface: createDeniedSurface("detached_domain"),
                scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
            },
        },
    })
    const session = {
        taskId: "timeout-restart",
        taskInstanceId: "opening",
        writable: true,
        state: () => reopened.runtime.getState(),
        task: reopened.shell,
        assembly: reopened.assembly,
        payloads,
        messages: rows,
        inputs,
        owners: { interactions: owner },
    } as unknown as ActiveTaskSession
    owner.bind(session)
    try {
        await reopened.shell.open()
        await reopened.runtime.waitForQuiescence()
        const restored = reopened.runtime.getState()
        expect(restored.flow.phase).toBe("paused")
        expect(restored.dialog.interrupted?.acceptedResponse?.origin).toBe("timeout")
        expect(sent).toEqual([])
        const resume = restored.dialog.primary!
        expect(
            await dispatchInteraction(
                { task: session, postStateToWebview: async () => {} } as unknown as Controller,
                DispatchInteractionRequest.create({
                    taskId: session.taskId,
                    taskInstanceId: session.taskInstanceId,
                    turnId: resume.turnId,
                    interactionId: resume.interactionId,
                    stateRevision: restored.revision,
                    actionId: "resume",
                    draft: { text: "", images: [], files: [] },
                }),
            ),
        ).toMatchObject({ accepted: true })
        await reopened.runtime.waitForQuiescence()
        expect(sent).toHaveLength(1)
        const view = new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads))
        const entries = (await view.entries()).filter((entry) => entry.messages.length > 0)
        expect(entries.map((entry) => entry.kind)).toEqual(["provider_final", "tool_terminal_manifest", "round_active_away"])
        const result = entries[1].messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        expect(result).toHaveLength(1)
        if (native) expect(result[0]).toMatchObject({ type: "tool_result", function_id: "call", dline_tid: "question" })
        else expect(result[0].type).toBe("text")
        expect((await journal.read()).filter((entry) => entry.operationId === "tool.restored_result:turn:question")).toHaveLength(
            1,
        )
        expect(rows.addToClineMessages).not.toHaveBeenCalled()
        expect(reopened.runtime.getState().dialog.interrupted).toBeUndefined()
        expect(sent[0].materialPlan?.activeAway?.source).toBe("ask_timeout")
    } finally {
        await reopened.runtime.disposeDeadlines()
    }
})
