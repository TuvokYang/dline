import { describe, expect, it, vi } from "vitest"
import { RetainedInputJournalBatch } from "../executors/compose/RetainedInputJournalBatch"
import { RoundMaterialComposer } from "../executors/compose/RoundMaterialComposer"
import { createDeniedSurface } from "../executors/tool/ToolDomainSurface"
import { TurnToolScheduler } from "../executors/tool/TurnToolScheduler"
import { createInitialTaskState, type RoundMaterialPlan, type TaskState } from "../kernel"
import {
    InMemoryCommandPublicationStore,
    InMemoryConversationJournal,
    InMemoryStateVault,
    InMemoryTaskPayloadStore,
    InMemoryTaskViewPort,
} from "../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { ProviderDraftEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import { openTaskShell } from "./TaskShellFactory"

async function fixture(options: { prepared?: boolean; final?: boolean; draftFailure?: boolean } = {}) {
    const payloads = new InMemoryTaskPayloadStore()
    const journal = new InMemoryConversationJournal()
    const vault = new InMemoryStateVault()
    const inputRef = await payloads.put(encodeTaskPayload({ kind: "user_input", text: "retained body" }))
    const entry = { entryId: "input", payloadRef: inputRef }
    const plan: RoundMaterialPlan = {
        id: "round-material:compose",
        frozenRevision: 4,
        inputs: [{ ...entry, id: "intake:input", source: "intake", revision: 3 }],
        notices: [{ id: "exit", kind: "away_exited", revision: 2, reason: "stopped" }],
    }
    const materials = new RoundMaterialComposer(payloads, journal)
    await materials.appendBody(plan, new AbortController().signal)
    const batch = await new RetainedInputJournalBatch(payloads, journal).stage({
        deliveryId: "delivery",
        entries: [entry],
        generation: 0,
        signal: new AbortController().signal,
        roundMaterialOwned: true,
    })
    const receipt = { deliveryId: "delivery", entries: [entry], journalWatermark: batch.watermark }
    let draftRef: string | undefined
    if (options.prepared !== false) {
        const original = payloads.put.bind(payloads)
        const write = vi.spyOn(payloads, "put").mockImplementation(async (bytes) => {
            if (options.draftFailure && decodeTaskPayload<{ kind: string }>(bytes).kind === "provider_draft")
                throw new Error("draft disk failure")
            return original(bytes)
        })
        const prepare = materials.prepare(
            "compose",
            { kind: "provider_draft", admittedEntryIds: [entry.entryId], inputPayloadRefs: [inputRef], materialPlan: plan },
            receipt,
        )
        if (options.draftFailure) await expect(prepare).rejects.toThrow("draft disk failure")
        else draftRef = (await prepare).draftRef
        write.mockRestore()
    }
    if (options.final)
        await journal.append({
            operationId: "provider.final:provider",
            source: "provider",
            payloadRef: await payloads.put(encodeTaskPayload({ kind: "provider_final", text: "done" })),
            causation: { commandId: "provider", originRevision: 5, generation: 0, turnId: "turn:compose" },
        })
    const state: TaskState = {
        ...createInitialTaskState("prepared"),
        revision: 4,
        roundMaterial: { notices: plan.notices, feedback: [] },
        flow: {
            phase: "running",
            compose: {
                commandId: "compose",
                originRevision: 3,
                status: "running",
                turnId: "turn:compose",
                admittedEntryIds: [entry.entryId],
                materialPlan: plan,
                draftRef,
            },
        },
        intake: {
            queued: [
                {
                    ...entry,
                    source: "user",
                    mode: "steering",
                    sequence: 1,
                    state: "reserved",
                    queue: {
                        editing: false,
                        delivery: { deliveryId: "delivery", point: "tool_round", ownerId: "compose", generation: 0 },
                    },
                },
            ],
            background: [],
            coTask: [],
        },
    }
    await vault.save({ state, outbox: [] })
    const provider = vi.fn(async function* (_input: { readonly draftRef: string; readonly turnId?: string }) {})
    const compose = vi.fn(async () => ({ draftRef: "unexpected-new-draft" }))
    const execution = {
        provider: { execution: { start: provider } },
        compose: { compose },
        compaction: { run: async () => ({ resultRef: "result" }) },
        policy: { evaluate: async () => ({ approved: true }) },
        dialog: {
            execution: {
                prepare: async () => ({
                    journalRef: `journal:${journal.watermark().seq}`,
                    journalWatermark: journal.watermark(),
                    receiverGeneration: 1,
                    disposition: "existing" as const,
                }),
                reveal: async () => ({ disposition: "revealed" as const }),
            },
        },
        tool: {
            runner: { runBlock: async () => undefined, release: async () => undefined },
            surface: createDeniedSurface("detached_domain"),
            scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
        },
    }
    return {
        payloads,
        journal,
        vault,
        provider,
        compose,
        plan,
        draftRef,
        open: (readonly = false) =>
            openTaskShell({
                taskId: "prepared",
                openReason: "crash_recovery",
                execution,
                taskView: new InMemoryTaskViewPort(),
                persistence: { payloads, ports: { vault, journal, publications: new InMemoryCommandPublicationStore() } },
                deferRestoredCommands: readonly,
            }),
    }
}

