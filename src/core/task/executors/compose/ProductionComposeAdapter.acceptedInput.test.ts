import { describe, expect, it } from "vitest"
import { createInitialTaskState, type RoundMaterialPlan, type TaskState, transition } from "../../kernel"
import { pendingIntakeEntryIds } from "../../kernel/machines/intake"
import { TaskRuntime } from "../../runtime/TaskRuntime"
import {
    InMemoryCommandPublicationStore,
    InMemoryConversationJournal,
    InMemoryStateVault,
    InMemoryTaskPayloadStore,
    InMemoryTaskViewPort,
} from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { ProviderDraftEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { JournalConversationView } from "../provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../provider/service/ProviderJournalMessageMaterializer"
import type { ComposeRoundInput } from "./ComposeCommandExecutor"
import { reconcilePreparedRound } from "./PreparedRoundRecovery"
import { ProductionComposeAdapter } from "./ProductionComposeAdapter"
import { RetainedInputJournalBatch } from "./RetainedInputJournalBatch"

function freeze(state: TaskState): TaskState {
    const owner = state.flow.compose!
    const result = transition(state, {
        type: "compose.freeze_requested",
        generation: state.generation,
        commandId: owner.commandId,
        originRevision: owner.originRevision,
    })
    if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
    return result.state
}

async function fixture() {
    const payloads = new InMemoryTaskPayloadStore()
    const journal = new InMemoryConversationJournal()
    const payloadRef = await payloads.put(encodeTaskPayload({ kind: "user_input", text: "ACCEPTED_RESUME_DRAFT" }))
    const state = freeze({
        ...createInitialTaskState("accepted-input"),
        revision: 4,
        flow: {
            phase: "running",
            compose: { commandId: "resume", originRevision: 3, status: "running", admittedEntryIds: ["resume-input"] },
        },
        intake: {
            queued: [
                {
                    entryId: "resume-input",
                    payloadRef,
                    source: "user",
                    mode: "queued",
                    sequence: 1,
                    state: "reserved",
                    acceptedRevision: 3,
                },
            ],
            background: [],
            coTask: [],
        },
    })
    const options = { payloads, journal, readState: () => state }
    const input = {
        admittedEntryIds: ["resume-input"],
        composeCommandId: "resume",
        freezeMaterial: async () => state.flow.compose!.materialPlan!,
        signal: new AbortController().signal,
    }
    const view = () => new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads))
    return { payloads, journal, state, options, input, view }
}

