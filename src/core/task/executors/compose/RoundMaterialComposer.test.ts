import { describe, expect, it, vi } from "vitest"
import { serializeDurableToolResult } from "../../DurableToolResult"
import { createInitialTaskState, type RoundMaterialPlan, type TaskState } from "../../kernel"
import { InMemoryConversationJournal, InMemoryTaskPayloadStore } from "../../stores/InMemoryRuntimeStores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { ProviderDraftEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { JournalConversationView } from "../provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../provider/service/ProviderJournalMessageMaterializer"
import { ProductionComposeAdapter } from "./ProductionComposeAdapter"
import { RetainedInputJournalBatch } from "./RetainedInputJournalBatch"
import { RoundMaterialComposer } from "./RoundMaterialComposer"

function harness() {
    const payloads = new InMemoryTaskPayloadStore()
    const journal = new InMemoryConversationJournal()
    const view = new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads))
    return { payloads, journal, view, materials: new RoundMaterialComposer(payloads, journal) }
}

const signal = () => new AbortController().signal

describe("ordered round material journal projection", () => {
    it.each([
        true,
        false,
    ])("keeps paired results first, interleaves exits and accepted bodies, then environment and active tail (native=%s)", async (native) => {
        const h = harness()
        const result = {
            type: "tool_result" as const,
            function_id: "call",
            dline_tid: "block",
            content: [{ type: "text" as const, text: "executed" }],
        }
        await h.journal.append({
            operationId: "tool.result",
            source: "tool",
            payloadRef: await h.payloads.put(
                encodeTaskPayload({
                    kind: "tool_result",
                    blockId: "block",
                    content: serializeDurableToolResult(result, native ? undefined : { kind: "text", toolName: "read_file" }),
                }),
            ),
        })
        const first = await h.payloads.put(encodeTaskPayload({ kind: "user_input", text: "first-body" }))
        const next = await h.payloads.put(
            encodeTaskPayload({ kind: "dialog_draft", text: "approval-body", images: [], files: [], roundMaterialOwned: true }),
        )
        const plan: RoundMaterialPlan = {
            id: "plan",
            frozenRevision: 5,
            notices: [{ id: "exit", kind: "away_exited", revision: 2, reason: "stopped" }],
            inputs: [
                { id: "first", payloadRef: first, revision: 1, source: "intake" },
                { id: "next", payloadRef: next, revision: 3, source: "approval" },
            ],
            activeAway: { source: "command", enteredRevision: 3, modeRevocation: 0 },
        }
        await h.materials.appendBody(plan, signal())
        await h.materials.appendTail(plan, "environment", false, signal())
        const entries = await h.view.entries()
        expect(entries.map((entry) => entry.kind)).toEqual([
            "tool_result",
            "round_material_input",
            "round_notice",
            "round_material_input",
            "environment_details",
            "round_active_away",
        ])
        const pairedContent = entries[0].messages[0].content
        if (typeof pairedContent === "string") throw new Error("Expected structured result")
        const paired = pairedContent[0]
        if (native) expect(paired).toMatchObject({ type: "tool_result", function_id: "call", dline_tid: "block" })
        else expect(paired.type).toBe("text")
        const bodies = entries
            .filter((entry) => entry.kind === "round_material_input")
            .map((entry) => {
                const body = entry.messages[0].content
                if (typeof body === "string") throw new Error("Expected structured input")
                const content = body[0]
                if (content.type !== "text") throw new Error("Expected text body")
                return /^<user_message>\n([\s\S]*)\n<\/user_message>$/.exec(content.text)?.[1]
            })
        expect(bodies).toEqual(["first-body", "approval-body"])
        const before = await h.journal.read()
        await h.materials.appendBody(plan, signal())
        await h.materials.appendTail(plan, "changed environment", true, signal())
        expect(await h.journal.read()).toEqual(before)
    })

    it("batches acceptance identities without taking other materials that share their bytes", async () => {
        const h = harness()
        const payloadRef = await h.payloads.put(encodeTaskPayload({ kind: "user_input", text: "SAME_BODY" }))
        const entries = ["first", "second"].map((entryId) => ({ entryId, payloadRef }))
        const batch = await new RetainedInputJournalBatch(h.payloads, h.journal).stage({
            deliveryId: "delivery",
            entries,
            generation: 0,
            signal: signal(),
            roundMaterialOwned: true,
        })
        const plan: RoundMaterialPlan = {
            id: "plan",
            frozenRevision: 2,
            notices: [],
            inputs: [
                ...entries.map((entry) => ({ ...entry, id: entry.entryId, revision: 1, source: "intake" as const })),
                { id: "ordinary", entryId: "other-entry", payloadRef, revision: 2, source: "intake" },
            ],
        }
        await h.materials.appendBody(plan, signal(), [batch])
        const view = await h.view.entries()
        const text = JSON.stringify(view.flatMap((entry) => [...entry.messages]))
        expect(text.match(/SAME_BODY/g)).toHaveLength(3)
        expect(text.match(/sent by the user while work was in progress/g)).toHaveLength(1)
        expect(view.filter((entry) => entry.kind === "round_material_input")).toHaveLength(2)
        const before = await h.journal.read()
        await new RoundMaterialComposer(h.payloads, h.journal).appendBody(plan, signal(), [batch])
        expect(await h.journal.read()).toEqual(before)
    })

    it.each([
        "payload",
        "membership",
    ] as const)("refuses a batch/plan %s conflict before appending any material", async (conflict) => {
        const h = harness()
        const refs = await Promise.all(
            ["FIRST", "SECOND"].map(async (text) => h.payloads.put(encodeTaskPayload({ kind: "user_input", text }))),
        )
        const entries = refs.map((payloadRef, index) => ({ entryId: `entry-${index}`, payloadRef }))
        const batch = await new RetainedInputJournalBatch(h.payloads, h.journal).stage({
            deliveryId: "delivery",
            entries,
            generation: 0,
            signal: signal(),
            roundMaterialOwned: true,
        })
        const inputs: RoundMaterialPlan["inputs"] = entries.map((entry, index) => ({
            ...entry,
            id: entry.entryId,
            source: "intake",
            revision: index * 2,
            ...(conflict === "payload" && index === 1 ? { payloadRef: refs[0] } : {}),
        }))
        const plan: RoundMaterialPlan = {
            id: "plan",
            frozenRevision: 4,
            inputs: conflict === "membership" ? inputs.slice(0, 1) : inputs,
            notices: [],
        }
        const before = await h.journal.read()
        await expect(h.materials.appendBody(plan, signal(), [batch])).rejects.toThrow("RetainedMaterialIdentityConflict")
        expect(await h.journal.read()).toEqual(before)
    })

    it.each([
        false,
        true,
    ])("preserves interleaved material revisions after retained inputs were released and selected again (reordered=%s)", async (reordered) => {
        const h = harness()
        const refs = await Promise.all(
            ["FIRST", "SECOND"].map(async (text) => h.payloads.put(encodeTaskPayload({ kind: "user_input", text }))),
        )
        const entries = refs.map((payloadRef, index) => ({ entryId: `entry-${index}`, payloadRef }))
        const batch = await new RetainedInputJournalBatch(h.payloads, h.journal).stage({
            deliveryId: "delivery",
            entries,
            generation: 0,
            signal: signal(),
            roundMaterialOwned: true,
        })
        const plan: RoundMaterialPlan = {
            id: "plan",
            frozenRevision: 4,
            inputs: entries.map((entry, index) => ({
                ...entry,
                id: entry.entryId,
                revision: reordered ? 2 - index * 2 : index * 2,
                source: "intake",
            })),
            notices: [{ id: "exit", kind: "away_exited", revision: 1, reason: "stopped" }],
        }
        await h.materials.appendBody(plan, signal(), [batch])
        const visible = (await h.view.entries()).filter((entry) => entry.messages.length > 0)
        expect(visible.map((entry) => entry.kind)).toEqual(["round_material_input", "round_notice", "round_material_input"])
        expect(JSON.stringify(visible[0].messages)).toContain(reordered ? "SECOND" : "FIRST")
        expect(JSON.stringify(visible[2].messages)).toContain(reordered ? "FIRST" : "SECOND")
        expect(JSON.stringify(visible).match(/sent by the user while work was in progress/g)).toHaveLength(1)
        const before = await h.journal.read()
        await new RoundMaterialComposer(h.payloads, h.journal).appendBody(plan, signal(), [batch])
        expect(await h.journal.read()).toEqual(before)
    })

    it("does not append split material after cancellation during its derived input write", async () => {
        const h = harness()
        const entries = await Promise.all(
            ["FIRST", "SECOND"].map(async (text) => ({
                entryId: text,
                payloadRef: await h.payloads.put(encodeTaskPayload({ kind: "user_input", text })),
            })),
        )
        const batch = await new RetainedInputJournalBatch(h.payloads, h.journal).stage({
            deliveryId: "delivery",
            entries,
            generation: 0,
            signal: signal(),
            roundMaterialOwned: true,
        })
        const plan: RoundMaterialPlan = {
            id: "plan",
            frozenRevision: 4,
            inputs: entries.map((entry, index) => ({ ...entry, id: entry.entryId, revision: index * 2, source: "intake" })),
            notices: [{ id: "between", kind: "away_exited", revision: 1, reason: "stopped" }],
        }
        const controller = new AbortController()
        const put = h.payloads.put.bind(h.payloads)
        vi.spyOn(h.payloads, "put").mockImplementation(async (bytes) => {
            const ref = await put(bytes)
            controller.abort("cancel after projection")
            return ref
        })
        await expect(h.materials.appendBody(plan, controller.signal, [batch])).rejects.toBe("cancel after projection")
        expect((await h.journal.read()).map((entry) => entry.operationId)).toEqual(["intake.retained:delivery"])
        expect(await h.view.messages()).toEqual([])
    })

    it("recovers the exact draft after the checkpoint commits but draft storage fails", async () => {
        const h = harness()
        const plan: RoundMaterialPlan = { id: "plan", frozenRevision: 1, notices: [], inputs: [] }
        const draft: ProviderDraftEnvelope = {
            kind: "provider_draft",
            admittedEntryIds: [],
            inputPayloadRefs: [],
            materialPlan: plan,
        }
        const put = h.payloads.put.bind(h.payloads)
        const broken = vi.spyOn(h.payloads, "put").mockImplementation(async (bytes) => {
            if (decodeTaskPayload<{ kind: string }>(bytes).kind === "provider_draft") throw new Error("Draft write failed")
            return put(bytes)
        })
        await expect(h.materials.prepare("compose", draft)).rejects.toThrow("Draft write failed")
        broken.mockRestore()
        const prepared = await new RoundMaterialComposer(h.payloads, h.journal).prepared("compose")
        const recovered = decodeTaskPayload<ProviderDraftEnvelope>(await h.payloads.read(prepared!.draftRef))
        expect(recovered).toEqual({ ...draft, journalThrough: { seq: 1 } })
        await h.journal.append({
            operationId: "later",
            source: "system",
            payloadRef: await put(encodeTaskPayload({ kind: "environment_details", text: "later" })),
        })
        expect((await h.materials.prepared("compose"))!.draftRef).toBe(prepared!.draftRef)
    })

    it("returns the committed prepared round when only its first derived draft write fails", async () => {
        const h = harness()
        const plan: RoundMaterialPlan = {
            id: "round-material:compose",
            frozenRevision: 1,
            inputs: [],
            notices: [{ id: "exit", kind: "away_exited", revision: 1, reason: "stopped" }],
        }
        let fail = true
        const put = h.payloads.put.bind(h.payloads)
        vi.spyOn(h.payloads, "put").mockImplementation(async (bytes) => {
            if (fail && decodeTaskPayload<{ kind: string }>(bytes).kind === "provider_draft") {
                fail = false
                throw new Error("Draft write failed once")
            }
            return put(bytes)
        })
        const adapter = new ProductionComposeAdapter({
            payloads: h.payloads,
            journal: h.journal,
            readState: () => createInitialTaskState("live"),
        })
        const composed = await adapter.compose({
            admittedEntryIds: [],
            signal: signal(),
            composeCommandId: "compose",
            freezeMaterial: async () => plan,
        })
        expect(composed).toMatchObject({ draftRef: expect.any(String) })
        expect((await h.view.entries()).map((entry) => entry.kind)).toEqual(["round_notice", "round_prepared"])
        expect(await adapter.compose({ admittedEntryIds: [], signal: signal(), composeCommandId: "compose" })).toEqual(composed)
    })

    it("does not consume pending notices when the request guard refuses the draft", async () => {
        const h = harness()
        const base = createInitialTaskState("guard")
        const plan: RoundMaterialPlan = {
            id: "round-material:compose",
            frozenRevision: 1,
            inputs: [],
            notices: [{ id: "exit", kind: "away_exited", revision: 1, reason: "stopped" }],
        }
        const state: TaskState = { ...base, roundMaterial: { feedback: [], notices: plan.notices } }
        const adapter = new ProductionComposeAdapter({
            payloads: h.payloads,
            journal: h.journal,
            readState: () => state,
            contextWindowGuard: { admit: async () => ({ kind: "failed", reason: "context-full" }) },
        })
        expect(
            await adapter.compose({
                admittedEntryIds: [],
                signal: signal(),
                composeCommandId: "compose",
                freezeMaterial: async () => plan,
            }),
        ).toEqual({ failed: { kind: "failed", reason: "context-full" } })
        expect(state.roundMaterial!.notices).toEqual(plan.notices)
        expect((await h.view.messages()).length).toBe(0)
        expect(await h.materials.prepared("compose")).toBeUndefined()
    })
})
