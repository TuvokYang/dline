import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { parseDurableToolResult, serializeDurableToolResult } from "../../DurableToolResult"
import type { ExplicitInstructionDeclaration } from "../../explicit-instructions/types"
import { createInitialTaskState, type ToolTerminalManifest } from "../../kernel"
import { declinedNewTaskDenialResponse } from "../../new-task/new-task-answer"
import { deriveNewTaskFeedbackContinuationFromConversation } from "../../new-task/new-task-continuation"
import { InMemoryConversationJournal, InMemoryTaskPayloadStore } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type {
    DialogDraftEnvelope,
    DialogPresentationEnvelope,
    ProviderDraftEnvelope,
    ToolInvocationEnvelope,
    ToolResultEnvelope,
    ToolTerminalManifestEnvelope,
} from "../../stores/payload/TaskPayloadEnvelopes"
import { JournalConversationView } from "../provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../provider/service/ProviderJournalMessageMaterializer"
import { ProductionComposeAdapter } from "./ProductionComposeAdapter"
import { materializeToolTerminalManifest } from "./ToolTerminalManifestMaterializer"

const TURN_ID = "turn-tools"

type MaterializedContent = {
    readonly type: string
    readonly dline_tid?: string
    readonly is_error?: boolean
    readonly content?: string | readonly { readonly type: string; readonly text?: string }[]
    readonly text?: string
}

function invocation(blockId: string): ToolInvocationEnvelope {
    return {
        kind: "tool_invocation",
        toolName: "read_file",
        input: { path: `${blockId}.ts` },
        functionId: `function:${blockId}`,
        dlineTid: blockId,
        presentationId: Number(blockId.slice(1)) + 1,
        isNativeToolCall: true,
    }
}

function result(blockId: string, text: string, failed = false): ToolResultEnvelope {
    return {
        kind: "tool_result",
        blockId,
        content: serializeDurableToolResult({
            type: "tool_result",
            function_id: `function:${blockId}`,
            dline_tid: blockId,
            content: [{ type: "text", text }],
            ...(failed ? { is_error: true } : {}),
        }),
        ...(failed ? { failed: true } : {}),
    }
}

async function appendRawResult(
    journal: InMemoryConversationJournal,
    payloads: InMemoryTaskPayloadStore,
    blockId: string,
    text: string,
    failed = false,
): Promise<string> {
    const payloadRef = await payloads.put(encodeTaskPayload(result(blockId, text, failed)))
    await journal.append({
        operationId: `raw-result:${blockId}`,
        payloadRef,
        source: "tool",
        causation: { turnId: TURN_ID },
    })
    return payloadRef
}

