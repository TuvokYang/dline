import { LegacyInputAdapter } from "@core/input-semantics/LegacyInputAdapter"
import { SemanticInputAdmissionService } from "@core/input-semantics/SemanticInputAdmissionService"
import { TaskCommandExpander } from "@core/input-semantics/TaskEntityResolvers"
import { TaskSemanticInputAdmission } from "@core/input-semantics/TaskSemanticInputAdmission"
import { BUILTIN_INPUT_SEMANTICS } from "@shared/input-semantics/catalog"
import { fromProtoInputSemanticCatalog, toProtoInputSemanticCatalog } from "@shared/proto-conversions/input-semantics/catalog"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createInitialTaskState, type TaskState } from "../../kernel"
import { TaskRuntime } from "../../runtime/TaskRuntime"
import { TaskShell } from "../../shell/TaskShell"
import type { TaskPayloadStore } from "../../stores"
import type { DurableTaskSnapshot } from "../../stores/contracts"
import { decodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { CanonicalInputQueueApplication } from "../CanonicalInputQueueApplication"
import { TaskInputMaterializer } from "../TaskInputMaterializer"

vi.mock("@/services/telemetry", () => ({ telemetryService: { captureSlashCommandUsed: vi.fn() } }))

const runtimes: TaskRuntime[] = []
afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.disposeDeadlines()))
})
function harness(initialState: TaskState = { ...createInitialTaskState("away-input"), flow: { phase: "waiting" } }) {
    const catalog = fromProtoInputSemanticCatalog(
        toProtoInputSemanticCatalog({ revision: 3, descriptors: BUILTIN_INPUT_SEMANTICS }),
    )
    let sequence = 0
    const stored = new Map<string, Uint8Array>()
    const payloads = {
        put: async (payload: Uint8Array) => {
            const ref = `payload:${stored.size}`
            stored.set(ref, payload)
            return ref
        },
        read: async (ref: string) => stored.get(ref),
    } as unknown as TaskPayloadStore
    const admission = new TaskSemanticInputAdmission(
        new LegacyInputAdapter(
            async () => catalog,
            () => `document:${++sequence}`,
        ),
        new SemanticInputAdmissionService({
            catalog: () => catalog,
            commands: new TaskCommandExpander(() => ({
                localWorkflowToggles: {},
                globalWorkflowToggles: {},
                taskIncarnationId: "away-test",
            })),
            mentions: { resolve: async () => "<file-content>" },
        }),
    )
    const inputs = new TaskInputMaterializer(
        payloads,
        { nextEntryId: () => `entry:${++sequence}`, nextSequence: () => sequence },
        admission,
    )
    let snapshot: DurableTaskSnapshot | undefined
    const runtime = new TaskRuntime({
        initialState,
        vault: {
            load: async () => undefined,
            save: async (value) => {
                snapshot = value
            },
        },
        taskView: { notifyCommitted: async () => {}, notifyTransient: () => {} },
        publications: { has: async () => false, mark: async () => {} },
        executors: [
            { domain: "compose", execute: async () => {} },
            { domain: "tool", execute: async () => {} },
            { domain: "dialog", execute: async () => {} },
        ],
    })
    runtimes.push(runtime)
    const shell = new TaskShell(runtime, { rearm: async () => {}, forceClose: () => {} })
    const envelope = (ref: string) => decodeTaskPayload<UserInputEnvelope>(stored.get(ref)!)
    return { inputs, runtime, shell, envelope, admission, payloads, snapshot: () => snapshot }
}

