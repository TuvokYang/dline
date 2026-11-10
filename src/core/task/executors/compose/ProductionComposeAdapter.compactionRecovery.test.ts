import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import { JournalCompactionConversation } from "../../compaction/JournalCompactionConversation"
import { serializeDurableToolResult } from "../../DurableToolResult"
import { type ComposeRoundCommand, createInitialTaskState, type TaskEvent, type TaskState, transition } from "../../kernel"
import { InMemoryConversationJournal, InMemoryStateVault, InMemoryTaskPayloadStore } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { ProviderDraftEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { JournalConversationView } from "../provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../provider/service/ProviderJournalMessageMaterializer"
import { ComposeCommandExecutor } from "./ComposeCommandExecutor"
import { ProductionComposeAdapter } from "./ProductionComposeAdapter"

const TASK = "FORCE_TASK"
const MIDDLE = "FORCE_MIDDLE"
const CONTINUE = "FORCE_CONTINUE"
const NOTICE = "TRUNCATION_NOTICE"

async function history(journal: InMemoryConversationJournal, payloads: InMemoryTaskPayloadStore) {
    for (const [index, text] of [TASK, MIDDLE].entries()) {
        const inputRef = await payloads.put(encodeTaskPayload({ kind: "user_input", text }))
        await journal.append({
            operationId: `material:${index}`,
            source: "system",
            payloadRef: await payloads.put(
                encodeTaskPayload({
                    kind: "round_material_input",
                    planId: `plan:${index}`,
                    materialId: `input:${index}`,
                    inputRef,
                }),
            ),
        })
        const functionId = `call:${index}`
        await journal.append({
            operationId: `provider:${index}`,
            source: "provider",
            payloadRef: await payloads.put(
                encodeTaskPayload({
                    kind: "provider_final",
                    content: [
                        { type: "tool_use", function_id: functionId, dline_tid: functionId, name: "qna_respond", input: {} },
                    ],
                    turnPlan: { mode: "serial", blocks: [] },
                }),
            ),
        })
        await journal.append({
            operationId: `result:${index}`,
            source: "tool",
            payloadRef: await payloads.put(
                encodeTaskPayload({
                    kind: "tool_result",
                    blockId: functionId,
                    content: serializeDurableToolResult({
                        type: "tool_result",
                        function_id: functionId,
                        dline_tid: functionId,
                        content: "Response received.",
                    }),
                }),
            ),
        })
    }
}

function paired(messages: readonly ClineStorageMessage[]): boolean {
    const calls = new Set<string>()
    for (const message of messages) {
        for (const block of typeof message.content === "string" ? [] : message.content) {
            if (block.type === "tool_use") calls.add(block.function_id)
            if (block.type === "tool_result" && !calls.delete(block.function_id)) return false
        }
    }
    return calls.size === 0
}

describe("pending reply through failed compaction and truncation", () => {
    it.each([
        "barrier",
        "admission",
    ] as const)("carries the reply once after a %s failure and snapshot reload", async (failure) => {
        const journal = new InMemoryConversationJournal()
        const payloads = new InMemoryTaskPayloadStore()
        const vault = new InMemoryStateVault()
        await history(journal, payloads)
        const feedbackRef = await payloads.put(
            encodeTaskPayload({ kind: "dialog_draft", text: CONTINUE, images: [], files: [], roundMaterialOwned: true }),
        )
        let state: TaskState = {
            ...createInitialTaskState("force-recovery"),
            revision: 4,
            intake: { queued: [], background: [], coTask: [] },
            roundMaterial: {
                notices: [],
                feedback: [{ id: "reply:continue", source: "dialog", revision: 3, payloadRef: feedbackRef }],
            },
            flow: {
                phase: "running",
                compose: { commandId: "before", originRevision: 3, status: "running", admittedEntryIds: [] },
            },
        }
        const feedback = structuredClone(state.roundMaterial!.feedback)
        const events: TaskEvent[] = []
        const sink = {
            submit: async (event: TaskEvent) => {
                const reduced = transition(state, event)
                if (reduced.kind !== "accepted") throw new Error(reduced.diagnostic.message)
                state = reduced.state
                events.push(event)
                return {
                    kind: "accepted" as const,
                    durable: Promise.resolve(),
                    ...(event.type === "compose.freeze_requested" ? { materialPlan: state.flow.compose!.materialPlan } : {}),
                }
            },
        }
        const command = (commandId: string, originRevision: number): ComposeRoundCommand => ({
            type: "compose.round",
            commandId,
            originRevision,
            generation: state.generation,
            admittedEntryIds: [],
        })
        const view = () => new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads))
        const options = { payloads, journal, readState: () => state }
        const adapter = new ProductionComposeAdapter({
            ...options,
            ...(failure === "barrier"
                ? {
                      compactionBarrier: {
                          settleBeforeRound: async () => ({ kind: "failed" as const, reason: "automatic_compaction_failed" }),
                      },
                  }
                : {
                      contextWindowGuard: {
                          admit: async () => ({ kind: "failed" as const, reason: "automatic_compaction_failed" }),
                      },
                  }),
        })
        await new ComposeCommandExecutor(adapter, sink).execute(command("before", 3))
        expect(events.at(-1)?.type).toBe("compose.failed")
        expect(state.roundMaterial!.feedback).toEqual(feedback)
        expect(JSON.stringify(await view().messages())).not.toContain(CONTINUE)
        expect(await journal.findByOperation("compose.prepared:before")).toBeUndefined()

        // Reload the actual snapshot contract in memory, not an OS process or a browser.
        await vault.save({ state, outbox: [] })
        const loaded = await vault.load("force-recovery")
        if (!loaded) throw new Error("Missing failed-round snapshot")
        state = loaded.state
        expect(state.roundMaterial!.feedback).toEqual(feedback)
        const compaction = new JournalCompactionConversation(journal, payloads, view())
        expect(await compaction.truncate({ notice: NOTICE })).toBeDefined()
        const truncated = JSON.stringify(await view().messages())
        expect(truncated).toContain(TASK)
        expect(truncated).toContain(NOTICE)
        expect(truncated).not.toContain(MIDDLE)
        expect(truncated).not.toContain(CONTINUE)

        // The Retry/UI protocol has separate coverage. Supply its next compose owner,
        // without any new input, so only the preserved feedback can carry this body.
        const originRevision = state.revision
        state = {
            ...state,
            flow: {
                phase: "running",
                compose: { commandId: "retry", originRevision, status: "running", admittedEntryIds: [] },
            },
        }
        await new ComposeCommandExecutor(new ProductionComposeAdapter(options), sink).execute(command("retry", originRevision))
        const completed = events.at(-1)
        if (completed?.type !== "compose.completed") throw new Error("Retry did not prepare a draft")
        const draft = decodeTaskPayload<ProviderDraftEnvelope>(await payloads.read(completed.draftRef))
        const messages = await view().messages(draft.journalThrough)
        expect(JSON.stringify(messages.filter((message) => message.role === "user")).match(/FORCE_CONTINUE/g)).toHaveLength(1)
        expect(JSON.stringify(messages)).not.toContain(MIDDLE)
        expect(JSON.stringify(messages).match(/TRUNCATION_NOTICE/g)).toHaveLength(1)
        expect(paired(messages)).toBe(true)
        expect(state.roundMaterial!.feedback).toEqual([])
    })
})