function resultText(block: MaterializedContent): string {
    if (typeof block.content === "string") return block.content
    return (block.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n")
}

describe("ToolTerminalManifestMaterializer feedback inputs", () => {
    // A queued answer never lands as intake; without the manifest's record a later
    // round of the same work lost the authority the user's command granted.
    it("records admitted answers so later rounds read their authority without rendering them again", async () => {
        const payloads = new InMemoryTaskPayloadStore()
        const journal = new InMemoryConversationJournal()
        const invocationRef = await payloads.put(encodeTaskPayload(invocation("b0")))
        await appendRawResult(journal, payloads, "b0", "answered")
        const declaration = {
            type: "report_bug",
            source: "slash_command",
            targetTool: DlineDefaultTool.REPORT_BUG,
            operationId: "op-report",
        } as ExplicitInstructionDeclaration
        const answerRef = await payloads.put(
            encodeTaskPayload({ kind: "user_input", text: "/cmd:reportbug details", explicitInstructions: [declaration] }),
        )
        const manifest = { turnId: TURN_ID, blocks: [{ blockId: "b0", phase: "completed", invocationRef }] } as never

        const first = await materializeToolTerminalManifest({ manifest, payloads, journal, feedbackInputRefs: [answerRef] })
        const replay = await materializeToolTerminalManifest({ manifest, payloads, journal })

        expect(first.feedbackInputRefs).toEqual([answerRef])
        expect(replay).toEqual(first)
        const entry = await journal.findByOperation(`tool.terminal_manifest:${TURN_ID}`)
        const materialized = await new ProviderJournalMessageMaterializer(payloads).materializeEntry(entry!.payloadRef!)
        expect(materialized.explicitInstructions).toEqual([declaration])
        const blockTypes = materialized.messages.flatMap((message) =>
            Array.isArray(message.content) ? message.content.map((block) => block.type) : [],
        )
        expect(blockTypes).toEqual(["tool_result"])
    })

    it("writes no feedback record when nothing answered the turn", async () => {
        const payloads = new InMemoryTaskPayloadStore()
        const journal = new InMemoryConversationJournal()
        const invocationRef = await payloads.put(encodeTaskPayload(invocation("b0")))
        await appendRawResult(journal, payloads, "b0", "answered")
        const manifest = { turnId: TURN_ID, blocks: [{ blockId: "b0", phase: "completed", invocationRef }] } as never

        const terminals = await materializeToolTerminalManifest({ manifest, payloads, journal })

        expect(terminals.feedbackInputRefs).toEqual([])
        const entry = await journal.findByOperation(`tool.terminal_manifest:${TURN_ID}`)
        const envelope = decodeTaskPayload<ToolTerminalManifestEnvelope>(await payloads.read(entry!.payloadRef!))
        expect(envelope.feedbackInputRefs).toBeUndefined()
        const materialized = await new ProviderJournalMessageMaterializer(payloads).materializeEntry(entry!.payloadRef!)
        expect(materialized.explicitInstructions).toBeUndefined()
    })
})

describe("ToolTerminalManifestMaterializer refusal wording", () => {
    it("reports a user refusal in the tool's own words and keeps a policy refusal generic", async () => {
        const payloads = new InMemoryTaskPayloadStore()
        const journal = new InMemoryConversationJournal()
        const userRef = await payloads.put(encodeTaskPayload(invocation("b0")))
        const policyRef = await payloads.put(encodeTaskPayload(invocation("b1")))
        const described: string[] = []

        await materializeToolTerminalManifest({
            manifest: {
                turnId: TURN_ID,
                blocks: [
                    { blockId: "b0", phase: "rejected", invocationRef: userRef, deniedByUser: true },
                    { blockId: "b1", phase: "rejected", invocationRef: policyRef },
                ],
            },
            payloads,
            journal,
            denial: {
                describe: async (invocationRef) => {
                    described.push(invocationRef)
                    return { text: "The user denied this operation. The file was not updated.", isError: true }
                },
            },
        })

        const entry = await journal.findByOperation(`tool.terminal_manifest:${TURN_ID}`)
        const envelope = decodeTaskPayload<ToolTerminalManifestEnvelope>(await payloads.read(entry!.payloadRef!))
        const results = envelope.results.map(
            (terminal) => parseDurableToolResult(terminal.content) as unknown as MaterializedContent,
        )
        expect(described).toEqual([userRef])
        expect(results.map(resultText)).toEqual([
            "The user denied this operation. The file was not updated.",
            "Tool call rejected; it was not admitted or executed.",
        ])
        expect(results.map((result) => result.is_error)).toEqual([true, true])
    })

    // A declined New Task answers the call with the user's feedback. Materialized
    // as an error, the next round refused the continuation, so the model's second
    // proposal failed with `explicit_instruction_missing` and Start New Task never
    // opened the successor.
    it("materializes a declined New Task so the next round may propose it again", async () => {
        const payloads = new InMemoryTaskPayloadStore()
        const journal = new InMemoryConversationJournal()
        const call: ToolInvocationEnvelope = {
            ...invocation("b0"),
            toolName: "new_task",
            input: { task: "Successor task", context: "Successor context" },
        }
        const invocationRef = await payloads.put(encodeTaskPayload(call))
        const feedbackRef = await payloads.put(
            encodeTaskPayload<DialogDraftEnvelope>({ kind: "dialog_draft", text: "KEEP_COMPATIBILITY", images: [], files: [] }),
        )
        const adapter = new ProductionComposeAdapter({
            payloads,
            journal,
            readState: () => createInitialTaskState("task-1"),
            toolDenial: { describe: async () => ({ text: declinedNewTaskDenialResponse(), isError: false }) },
        })

        const composed = await adapter.compose({
            turnId: "turn-next",
            admittedEntryIds: [],
            toolTerminals: {
                turnId: TURN_ID,
                blocks: [
                    { blockId: "b0", phase: "rejected", invocationRef, deniedByUser: true, approvalFeedbackRef: feedbackRef },
                ],
            },
            signal: new AbortController().signal,
        })
        if (!("draftRef" in composed)) throw new Error("Expected a provider draft")
        const draft = decodeTaskPayload<ProviderDraftEnvelope>(await payloads.read(composed.draftRef))
        const view = new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads))
        const messages = await view.messages(draft.journalThrough)
        const [declined] = messages
            .flatMap((message) => (message.content ?? []) as readonly MaterializedContent[])
            .filter((block) => block.type === "tool_result")

        expect(declined?.is_error).not.toBe(true)
        expect(resultText(declined!)).toContain("KEEP_COMPATIBILITY")
        const assistant = {
            role: "assistant" as const,
            content: [
                { type: "tool_use" as const, name: "new_task", function_id: call.functionId, dline_tid: "b0", input: call.input },
            ],
        }
        expect(deriveNewTaskFeedbackContinuationFromConversation([assistant, ...messages] as never)).toMatchObject({
            type: "new_task",
            operationId: "new-task-feedback:b0",
        })
    })
})

