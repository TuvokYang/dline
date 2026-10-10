import { UIMessage } from "@core/storage/UIMessage"
import { MessageStateHandler } from "@core/task/message-state"
import type { UiMessage } from "@shared/ExtensionMessage"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { closeInstanceStoragesUnder } from "@/core/storage/instance"

/**
 * An awaiting approval is reachable only while its ask row still carries the
 * interactionId the Webview matches against. A late presentation refresh reuses
 * the same timestamp without that identity, and because the upsert replaces the
 * whole row, the anchor used to disappear and left the approval unreachable
 * while the handler kept waiting.
 */
describe("interaction anchor identity", () => {
    let dlineDocsDir: string

    beforeEach(async () => {
        dlineDocsDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-interaction-anchor-"))
        vi.stubEnv("DLINE_DOCS_DIR", dlineDocsDir)
    })

    afterEach(async () => {
        vi.unstubAllEnvs()
        await closeInstanceStoragesUnder(dlineDocsDir)
        await fs.rm(dlineDocsDir, { recursive: true, force: true })
    })

    /** Create a message state handler backed by a real per-task JSONL store. */
    async function createMessageState(taskId: string) {
        const writer = await UIMessage.open(taskId)
        const messageState = new MessageStateHandler({
            taskId,
            ulid: "test-ulid",
            updateTaskHistory: async () => [],
            uiMessage: writer,
        })
        return { writer, messageState }
    }

    const ANCHOR_TS = 100
    const INTERACTION_ID = "dline_tid_approval"

    /** Durable approval anchor written when the interaction opens. */
    function anchorRow(): UiMessage {
        return {
            ts: ANCHOR_TS,
            type: "ask",
            ask: "tool",
            text: '{"tool":"readFile","path":"outside/workspace.json"}',
            partial: false,
            interactionId: INTERACTION_ID,
        }
    }

    it("keeps the causal identity when a refresh reuses the anchor timestamp", async () => {
        const { messageState } = await createMessageState("anchor-identity-preserved")
        await messageState.addToClineMessages(anchorRow())

        // A partial refresh for the same block: same ts, no interactionId.
        await messageState.upsertClineMessageInMemory({
            ts: ANCHOR_TS,
            type: "ask",
            ask: "tool",
            text: '{"tool":"readFile","path":"outside/workspace.json"}',
            partial: true,
        })

        const anchor = messageState.clineMessages.find((message) => message.ts === ANCHOR_TS)
        expect(anchor?.interactionId).toBe(INTERACTION_ID)
    })

    it("does not let a late partial overwrite a row that already finalized", async () => {
        const { messageState } = await createMessageState("final-row-wins")
        await messageState.addToClineMessages({
            ts: ANCHOR_TS,
            type: "say",
            say: "tool",
            text: '{"tool":"actModeRespond","content":"Done"}',
            partial: false,
        })

        await messageState.upsertClineMessageInMemory({
            ts: ANCHOR_TS,
            type: "say",
            say: "tool",
            text: '{"tool":"actModeRespond","content":"Still working"}',
            partial: true,
        })

        expect(messageState.clineMessages.find((message) => message.ts === ANCHOR_TS)).toMatchObject({
            text: '{"tool":"actModeRespond","content":"Done"}',
            partial: false,
        })
    })

    it("does not overwrite an explicitly different identity", async () => {
        const { messageState } = await createMessageState("anchor-identity-explicit")
        await messageState.addToClineMessages(anchorRow())

        await messageState.upsertClineMessageInMemory({
            ts: ANCHOR_TS,
            type: "ask",
            ask: "tool",
            text: "superseding interaction",
            interactionId: "dline_tid_other",
        })

        const anchor = messageState.clineMessages.find((message) => message.ts === ANCHOR_TS)
        expect(anchor?.interactionId).toBe("dline_tid_other")
    })

    it("leaves the anchor uniquely resolvable after reopening the task", async () => {
        const taskId = "anchor-identity-reopen"
        const { messageState, writer } = await createMessageState(taskId)
        await messageState.addToClineMessages(anchorRow())
        await messageState.upsertClineMessageInMemory({
            ts: ANCHOR_TS,
            type: "ask",
            ask: "tool",
            text: '{"tool":"readFile","path":"outside/workspace.json"}',
            partial: true,
        })
        await messageState.finalizeClineMessage({
            ...anchorRow(),
            text: "finalized approval",
        })
        await messageState.flushUiMessages()
        await writer.flush()

        const reopened = await UIMessage.open(taskId)
        const matches = reopened
            .getAll()
            .filter((message) => message.ts === ANCHOR_TS && message.interactionId === INTERACTION_ID)

        // The Webview accepts an anchor only when exactly one row matches.
        expect(matches).toHaveLength(1)
        expect(matches[0]?.partial).not.toBe(true)
    })
})
