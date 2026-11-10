import path from "node:path"
import { findLast } from "@shared/array"
import { InstanceDatabase, InstanceLayout, openInstanceStorage } from "@/core/storage/instance"
import { type JournalEntry, openTaskJournalStores } from "@/core/task/stores"
import { FileTaskStateVault } from "@/core/task/stores/FileTaskStateVault"
import { JournalConversationRewind } from "@/core/task/stores/JournalConversationRewind"
import { decodeTaskPayload } from "@/core/task/stores/payload/TaskPayloadCodec"
import type { RoundMaterialInputEnvelope, UserInputEnvelope } from "@/core/task/stores/payload/TaskPayloadEnvelopes"
import { readTaskConversation, rewriteTaskUiMessages, waitForTaskRelease } from "./task-instance-store"

/** Replace a closed failed request with a legacy Hosted approval without executing a tool. */
export async function seedLegacyHostedWebApproval(dlineDocsDir: string, taskId: string, taskText: string): Promise<void> {
    // A fixture written before the closed task releases its stores is overwritten by its final flush.
    await waitForTaskRelease(dlineDocsDir, taskId)
    const layout = new InstanceLayout(path.join(dlineDocsDir, "tasks", taskId))
    const conversation = await readTaskConversation(dlineDocsDir, taskId)
    const [request] = conversation
    if (
        conversation.length !== 2 ||
        request?.role !== "user" ||
        conversation.some(
            (message) =>
                !Array.isArray(message.content) ||
                message.content.some(
                    (block) => typeof block === "object" && block !== null && "type" in block && block.type === "tool_use",
                ),
        )
    ) {
        const shape = conversation.map((message) => ({ role: message.role, contentIsArray: Array.isArray(message.content) }))
        throw new Error(`Expected one failed user request and no executed tool: ${JSON.stringify(shape)}`)
    }

    const storage = openInstanceStorage(layout.root)
    try {
        const stores = await openTaskJournalStores(await storage.openDatabase(InstanceDatabase.Journal, "e2e-fixture-writer"))
        const originals: JournalEntry[] = []
        // A material input is journaled as system, but its referenced payload still
        // carries the admitted user identity. Notices/environment/prepared drafts do not.
        for (const entry of (await stores.journal.project()).visibleMessages) {
            if (!entry.payloadRef) continue
            let payload = decodeTaskPayload<UserInputEnvelope | RoundMaterialInputEnvelope>(
                await stores.payloads.read(entry.payloadRef),
            )
            if (payload.kind === "round_material_input") {
                payload = decodeTaskPayload<UserInputEnvelope>(await stores.payloads.read(payload.inputRef))
            }
            if (payload.kind === "user_input" && payload.opensTask && payload.text === taskText) originals.push(entry)
        }
        if (originals.length !== 1) throw new Error(`Expected exactly one original admitted input, found ${originals.length}`)
        await new JournalConversationRewind(stores.journal).rewindTo({
            operationId: `e2e:legacy-hosted:${taskId}`,
            target: originals[0].watermark,
        })

        const vault = new FileTaskStateVault(layout.stateFile)
        const durable = await vault.load(taskId)
        if (!durable) throw new Error("Expected current runtime state before seeding the legacy Hosted approval")
        await vault.save({
            state: {
                ...durable.state,
                flow: { phase: "paused" },
                dialog: { approvalsByBlock: {} },
                halt: { status: "idle", generation: durable.state.generation },
                journalWatermark: stores.journal.watermark(),
            },
            outbox: [],
        })
    } finally {
        await storage.close()
    }
    let failedAskTs: number | undefined
    await rewriteTaskUiMessages(dlineDocsDir, taskId, (uiMessages) => {
        const failedAsk = findLast(uiMessages, (message) => message.type === "ask" && message.ask === "api_req_failed")
        if (!failedAsk || typeof failedAsk.ts !== "number") throw new Error("Expected a persisted failed-request ask")
        failedAskTs = failedAsk.ts
        const interactionId = `hosted-web:${taskId}:0`
        failedAsk.ask = "tool"
        failedAsk.interactionId = interactionId
        failedAsk.conversationHistoryIndex = 0
        failedAsk.text = JSON.stringify({ tool: "webSearch", content: "Legacy Hosted Web approval" })
        return uiMessages
    })
    if (failedAskTs === undefined) throw new Error("Expected a hosted approval anchor timestamp")
}