function awaitingDialog(approval = false): TaskState {
    const state = createInitialTaskState("away-input")
    const interaction = {
        interactionId: "question",
        turnId: "turn",
        kind: approval ? "tool_approval" : "followup",
        status: "awaiting" as const,
        createdRevision: 0,
        presentationRef: "question-body",
        receiverGeneration: 0,
        actionRules: (approval ? ["approve", "reject"] : ["reply"]).map((actionId) => ({
            actionId,
            payloadPolicy: "draft" as const,
        })),
    }
    return {
        ...state,
        flow: { phase: "running" },
        turn: approval
            ? {
                  ...state.turn,
                  turnId: "turn",
                  manualApprovalBlockIds: ["block"],
                  blocks: [
                      {
                          blockId: "block",
                          index: 0,
                          phase: "awaiting_approval",
                          attempt: "attempt",
                          lanes: [],
                          turnEnding: false,
                          invocationRef: "invocation",
                      },
                  ],
              }
            : state.turn,
        dialog: approval
            ? { approvalsByBlock: { block: { ...interaction, blockId: "block" } } }
            : { approvalsByBlock: {}, primary: interaction },
    }
}

async function enable(runtime: TaskRuntime) {
    const result = await runtime.submit({
        type: "away.configured",
        generation: 0,
        configuration: { enabled: true, automatic: true, modeRevocation: 0, automaticRevocation: 0 },
    })
    if (result.kind !== "accepted") throw new Error("Configuration refused")
    await result.receipt.durable
}