// These tests catch retracting a frozen queue batch, rebuilding Retry from current settings,
// and performing recovery writes before the opening window owns the task.
describe("prepared round recovery through the production shell", () => {
    it.each([
        false,
        true,
    ])("recovers the checkpoint without recomposing or sending before Resume (draft write failed=%s)", async (draftFailure) => {
        const h = await fixture({ draftFailure })
        const opened = await h.open()
        await opened.shell.open()
        await opened.runtime.waitForQuiescence()
        const state = opened.runtime.getState()
        expect(state.flow.phase).toBe("paused")
        expect(h.provider).not.toHaveBeenCalled()
        expect(h.compose).not.toHaveBeenCalled()
        expect(state.roundMaterial).toEqual({ notices: [], feedback: [] })
        expect(state.intake.queued.map((entry) => [entry.entryId, entry.state, entry.queue?.delivery])).toEqual([
            ["input", "consumed", undefined],
        ])
        const recovered = decodeTaskPayload<ProviderDraftEnvelope>(await h.payloads.read(state.flow.compose!.draftRef!))
        expect(recovered.materialPlan).toEqual(h.plan)
        expect(recovered.journalThrough).toEqual((await h.journal.findByOperation("compose.prepared:compose"))!.watermark)
        if (!draftFailure) expect(state.flow.compose!.draftRef).toBe(h.draftRef)
        expect((await h.journal.project()).visibleMessages.map((entry) => entry.operationId)).toEqual([
            "material:round-material:compose:exit",
            "material:round-material:compose:intake:input",
            expect.stringMatching(/^intake\.retained:/),
            "compose.prepared:compose",
        ])

        const interaction = state.dialog.primary!
        const draftRef = await h.payloads.put(encodeTaskPayload({ kind: "dialog_draft", text: "", images: [], files: [] }))
        const response = await opened.shell.respond({
            type: "dialog.respond",
            taskId: state.taskId,
            turnId: interaction.turnId,
            interactionId: interaction.interactionId,
            stateRevision: state.revision,
            receiverGeneration: interaction.receiverGeneration!,
            actionId: "resume",
            draftRef,
            retryPreparedRound: true,
        })
        if (response.kind === "rejected") throw new Error(response.diagnostic.message)
        const resolved = await opened.runtime.submit({
            type: "dialog.resolved",
            generation: state.generation,
            interactionId: interaction.interactionId,
        })
        expect(resolved.kind).toBe("accepted")
        await opened.runtime.waitForQuiescence()
        expect(h.provider).toHaveBeenCalledTimes(1)
        expect(h.provider.mock.calls[0][0]).toMatchObject({ draftRef: state.flow.compose!.draftRef, turnId: "turn:compose" })
        expect(h.compose).not.toHaveBeenCalled()
    })

    it("reconstructs a lost derived draft from its journal checkpoint instead of rebuilding the task", async () => {
        const h = await fixture()
        const read = h.payloads.read.bind(h.payloads)
        const put = h.payloads.put.bind(h.payloads)
        let missing = true
        vi.spyOn(h.payloads, "read").mockImplementation((ref) =>
            missing && ref === h.draftRef ? Promise.reject(new Error("Draft missing")) : read(ref),
        )
        vi.spyOn(h.payloads, "put").mockImplementation(async (bytes) => {
            const ref = await put(bytes)
            if (ref === h.draftRef) missing = false
            return ref
        })
        const opened = await h.open()
        await opened.shell.open()
        expect(opened.runtime.getState().flow.compose?.materialPlan).toEqual(h.plan)
        expect(opened.runtime.getState().roundMaterial?.notices).toEqual([])
        expect(h.provider).not.toHaveBeenCalled()
        expect(h.compose).not.toHaveBeenCalled()
    })

    it("leaves a read-only opening untouched and recovers only after ownership is granted", async () => {
        const h = await fixture({ draftFailure: true })
        const before = await h.journal.read()
        const save = vi.spyOn(h.vault, "save")
        const put = vi.spyOn(h.payloads, "put")
        const opened = await h.open(true)
        await opened.runtime.waitForQuiescence()
        expect(save).not.toHaveBeenCalled()
        expect(put).not.toHaveBeenCalled()
        expect(await h.journal.read()).toEqual(before)
        expect(opened.runtime.getState().flow.compose!.draftRef).toBeUndefined()
        await opened.shell.open()
        expect(opened.runtime.getState().flow.compose!.draftRef).toBeDefined()
        expect(h.provider).not.toHaveBeenCalled()
    })

    it("discards an incomplete attempt, releases its queue and leaves its notices pending", async () => {
        const h = await fixture({ prepared: false })
        const opened = await h.open()
        await opened.shell.open()
        expect(opened.runtime.getState().flow.compose).toMatchObject({ draftRef: undefined, materialPlan: undefined })
        expect(opened.runtime.getState().intake.queued[0].state).toBe("released")
        expect(opened.runtime.getState().roundMaterial!.notices).toEqual(h.plan.notices)
        expect((await h.journal.project()).visibleMessages).toEqual([])
    })

    it.each([
        false,
        true,
    ])("preserves the terminated checkpoint and reconciles only on reopening (provider settled=%s)", async (providerSettled) => {
        const h = await fixture()
        const opened = await h.open()
        await opened.shell.open()
        await opened.runtime.waitForQuiescence()
        if (providerSettled) {
            await h.journal.append({
                operationId: "provider.final:provider",
                source: "provider",
                payloadRef: await h.payloads.put(encodeTaskPayload({ kind: "provider_final", text: "done" })),
                causation: { commandId: "provider", originRevision: 5, generation: 0, turnId: "turn:compose" },
            })
        }
        const before = await h.journal.read()
        const result = await opened.shell.terminate("close-task")
        expect(result.kind).toBe("accepted")
        expect(opened.runtime.getState().flow.phase).toBe("terminated")
        expect((await h.vault.load("prepared"))!.state.flow).toMatchObject({
            phase: "terminated",
            compose: { draftRef: h.draftRef, materialPlan: h.plan },
        })
        expect(await h.journal.read()).toEqual(before)

        const reopened = await h.open()
        await reopened.shell.open()
        await reopened.runtime.waitForQuiescence()
        expect(reopened.runtime.getState().flow.phase).toBe("paused")
        expect(reopened.runtime.getState().flow.compose?.draftRef).toBe(providerSettled ? undefined : h.draftRef)
        expect(reopened.runtime.getState().roundMaterial).toEqual({ notices: [], feedback: [] })
        expect(reopened.runtime.getState().intake.queued[0].state).toBe("consumed")
        expect(h.provider).not.toHaveBeenCalled()
        expect(h.compose).not.toHaveBeenCalled()
    })

    it("does not offer the old draft for resend after the provider journaled its final", async () => {
        const h = await fixture({ final: true })
        const opened = await h.open()
        await opened.shell.open()
        expect(opened.runtime.getState().flow.compose!.draftRef).toBeUndefined()
        expect(opened.runtime.getState().intake.queued[0].state).toBe("consumed")
        expect(h.provider).not.toHaveBeenCalled()
    })
})