describe("accepted input survives an unprepared round", () => {
    it.each([
        "terminal",
        "thrown",
    ] as const)("keeps the Resume body once after %s admission failure, recovery and empty Retry", async (failure) => {
        const h = await fixture()
        const adapter = new ProductionComposeAdapter({
            ...h.options,
            environment: { render: async () => "FAILED_ENVIRONMENT" },
            contextWindowGuard: {
                admit: async () => {
                    if (failure === "thrown") throw new Error("compaction request rejected")
                    return { kind: "failed", reason: "compaction request rejected" }
                },
            },
        })
        if (failure === "thrown") await expect(adapter.compose(h.input)).rejects.toThrow("compaction request rejected")
        else expect(await adapter.compose(h.input)).toMatchObject({ failed: { reason: "compaction request rejected" } })
        const failed = transition(h.state, {
            type: "compose.failed",
            generation: h.state.generation,
            commandId: "resume",
            originRevision: 3,
            message: "compaction request rejected",
        })
        if (failed.kind !== "accepted") throw new Error(failed.diagnostic.message)
        expect(failed.state.intake.queued[0].state).toBe("released")
        expect(pendingIntakeEntryIds(failed.state.intake)).toEqual([])
        expect(await h.journal.findByOperation("compose.prepared:resume")).toBeUndefined()

        const runtime = new TaskRuntime({
            initialState: structuredClone(failed.state),
            vault: new InMemoryStateVault(),
            taskView: new InMemoryTaskViewPort(),
            publications: new InMemoryCommandPublicationStore(),
            executors: [],
        })
        await reconcilePreparedRound(runtime, runtime.getState(), h.payloads, h.journal)
        await runtime.waitForQuiescence()
        expect(runtime.getState().flow.compose?.materialPlan).toBeUndefined()

        const emptyRef = await h.payloads.put(encodeTaskPayload({ kind: "user_input", text: "" }))
        const retryPlan: RoundMaterialPlan = {
            id: "round-material:retry",
            frozenRevision: runtime.getState().revision,
            notices: [],
            inputs: [{ id: "intake:retry-input", entryId: "retry-input", payloadRef: emptyRef, revision: 10, source: "intake" }],
        }
        const result = await new ProductionComposeAdapter({ ...h.options, readState: () => runtime.getState() }).compose({
            admittedEntryIds: [],
            composeCommandId: "retry",
            freezeMaterial: async () => retryPlan,
            signal: new AbortController().signal,
        })
        if (!("draftRef" in result)) throw new Error("Expected the empty Retry to prepare a draft")
        const draft = decodeTaskPayload<ProviderDraftEnvelope>(await h.payloads.read(result.draftRef))
        const messages = await h.view().messages(draft.journalThrough)
        const text = JSON.stringify(messages)
        const inputs = messages.filter((message) => message.role === "user")
        expect(JSON.stringify(inputs).match(/ACCEPTED_RESUME_DRAFT/g)).toHaveLength(1)
        expect(text).not.toContain("FAILED_ENVIRONMENT")
        expect(draft.inputPayloadRefs).toEqual([emptyRef])
        await runtime.disposeDeadlines()
    })

    it("retracts a failed retained delivery without losing direct intake, then delivers the queue once", async () => {
        const h = await fixture()
        const queueRef = await h.payloads.put(encodeTaskPayload({ kind: "user_input", text: "RETAINED_BODY" }))
        const feedbackRef = await h.payloads.put(
            encodeTaskPayload({
                kind: "dialog_draft",
                text: "PENDING_FEEDBACK",
                images: [],
                files: [],
                roundMaterialOwned: true,
            }),
        )
        const delivery = { deliveryId: "delivery:resume", point: "tool_round" as const, ownerId: "resume", generation: 0 }
        const state = freeze({
            ...h.state,
            flow: {
                ...h.state.flow,
                compose: { ...h.state.flow.compose!, materialPlan: undefined, admittedEntryIds: ["resume-input", "queue-input"] },
            },
            roundMaterial: {
                notices: [{ id: "exit", kind: "away_exited", revision: 1, reason: "stopped" }],
                feedback: [{ id: "feedback", payloadRef: feedbackRef, source: "dialog", revision: 2 }],
            },
            intake: {
                ...h.state.intake,
                queued: [
                    ...h.state.intake.queued,
                    {
                        entryId: "queue-input",
                        payloadRef: queueRef,
                        source: "user",
                        mode: "steering",
                        sequence: 2,
                        acceptedRevision: 4,
                        state: "reserved",
                        queue: { editing: false, delivery },
                    },
                ],
            },
        })
        const input: ComposeRoundInput = {
            ...h.input,
            admittedEntryIds: state.flow.compose!.admittedEntryIds,
            queueDelivery: delivery,
            freezeMaterial: async () => state.flow.compose!.materialPlan!,
        }
        const adapter = new ProductionComposeAdapter({
            ...h.options,
            readState: () => state,
            contextWindowGuard: { admit: async () => ({ kind: "failed", reason: "terminal compaction failure" }) },
        })
        expect(await adapter.compose(input)).toMatchObject({ failed: { reason: "terminal compaction failure" } })
        expect(await adapter.rollbackRetainedQueue(input)).toBe("released")
        expect(await new RetainedInputJournalBatch(h.payloads, h.journal).inspect(delivery.deliveryId)).toMatchObject({
            kind: "retracted",
        })
        const visible = (await h.view().entries()).filter((entry) => entry.messages.length > 0)
        expect(visible.map((entry) => entry.kind)).toEqual(["round_material_input"])
        expect(JSON.stringify(visible[0].messages).match(/ACCEPTED_RESUME_DRAFT/g)).toHaveLength(1)

        const retryDelivery = { ...delivery, deliveryId: "delivery:retry", ownerId: "retry" }
        const retryPlan: RoundMaterialPlan = {
            ...state.flow.compose!.materialPlan!,
            id: "round-material:retry",
            inputs: state.flow.compose!.materialPlan!.inputs.filter((entry) => entry.entryId !== "resume-input"),
        }
        const retry = await new ProductionComposeAdapter({ ...h.options, readState: () => state }).compose({
            ...input,
            composeCommandId: "retry",
            admittedEntryIds: ["queue-input"],
            queueDelivery: retryDelivery,
            freezeMaterial: async () => retryPlan,
        })
        if (!("draftRef" in retry)) throw new Error("Expected a redelivered draft")
        const draft = decodeTaskPayload<ProviderDraftEnvelope>(await h.payloads.read(retry.draftRef))
        const text = JSON.stringify(await h.view().messages(draft.journalThrough))
        expect(text.match(/ACCEPTED_RESUME_DRAFT/g)).toHaveLength(1)
        expect(text.match(/RETAINED_BODY/g)).toHaveLength(1)
        expect(text.match(/PENDING_FEEDBACK/g)).toHaveLength(1)
        expect(text.match(/sent by the user while work was in progress/g)).toHaveLength(1)
    })

    it.each([
        "withdrawn",
        "cancelled",
    ] as const)("does not prepare a %s round or erase its already accepted input", async (outcome) => {
        const h = await fixture()
        const controller = new AbortController()
        const adapter = new ProductionComposeAdapter({
            ...h.options,
            environment: { render: async () => "UNSENT_ENVIRONMENT" },
            contextWindowGuard: {
                admit: async () => {
                    if (outcome === "withdrawn") return { kind: "withdrawn", reason: "review dismissed" }
                    controller.abort("user cancelled")
                    return { kind: "ready", environment: "UNSENT_ENVIRONMENT" }
                },
            },
        })
        const composed = adapter.compose({ ...h.input, signal: controller.signal })
        if (outcome === "withdrawn") await expect(composed).resolves.toEqual({ withdrawn: { reason: "review dismissed" } })
        else await expect(composed).rejects.toBe("user cancelled")
        expect(await h.journal.findByOperation("compose.prepared:resume")).toBeUndefined()
        const text = JSON.stringify(await h.view().messages())
        expect(text.match(/ACCEPTED_RESUME_DRAFT/g)).toHaveLength(1)
        expect(text).not.toContain("UNSENT_ENVIRONMENT")
    })

    it("does not journal any material when cancellation preceded composition", async () => {
        const h = await fixture()
        const controller = new AbortController()
        controller.abort("cancelled before compose")
        await expect(new ProductionComposeAdapter(h.options).compose({ ...h.input, signal: controller.signal })).rejects.toBe(
            "cancelled before compose",
        )
        expect(await h.journal.read()).toEqual([])
    })

    it("deduplicates by intake acceptance across attempts, not by identical payload bytes", async () => {
        const h = await fixture()
        await new ProductionComposeAdapter(h.options).compose(h.input)
        const firstPlan = h.state.flow.compose!.materialPlan!
        const adapter = new ProductionComposeAdapter(h.options)
        await adapter.compose({
            ...h.input,
            composeCommandId: "repeat",
            freezeMaterial: async () => ({ ...firstPlan, id: "round-material:repeat" }),
        })
        expect(JSON.stringify(await h.view().messages()).match(/ACCEPTED_RESUME_DRAFT/g)).toHaveLength(1)
        const second = { ...h.state.intake.queued[0], entryId: "second-acceptance", sequence: 2 }
        const state: TaskState = { ...h.state, intake: { ...h.state.intake, queued: [...h.state.intake.queued, second] } }
        await new ProductionComposeAdapter({ ...h.options, readState: () => state }).compose({
            ...h.input,
            composeCommandId: "second",
            admittedEntryIds: [second.entryId],
            freezeMaterial: async () => ({
                ...firstPlan,
                id: "round-material:second",
                inputs: [{ ...firstPlan.inputs[0], id: `intake:${second.entryId}`, entryId: second.entryId }],
            }),
        })
        expect(JSON.stringify(await h.view().messages()).match(/ACCEPTED_RESUME_DRAFT/g)).toHaveLength(2)
    })

    it("reuses the existing direct-intake journal identity without appending a second copy", async () => {
        const h = await fixture()
        await h.journal.append({
            operationId: "intake:user:resume-input",
            source: "intake",
            payloadRef: h.state.intake.queued[0].payloadRef,
        })
        await new ProductionComposeAdapter(h.options).compose(h.input)
        expect(JSON.stringify(await h.view().messages()).match(/ACCEPTED_RESUME_DRAFT/g)).toHaveLength(1)
    })
})