describe("ToolTerminalManifestMaterializer", () => {
    it("keeps raw arrival facts while projecting one ordered and idempotent terminal tool batch", async () => {
        const payloads = new InMemoryTaskPayloadStore()
        const journal = new InMemoryConversationJournal()
        const invocationRefs = new Map<string, string>()
        for (const blockId of ["b0", "b1", "b2", "b3", "b4"]) {
            invocationRefs.set(blockId, await payloads.put(encodeTaskPayload(invocation(blockId))))
        }

        // Physical completion order is intentionally different from provider block order.
        const failedRef = await appendRawResult(journal, payloads, "b2", "failed:b2", true)
        const completedRef = await appendRawResult(journal, payloads, "b0", "completed:b0")
        const lateSuccessRef = await appendRawResult(journal, payloads, "b3", "late success must not become canonical")
        const feedbackRef = await payloads.put(
            encodeTaskPayload<DialogDraftEnvelope>({
                kind: "dialog_draft",
                text: "reject b1 and keep the audit note",
                images: [],
                files: [],
            }),
        )
        await journal.append({
            operationId: "raw-feedback:b1",
            payloadRef: feedbackRef,
            source: "dialog",
            causation: { turnId: TURN_ID, interactionId: "b1" },
        })

        const manifest: ToolTerminalManifest = {
            turnId: TURN_ID,
            blocks: [
                { blockId: "b0", phase: "completed", invocationRef: invocationRefs.get("b0")! },
                {
                    blockId: "b1",
                    phase: "rejected",
                    invocationRef: invocationRefs.get("b1")!,
                    approvalFeedbackRef: feedbackRef,
                },
                { blockId: "b2", phase: "failed", invocationRef: invocationRefs.get("b2")! },
                { blockId: "b3", phase: "cancelled", invocationRef: invocationRefs.get("b3")! },
                { blockId: "b4", phase: "skipped", invocationRef: invocationRefs.get("b4")! },
            ],
        }
        const adapter = new ProductionComposeAdapter({
            payloads,
            journal,
            readState: () => createInitialTaskState("task-1"),
        })
        const input = {
            turnId: "turn-next",
            admittedEntryIds: [],
            toolTerminals: manifest,
            signal: new AbortController().signal,
        }

        const first = await adapter.compose(input)
        const second = await adapter.compose(input)
        if (!("draftRef" in first) || !("draftRef" in second)) throw new Error("Expected provider drafts")
        const firstDraft = decodeTaskPayload<ProviderDraftEnvelope>(await payloads.read(first.draftRef))
        const secondDraft = decodeTaskPayload<ProviderDraftEnvelope>(await payloads.read(second.draftRef))
        expect(secondDraft.journalThrough).toEqual(firstDraft.journalThrough)

        const physical = await journal.read()
        const rawResultEntries = physical.filter((entry) => entry.operationId.startsWith("raw-result:"))
        const rawBlockIds = await Promise.all(
            rawResultEntries.map(async (entry) => {
                if (!entry.payloadRef) throw new Error("Raw result missing payload")
                return decodeTaskPayload<ToolResultEnvelope>(await payloads.read(entry.payloadRef)).blockId
            }),
        )
        expect(rawBlockIds).toEqual(["b2", "b0", "b3"])
        expect(physical.filter((entry) => entry.operationId === `tool.terminal_manifest:${TURN_ID}`)).toHaveLength(1)

        const manifestEntry = await journal.findByOperation(`tool.terminal_manifest:${TURN_ID}`)
        if (!manifestEntry?.payloadRef) throw new Error("Missing terminal manifest")
        const envelope = decodeTaskPayload<ToolTerminalManifestEnvelope>(await payloads.read(manifestEntry.payloadRef))
        expect(envelope.results.map(({ blockId, phase, failed }) => ({ blockId, phase, failed }))).toEqual([
            { blockId: "b0", phase: "completed", failed: undefined },
            { blockId: "b1", phase: "rejected", failed: true },
            { blockId: "b2", phase: "failed", failed: true },
            { blockId: "b3", phase: "cancelled", failed: true },
            { blockId: "b4", phase: "skipped", failed: true },
        ])
        expect(new Set(envelope.supersededPayloadRefs)).toEqual(new Set([completedRef, feedbackRef, failedRef, lateSuccessRef]))

        const view = new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads))
        const messages = await view.messages(firstDraft.journalThrough)
        expect(messages).toHaveLength(1)
        const content = (messages[0]?.content ?? []) as readonly MaterializedContent[]
        const toolResults = content.filter((block) => block.type === "tool_result")
        expect(toolResults.map((block) => block.dline_tid)).toEqual(["b0", "b1", "b2", "b3", "b4"])
        expect(toolResults.map(resultText)).toEqual([
            "completed:b0",
            "Tool call rejected; it was not admitted or executed.\nThe user provided the following feedback:\n<feedback>\nreject b1 and keep the audit note\n</feedback>",
            "failed:b2",
            "Tool call cancelled before a canonical result was accepted. Verify observable state before retrying.",
            "Tool call skipped because an earlier call ended or rejected the turn; it was not executed.",
        ])
        // The approval feedback travels inside the rejected call's result, not beside it.
        expect(content.filter((block) => block.type !== "tool_result")).toEqual([])
        expect(JSON.stringify(messages)).not.toContain("late success must not become canonical")
        expect(JSON.stringify(decodeTaskPayload(await payloads.read(lateSuccessRef)))).toContain(
            "late success must not become canonical",
        )
    })

    // A completion stopping kept open is answered after the stop already wrote
    // its failure: the answer is the call's one result, as dev replaces the
    // interrupted result with the restored completion feedback.
    it("projects the restored answer of a cancelled block as its only result", async () => {
        const payloads = new InMemoryTaskPayloadStore()
        const journal = new InMemoryConversationJournal()
        const invocationRef = await payloads.put(encodeTaskPayload(invocation("b0")))
        const failedRef = await appendRawResult(journal, payloads, "b0", "dialog_terminate", true)
        const restoredRef = await payloads.put(encodeTaskPayload(result("b0", "<feedback>\nRESTORED_REPLY\n</feedback>")))
        await journal.append({
            operationId: `tool.restored_result:${TURN_ID}:b0`,
            payloadRef: restoredRef,
            source: "tool",
            causation: { turnId: TURN_ID },
        })

        await materializeToolTerminalManifest({
            manifest: { turnId: TURN_ID, blocks: [{ blockId: "b0", phase: "cancelled", invocationRef }] } as never,
            payloads,
            journal,
        })

        const manifestEntry = await journal.findByOperation(`tool.terminal_manifest:${TURN_ID}`)
        const envelope = decodeTaskPayload<ToolTerminalManifestEnvelope>(await payloads.read(manifestEntry!.payloadRef!))
        expect(envelope.results).toHaveLength(1)
        expect(envelope.results[0]?.content).toContain("RESTORED_REPLY")
        expect(envelope.results[0]?.content).not.toContain("Tool call cancelled")
        expect(envelope.results[0]?.failed).toBeUndefined()
        expect(new Set(envelope.supersededPayloadRefs)).toEqual(new Set([failedRef, restoredRef]))
    })

    // The manifest replaces the raw result, so it must keep the attached PDFs the
    // raw result referenced and charge them to the next request's growth.
    it("carries the documents of a raw result and counts them in the projected growth", async () => {
        const payloads = new InMemoryTaskPayloadStore()
        const journal = new InMemoryConversationJournal()
        const invocationRef = await payloads.put(encodeTaskPayload(invocation("b0")))
        const documentRef = await payloads.put(
            encodeTaskPayload({
                kind: "attached_document",
                document: {
                    type: "attached_document",
                    path: "/work/spec.pdf",
                    media_type: "application/pdf",
                    data: "JVBERi0xLjQKJSVFT0YK",
                    byte_length: 16,
                    page_count: 3,
                    fallback_text: "Hello PDF",
                },
            }),
        )
        const plain = result("b0", "answered")
        await journal.append({
            operationId: "raw-result:b0",
            payloadRef: await payloads.put(encodeTaskPayload({ ...plain, documentPayloadRefs: [documentRef] })),
            source: "tool",
            causation: { turnId: TURN_ID },
        })
        const manifest = { turnId: TURN_ID, blocks: [{ blockId: "b0", phase: "completed", invocationRef }] } as never

        const { tokens: growth } = await materializeToolTerminalManifest({ manifest, payloads, journal })

        const manifestEntry = await journal.findByOperation(`tool.terminal_manifest:${TURN_ID}`)
        const envelope = decodeTaskPayload<ToolTerminalManifestEnvelope>(await payloads.read(manifestEntry!.payloadRef!))
        expect(envelope.results[0]?.documentPayloadRefs).toEqual([documentRef])
        const textOnly = Math.ceil(Buffer.byteLength(plain.content, "utf8") / 4)
        expect(growth).toBeGreaterThan(textOnly)
        // A replayed manifest reports the same growth instead of dropping the documents.
        const replayed = await materializeToolTerminalManifest({ manifest, payloads, journal })
        expect(replayed.tokens).toBe(growth)
    })

    // A completion's dialog is keyed by its block, so the dialog's own presentation
    // shares the call's turn and interaction. Reading it as the user's approval
    // feedback made the next request fail to materialize, and a restored
    // completion answered from a panel never reached the provider.
    it("does not mistake a dialog's own presentation for the call's approval feedback", async () => {
        const payloads = new InMemoryTaskPayloadStore()
        const journal = new InMemoryConversationJournal()
        const invocationRef = await payloads.put(encodeTaskPayload(invocation("b0")))
        await appendRawResult(journal, payloads, "b0", "completed:b0")
        const presentationRef = await payloads.put(
            encodeTaskPayload<DialogPresentationEnvelope>({
                kind: "dialog_presentation",
                presentationKind: "completion",
                body: "E2E completion result",
            }),
        )
        await journal.append({
            operationId: "dialog.prepare:b0",
            payloadRef: presentationRef,
            source: "dialog",
            causation: { turnId: TURN_ID, interactionId: "b0" },
        })
        const adapter = new ProductionComposeAdapter({
            payloads,
            journal,
            readState: () => createInitialTaskState("task-1"),
        })

        const composed = await adapter.compose({
            turnId: "turn-next",
            admittedEntryIds: [],
            toolTerminals: { turnId: TURN_ID, blocks: [{ blockId: "b0", phase: "completed", invocationRef }] },
            signal: new AbortController().signal,
        })
        if (!("draftRef" in composed)) throw new Error("Expected a provider draft")
        const draft = decodeTaskPayload<ProviderDraftEnvelope>(await payloads.read(composed.draftRef))

        const manifestEntry = await journal.findByOperation(`tool.terminal_manifest:${TURN_ID}`)
        if (!manifestEntry?.payloadRef) throw new Error("Missing terminal manifest")
        const envelope = decodeTaskPayload<ToolTerminalManifestEnvelope>(await payloads.read(manifestEntry.payloadRef))
        expect(envelope.results.map(({ blockId, feedbackRef }) => ({ blockId, feedbackRef }))).toEqual([
            { blockId: "b0", feedbackRef: undefined },
        ])
        expect(envelope.supersededPayloadRefs).not.toContain(presentationRef)

        const view = new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads))
        const messages = await view.messages(draft.journalThrough)
        const toolResults = messages
            .flatMap((message) => (message.content ?? []) as readonly MaterializedContent[])
            .filter((block) => block.type === "tool_result")
        expect(toolResults.map(resultText)).toEqual(["completed:b0"])
    })

    it("lands the terminal batch before compaction reads the round and reports its unsent growth", async () => {
        const payloads = new InMemoryTaskPayloadStore()
        const journal = new InMemoryConversationJournal()
        const invocationRef = await payloads.put(encodeTaskPayload(invocation("b0")))
        await appendRawResult(journal, payloads, "b0", "x".repeat(4_000))
        const operationId = `tool.terminal_manifest:${TURN_ID}`
        const observed: { manifestLanded: boolean; pendingContextTokens: number | undefined }[] = []
        const adapter = new ProductionComposeAdapter({
            payloads,
            journal,
            readState: () => createInitialTaskState("task-1"),
            compactionBarrier: {
                settleBeforeRound: async (input) => {
                    observed.push({
                        manifestLanded: Boolean(await journal.findByOperation(operationId)),
                        pendingContextTokens: input.pendingContextTokens,
                    })
                    return { kind: "ready" }
                },
            },
        })

        await adapter.compose({
            turnId: "turn-next",
            admittedEntryIds: [],
            toolTerminals: {
                turnId: TURN_ID,
                blocks: [{ blockId: "b0", phase: "completed", invocationRef }],
            },
            signal: new AbortController().signal,
        })

        const manifestEntry = await journal.findByOperation(operationId)
        if (!manifestEntry?.payloadRef) throw new Error("Missing terminal manifest")
        const envelope = decodeTaskPayload<ToolTerminalManifestEnvelope>(await payloads.read(manifestEntry.payloadRef))
        const resultBytes = envelope.results.reduce((total, entry) => total + Buffer.byteLength(entry.content, "utf8"), 0)
        expect(resultBytes).toBeGreaterThan(4_000)
        expect(observed).toEqual([{ manifestLanded: true, pendingContextTokens: Math.ceil(resultBytes / 4) }])
    })
})