describe("trusted Away admission into the production Task shell", () => {
    it("consumes the token, keeps the body and mention, and enters through the same accepted input", async () => {
        const h = harness()
        await enable(h.runtime)
        const input = await h.inputs.materialize({ text: "/away repair @/src/a.ts" })
        expect(input.userControl).toEqual({ kind: "enter_away" })
        expect(h.envelope(input.payloadRef)).toMatchObject({
            admittedText: " repair <file-content>",
            userControl: { kind: "enter_away" },
        })
        expect(h.envelope(input.payloadRef).semanticInput?.nodes[0]).toMatchObject({
            sourceText: "/cmd:away",
            compositionMode: "composable",
        })
        const result = await h.shell.submitInput(input)
        if (result.kind !== "accepted") throw new Error("Input refused")
        await result.receipt.durable
        expect(result.state.away?.mode?.source).toBe("command")
        expect(result.state.intake.queued[0].payloadRef).toBe(input.payloadRef)
    })

    it("does not exit on an empty resume delivery, and exits on the next ordinary user content", async () => {
        const h = harness()
        await enable(h.runtime)
        await h.shell.submitInput(await h.inputs.materialize({ text: "/away continue" }))
        const empty = await h.inputs.materializeAnswer({ text: "" })
        expect(empty.userControl).toBeUndefined()
        await h.shell.submitInput(empty)
        expect(h.runtime.getState().away?.mode?.source).toBe("command")
        await h.shell.submitInput(await h.inputs.materialize({ text: "I am back" }))
        expect(h.runtime.getState().away?.mode).toBeUndefined()
        expect(h.runtime.getState().roundMaterial?.notices).toMatchObject([{ reason: "user_returned" }])
    })

    it.each([
        "approve",
        "reject",
    ] as const)("accepts /away with an approval's %s, not as another intake entry", async (action) => {
        const h = harness(awaitingDialog(true))
        await enable(h.runtime)
        const reply = await h.inputs.reviewReply({ text: "/away check @/src/a.ts" })
        const result = await h.shell.respond({
            type: "approval.respond",
            taskId: "away-input",
            turnId: "turn",
            interactionId: "question",
            blockId: "block",
            stateRevision: h.runtime.getState().revision,
            receiverGeneration: 0,
            approved: action === "approve",
            draftRef: "draft",
            userControl: reply?.userControl,
        })
        if (result.kind !== "accepted") throw new Error("Approval refused")
        await result.receipt.durable
        expect(h.snapshot()?.state.away?.mode?.source).toBe("command")
        expect(h.runtime.getState().intake.queued).toEqual([])
        expect(h.runtime.getState().turn.blocks[0].phase).toBe(action === "approve" ? "ready" : "rejected")
    })

    it("applies a real queue entry's control only when its turn-ending response is accepted", async () => {
        const h = harness(awaitingDialog())
        await enable(h.runtime)
        const deliver = vi.fn(async (delivery: import("../InputQueueApplicationPort").CanonicalQueueTurnEndDelivery) => {
            const state = h.runtime.getState()
            const result = await h.shell.respond({
                type: "dialog.respond",
                taskId: state.taskId,
                turnId: "turn",
                interactionId: "question",
                stateRevision: state.revision,
                receiverGeneration: 0,
                actionId: "reply",
                draftRef: "draft",
                queueDeliveryId: delivery.deliveryId,
                queueDeliveryEntries: delivery.entries,
                queueDeliveryMode: delivery.mode,
            })
            if (result.kind !== "accepted") throw new Error("Queue response refused")
            await result.receipt.durable
            return "accepted" as const
        })
        const queue = new CanonicalInputQueueApplication(h.runtime, h.inputs, h.payloads, { deliverTurnEnd: deliver })
        const admit = vi.spyOn(h.admission, "admit")
        expect(
            (await queue.mutate({ kind: "enqueue", draft: { text: "/away review @/src/a.ts", images: [], files: [] } })).accepted,
        ).toBe(true)
        expect(admit).toHaveBeenCalledTimes(1)
        expect(h.runtime.getState().away?.mode).toBeUndefined()
        const entry = h.runtime.getState().intake.queued[0]
        expect(entry.userControl).toEqual({ kind: "enter_away" })
        queue.onTurnEndAwaiting({ turnId: "turn", interactionId: "question", kind: "followup" })
        await vi.waitFor(() => expect(h.snapshot()?.state.dialog.primary?.status).toBe("resolving"))
        expect(h.snapshot()?.state.away?.mode?.source).toBe("command")
        expect(h.runtime.getState().intake.queued[0].state).toBe("consumed")
        const body = /^<user_message description="[^"]+">\n([\s\S]*)\n<\/user_message>$/.exec(
            deliver.mock.calls[0][0].modelDraft.text,
        )
        expect(body?.[1]).toBe(" review <file-content>")
    })

    it("keeps a reply's first admission for resumed delivery without resolving its mention again", async () => {
        const h = harness()
        const admit = vi.spyOn(h.admission, "admit")
        const reply = await h.inputs.reviewReply({ text: "/away repair @/src/a.ts" })
        expect(reply?.userControl).toEqual({ kind: "enter_away" })
        expect(reply?.modelText).toBe(" repair <file-content>")
        expect(reply?.admittedInputRef).toBeDefined()
        const input = await h.inputs.materializeAnswer({ admittedInputRef: reply!.admittedInputRef })
        expect(admit).toHaveBeenCalledTimes(1)
        expect(h.envelope(input.payloadRef).admittedText).toBe(" repair <file-content>")
        expect(input.userControl).toBeUndefined()
        const restored = await h.inputs.admitReply({ admittedInputRef: reply!.admittedInputRef })
        expect(restored?.modelText).toBe(" repair <file-content>")
        expect(admit).toHaveBeenCalledTimes(1)
    })

    it("distinguishes real reply content from empty approval and resume drafts", async () => {
        const h = harness()
        expect((await h.inputs.reviewReply({ text: "I am back" }))?.userControl).toEqual({ kind: "user_returned" })
        expect((await h.inputs.reviewReply({ text: "", images: ["image-data"] }))?.userControl).toEqual({ kind: "user_returned" })
        expect((await h.inputs.reviewReply({ text: "" }))?.userControl).toBeUndefined()
        expect((await h.inputs.reviewReply({ text: "/unknown-command" }))?.userControl).toEqual({ kind: "user_returned" })
    })

    it("does not replay a dialog answer's control, including nonempty automatic feedback", async () => {
        const h = harness()
        await enable(h.runtime)
        await h.shell.submitInput(await h.inputs.materialize({ text: "/away continue" }))
        const replay = await h.inputs.materializeAnswer({ text: "The user has not responded. Continue." })
        expect(replay.userControl).toBeUndefined()
        expect(h.envelope(replay.payloadRef).userControl).toBeUndefined()
        await h.shell.submitInput(replay)
        expect(h.runtime.getState().away?.mode?.source).toBe("command")
    })
})
