import { access, readFile } from "node:fs/promises"
import * as path from "node:path"
import type { UiMessage } from "@shared/ExtensionMessage"
import type { TaskActivityRecord } from "@shared/task-activity"
import { TaskActivityRow } from "@/core/storage/activities/TaskActivityRow"
import { LEGACY_ACTIVITY_FILE } from "@/core/storage/activities/TaskActivityRowStore"
import { asc } from "@/core/storage/backend/api/UnifyStoreQuery"
import { InstanceDatabase, InstanceLayout, instanceDatabaseExists, openInstanceStorage } from "@/core/storage/instance"
import { openUiMessageRows } from "@/core/storage/messages/openUiMessageRows"
import { readUiMessages } from "@/core/storage/messages/readUiMessages"
import { readJournalConversation } from "@/core/task/conversation/JournalConversationReader"
import {
	type MaterializedPayload,
	ProviderJournalMessageMaterializer,
} from "@/core/task/executors/provider/service/ProviderJournalMessageMaterializer"
import type { KernelBlock } from "@/core/task/kernel"
import {
	type JournalEntry,
	type JournalSource,
	openTaskJournalStores,
	rebuildJournalProjection,
	type TaskJournalStores,
} from "@/core/task/stores"
import { FileTaskStateVault } from "@/core/task/stores/FileTaskStateVault"
import { decodeTaskPayload, encodeTaskPayload } from "@/core/task/stores/payload/TaskPayloadCodec"
import type {
	ProviderFinalEnvelope,
	ToolInvocationEnvelope,
	ToolResultEnvelope,
} from "@/core/task/stores/payload/TaskPayloadEnvelopes"
import { historyDisplayAnchorRow, projectHistoryDisplayState } from "@/core/task/view/canonical/projectHistoryDisplayState"
import type { ClineStorageMessage } from "@/shared/messages/content"

/**
 * Test access to the per-task databases the extension persists.
 *
 * Chat history lives in `messages.db` and activities in `activities.db`. A task
 * seeded with legacy `ui_messages.jsonl` / `activities.json` files is imported the
 * first time the extension opens it, so until then the readers fall back to the
 * legacy file.
 *
 * The rewrite helpers stage edited history for a task the extension has closed.
 * While a task is open the extension is the only writer of its databases, so a
 * test must close the task before rewriting it and reopen it afterwards.
 */

const E2E_READER = "e2e-reader"
const E2E_FIXTURE_WRITER = "e2e-fixture-writer"

function taskRoot(dlineDocsDir: string, taskId: string): string {
	return path.join(dlineDocsDir, "tasks", taskId)
}

/** The stored chat history of a task, in display order. */
export async function readTaskUiMessages(dlineDocsDir: string, taskId: string): Promise<UiMessage[]> {
	try {
		return await readUiMessages(taskRoot(dlineDocsDir, taskId))
	} catch {
		return []
	}
}

/**
 * The chat history as one JSON line per message.
 *
 * Tests that look for markers in the persisted history keep working on the same
 * text shape the legacy JSONL file had.
 */
export async function readTaskUiMessagesText(dlineDocsDir: string, taskId: string): Promise<string> {
	const messages = await readTaskUiMessages(dlineDocsDir, taskId)
	return messages.length === 0 ? "" : `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`
}

const LEGACY_CONVERSATION_FILE = "api_conversation_history.jsonl"

async function readLegacyConversation(root: string): Promise<ClineStorageMessage[]> {
	try {
		const text = await readFile(path.join(root, LEGACY_CONVERSATION_FILE), "utf8")
		return text
			.split(/\r?\n/)
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as ClineStorageMessage)
	} catch {
		return []
	}
}

/**
 * The provider conversation of a task, as the model sees it.
 *
 * The conversation lives in `journal.db` and is rebuilt from its entries and
 * payloads. A seeded task the extension has not run yet has only its legacy
 * `api_conversation_history.jsonl`, which is read instead. Reading never claims
 * the journal, so it works while the task is open in the extension.
 */
export async function readTaskConversation(dlineDocsDir: string, taskId: string): Promise<ClineStorageMessage[]> {
	const root = taskRoot(dlineDocsDir, taskId)
	try {
		const journal = await readJournalConversation(new InstanceLayout(root))
		if (journal) return journal
	} catch {
		// A journal the extension is still creating reads as absent until its first commit.
	}
	return await readLegacyConversation(root)
}

/**
 * A journal entry as the history file saw it.
 *
 * Compaction and context-window truncation never removed messages from
 * `api_conversation_history.jsonl`; they only changed what later requests
 * carried. In the journal both are a `supersede_range` overlay. Kept as a
 * checkpoint marker the overlay still holds its position, so a later rewind or
 * boundary that names it resolves, but it hides nothing and shows no summary.
 */
function asHistoryEntry(entry: JournalEntry): JournalEntry {
	return entry.kind === "supersede_range" ? { ...entry, kind: "checkpoint_marker" } : entry
}

/**
 * The provider history of a task, the way the legacy history file held it.
 *
 * Rewinds, tombstones and truncation boundaries still apply, as a checkpoint
 * restore rewrote the file; summaries and truncation notices do not, so the
 * spans they replaced for the model stay in the history.
 */
async function readJournalHistory(root: string): Promise<ClineStorageMessage[] | undefined> {
	const layout = new InstanceLayout(root)
	if (!(await instanceDatabaseExists(layout, InstanceDatabase.Journal))) return undefined
	const storage = openInstanceStorage(root)
	try {
		const { journal, payloads } = await openTaskJournalStores(
			await storage.openDatabase(InstanceDatabase.Journal, E2E_READER),
		)
		const entries = (await journal.read()).map(asHistoryEntry)
		if (entries.length === 0) return undefined
		const materializer = new ProviderJournalMessageMaterializer(payloads)
		const rendered: Array<MaterializedPayload & { readonly payloadRef: string }> = []
		for (const entry of rebuildJournalProjection(entries).visibleMessages) {
			if (entry.payloadRef)
				rendered.push({ payloadRef: entry.payloadRef, ...(await materializer.materializeEntry(entry.payloadRef)) })
		}
		const replaced = new Set(rendered.flatMap((item) => [...(item.supersededPayloadRefs ?? [])]))
		return rendered.filter((item) => !replaced.has(item.payloadRef)).flatMap((item) => [...item.messages])
	} finally {
		await storage.close()
	}
}

/**
 * The provider history as one JSON line per message, the shape the legacy history file had.
 *
 * Unlike {@link readTaskConversation}, this is the history rather than the
 * model's current view: a span a summary replaced stays, and the summary does
 * not appear. `ts` is left out: the journal stamps each message when it renders
 * it, so two reads of an unchanged history differ only there. Without it, equal
 * text means the task holds the same history.
 */
export async function readTaskConversationText(dlineDocsDir: string, taskId: string): Promise<string> {
	const root = taskRoot(dlineDocsDir, taskId)
	let history: ClineStorageMessage[] | undefined
	try {
		history = await readJournalHistory(root)
	} catch {
		// A journal the extension is still creating reads as absent until its first commit.
	}
	const messages = history ?? (await readLegacyConversation(root))
	const lines = messages.map(({ ts: _renderedAt, ...message }) => JSON.stringify(message))
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}

async function withFixtureJournal<T>(root: string, work: (stores: TaskJournalStores) => Promise<T>): Promise<T> {
	const storage = openInstanceStorage(root)
	try {
		return await work(await openTaskJournalStores(await storage.openDatabase(InstanceDatabase.Journal, E2E_FIXTURE_WRITER)))
	} finally {
		await storage.close()
	}
}

/** The journal source the runtime's legacy import assigns to a message. */
function journalSourceOf(message: ClineStorageMessage): JournalSource {
	if (message.role === "assistant") return "provider"
	return Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result") ? "tool" : "intake"
}

/**
 * Replaces the provider conversation of a closed task with `transform(current)`.
 *
 * The journal stays append-only: the earlier entries are rewound and the new
 * conversation is appended as messages, the way the runtime imports a
 * pre-journal history. Operation ids never use the `legacy:` prefix, so a
 * leftover `api_conversation_history.jsonl` is not imported on top.
 */
export async function rewriteTaskConversation(
	dlineDocsDir: string,
	taskId: string,
	transform: (messages: ClineStorageMessage[]) => ClineStorageMessage[] | Promise<ClineStorageMessage[]>,
): Promise<void> {
	const next = await transform(await readTaskConversation(dlineDocsDir, taskId))
	await withFixtureJournal(taskRoot(dlineDocsDir, taskId), async ({ journal, payloads }) => {
		const operation = `e2e-seed:${Date.now()}:${journal.watermark().seq}`
		if (journal.watermark().seq > 0) await journal.rewind({ operationId: `${operation}:rewind`, target: { seq: 0 } })
		for (const [index, message] of next.entries()) {
			await journal.append({
				operationId: `${operation}:${index}`,
				payloadRef: await payloads.put(encodeTaskPayload({ kind: "legacy_message", message })),
				source: journalSourceOf(message),
				watermark: journal.watermark(),
			})
		}
	})
}

/** Replaces the provider conversation of a closed task with `messages`. */
export async function seedTaskConversation(
	dlineDocsDir: string,
	taskId: string,
	messages: readonly ClineStorageMessage[],
): Promise<void> {
	await rewriteTaskConversation(dlineDocsDir, taskId, () => [...messages])
}

type TaskRuntimeState = NonNullable<Awaited<ReturnType<FileTaskStateVault["load"]>>>["state"]

/** The runtime state the task last committed, from `state.json`; safe to read while the task is open. */
export async function readTaskRuntimeState(dlineDocsDir: string, taskId: string): Promise<TaskRuntimeState | undefined> {
	return (await new FileTaskStateVault(new InstanceLayout(taskRoot(dlineDocsDir, taskId)).stateFile).load(taskId))?.state
}

/**
 * The task's turn-ending interaction as the E2E assertions describe it.
 *
 * `phase` and `blockPhase` keep the task-level vocabulary the assertions use
 * (`executing`, `auto_executing`, `streaming`, `completed`); everything is
 * derived from `state.json` plus the anchored chat rows.
 */
export interface TaskInteractionView {
	phase?: string
	completionId?: string
	interactionId?: string
	interactionKind?: string
	interactionStatus?: string
	/** The current turn when it owns the interaction's block. */
	interactionTurnId?: string
	anchorInteractionId?: string
	/** The current turn when it owns the anchored interaction's block. */
	anchorTurnId?: string
	turnId?: string
	/** The current turn's turn-ending block. */
	blockId?: string
	blockPhase?: string
}

const COMPLETION_DIALOG_KIND = "completion"
const COMPLETION_ROW_ASK = "completion_result"

/** Reads the task's turn-ending interaction from durable storage; safe while the task is open. */
export async function readTaskInteractionView(dlineDocsDir: string, taskId: string): Promise<TaskInteractionView> {
	const [state, messages] = await Promise.all([
		readTaskRuntimeState(dlineDocsDir, taskId),
		readTaskUiMessages(dlineDocsDir, taskId),
	])
	return state ? interactionViewOf(state, messages) : {}
}

/** What a task reopened from History shows before the user answers it. */
export interface HistoryDisplayView {
	readonly view: TaskInteractionView
	/** The stored chat history, followed by the anchor row of an interaction the display synthesized. */
	readonly messages: UiMessage[]
}

/**
 * Reads a closed task the way the History display renders it.
 *
 * The display writes nothing: a task that stopped without reaching an
 * interaction is offered Resume through a dialog and anchor row that exist only
 * in memory until the user answers. The production projection is applied here
 * so assertions see that dialog instead of the bare stored state.
 */
export async function readHistoryDisplay(dlineDocsDir: string, taskId: string): Promise<HistoryDisplayView> {
	const [state, stored] = await Promise.all([
		readTaskRuntimeState(dlineDocsDir, taskId),
		readTaskUiMessages(dlineDocsDir, taskId),
	])
	if (!state) return { view: {}, messages: stored }
	const display = projectHistoryDisplayState(taskId, state)
	const messages = display.synthetic ? [...stored, historyDisplayAnchorRow(display.synthetic, stored)] : stored
	return { view: interactionViewOf(display.state, messages), messages }
}

function interactionViewOf(state: TaskRuntimeState, messages: readonly UiMessage[]): TaskInteractionView {
	const interaction = state.dialog.primary
	const block = state.turn.blocks.find((candidate) => candidate.turnEnding)
	const anchorInteractionId = anchoredInteractionId(state, messages)
	const owningTurn = (id: string | undefined) =>
		id && state.turn.blocks.some((candidate) => candidate.blockId === id) ? state.turn.turnId : undefined
	return {
		phase: interactionPhase(state),
		completionId: state.flow.completionId ?? (awaitsCompletion(state) ? interaction?.interactionId : undefined),
		interactionId: interaction?.interactionId,
		interactionKind: interaction?.kind,
		interactionStatus: interaction?.status,
		interactionTurnId: owningTurn(interaction?.interactionId),
		anchorInteractionId,
		anchorTurnId: owningTurn(anchorInteractionId),
		turnId: state.turn.turnId,
		blockId: block?.blockId,
		blockPhase:
			block && block.phase === "executing" && !isManuallyApproved(state, block.blockId) ? "auto_executing" : block?.phase,
	}
}

/** An awaiting completion dialog is the task's finished state: the result is out and only the user's reply remains. */
function awaitsCompletion(state: TaskRuntimeState): boolean {
	return state.dialog.primary?.kind === COMPLETION_DIALOG_KIND && state.dialog.primary.status === "awaiting"
}

function interactionPhase(state: TaskRuntimeState): string {
	if (state.flow.phase === "completed" || awaitsCompletion(state)) return "completed"
	if (state.flow.provider?.status === "running") return "streaming"
	if (state.turn.executingBlockIds.length > 0) return "executing"
	return state.flow.phase
}

function isManuallyApproved(state: TaskRuntimeState, blockId: string): boolean {
	return state.turn.manualApprovalBlockIds.includes(blockId)
}

/**
 * The interaction the chat is anchored to.
 *
 * A dialog only reaches `awaiting` after its reveal wrote the row it anchors
 * to, so an awaiting dialog is the anchor even before that row is flushed.
 * Once answered, the latest anchored row stays the anchor, except that
 * answering a completion reopens the task and releases it.
 */
function anchoredInteractionId(state: TaskRuntimeState, messages: readonly UiMessage[]): string | undefined {
	const primary = state.dialog.primary
	if (primary?.status === "awaiting") return primary.interactionId
	const latest = messages.findLast((message) => message.type === "ask" && message.interactionId)
	if (latest?.ask === COMPLETION_ROW_ASK && state.flow.phase !== "completed") return undefined
	return latest?.interactionId
}

/**
 * Leaves a closed task waiting for the user between turns, its watermark at the journal tail.
 *
 * The runtime has no idle phase for a task that stopped mid-run: it reopens
 * any such task paused, offering Resume, and a new message the user sends is
 * the next turn.
 */
export async function pauseTaskBetweenTurns(dlineDocsDir: string, taskId: string): Promise<void> {
	const root = taskRoot(dlineDocsDir, taskId)
	const vault = new FileTaskStateVault(new InstanceLayout(root).stateFile)
	const durable = await vault.load(taskId)
	if (!durable) throw new Error(`Expected runtime state for task ${taskId}`)
	const tail = await withFixtureJournal(root, async ({ journal }) => journal.watermark())
	const state = durable.state
	await vault.save({
		state: {
			...state,
			flow: { phase: "paused" },
			dialog: { approvalsByBlock: {} },
			turn: { ...state.turn, blocks: [], manualApprovalBlockIds: [], automaticApprovalBlockIds: [], executingBlockIds: [] },
			halt: { status: "idle", generation: state.generation },
			journalWatermark: tail,
		},
		outbox: [],
	})
}

/**
 * Leaves a closed task paused after `toolName`'s result was journaled but
 * before compose canonicalized that turn, as a crash in between would.
 *
 * The runtime journals a tool result before it completes the block, and
 * compose then writes the turn's terminal manifest. Rewinding to just before
 * the manifest keeps the raw result visible and the turn's blocks completed,
 * so reopening the task resumes into a compose that must pair them again.
 */
export async function pauseTaskAfterToolResult(dlineDocsDir: string, taskId: string, toolName: string): Promise<void> {
	const root = taskRoot(dlineDocsDir, taskId)
	const vault = new FileTaskStateVault(new InstanceLayout(root).stateFile)
	const durable = await vault.load(taskId)
	if (!durable) throw new Error(`Expected runtime state for task ${taskId}`)
	const { turn, tail } = await withFixtureJournal(root, async ({ journal, payloads }) => {
		const entries = await journal.read()
		const decode = async <T>(payloadRef: string) => decodeTaskPayload<T>(await payloads.read(payloadRef))
		for (const entry of entries) {
			if (entry.kind !== "message" || entry.source !== "provider" || !entry.payloadRef) continue
			const final = await decode<ProviderFinalEnvelope>(entry.payloadRef)
			if (final.kind !== "provider_final") continue
			let dlineTid: string | undefined
			for (const plan of final.turnPlan.blocks) {
				const invocation = await decode<ToolInvocationEnvelope>(plan.invocationRef)
				if (invocation.toolName === toolName) dlineTid = invocation.dlineTid
			}
			if (!dlineTid) continue
			let turnId: string | undefined
			for (const candidate of entries) {
				if (candidate.source !== "tool" || !candidate.payloadRef || !candidate.causation?.turnId) continue
				const result = await decode<ToolResultEnvelope>(candidate.payloadRef)
				if (result.kind === "tool_result" && result.blockId === dlineTid) turnId = candidate.causation.turnId
			}
			if (!turnId) throw new Error(`Expected a journaled ${toolName} result`)
			const manifest = await journal.findByOperation(`tool.terminal_manifest:${turnId}`)
			if (!manifest) throw new Error(`Expected compose to have canonicalized the ${toolName} turn`)
			await journal.rewind({
				operationId: `e2e-seed:${Date.now()}:rewind`,
				target: { seq: manifest.watermark.seq - 1 },
			})
			const blocks: KernelBlock[] = final.turnPlan.blocks.map((plan) => ({
				blockId: plan.blockId,
				index: plan.index,
				phase: "completed",
				attempt: plan.attempt,
				lanes: plan.lanes,
				turnEnding: plan.turnEnding,
				invocationRef: plan.invocationRef,
			}))
			return { turn: { turnId, mode: final.turnPlan.mode, blocks }, tail: journal.watermark() }
		}
		throw new Error(`Expected a provider turn that called ${toolName}`)
	})
	const state = durable.state
	await vault.save({
		state: {
			...state,
			flow: { phase: "paused" },
			turn: {
				...state.turn,
				...turn,
				manualApprovalBlockIds: [],
				automaticApprovalBlockIds: [],
				executingBlockIds: [],
			},
			dialog: { approvalsByBlock: {} },
			halt: { status: "idle", generation: state.generation },
			journalWatermark: tail,
		},
		outbox: [],
	})
}

async function readLegacyActivities(root: string): Promise<TaskActivityRecord[]> {
	try {
		const parsed = JSON.parse(await readFile(path.join(root, LEGACY_ACTIVITY_FILE), "utf8")) as {
			activities?: TaskActivityRecord[]
		}
		return Array.isArray(parsed.activities) ? parsed.activities : []
	} catch {
		return []
	}
}

/**
 * Replaces the stored chat history of a closed task with `transform(current)`.
 *
 * `transform` may edit the messages in place and return the same array.
 */
export async function rewriteTaskUiMessages(
	dlineDocsDir: string,
	taskId: string,
	transform: (messages: UiMessage[]) => UiMessage[] | Promise<UiMessage[]>,
): Promise<void> {
	const root = taskRoot(dlineDocsDir, taskId)
	const next = await transform(await readUiMessages(root))
	const rows = await openUiMessageRows(root, E2E_FIXTURE_WRITER)
	try {
		await rows.replaceAll(next.map((message, ordinal) => ({ ordinal, ts: message.ts, message })))
	} finally {
		await rows.close()
	}
}

/** Replaces the stored activities of a closed task with `transform(current)`. */
export async function rewriteTaskActivities(
	dlineDocsDir: string,
	taskId: string,
	transform: (activities: TaskActivityRecord[]) => TaskActivityRecord[] | Promise<TaskActivityRecord[]>,
): Promise<void> {
	const root = taskRoot(dlineDocsDir, taskId)
	const next = await transform(await readTaskActivities(dlineDocsDir, taskId))
	const storage = openInstanceStorage(root)
	try {
		const database = await storage.openDatabase(InstanceDatabase.Activities, E2E_FIXTURE_WRITER)
		const rows = await database.openStore(TaskActivityRow)
		await rows.replaceAll(next.map((record, position) => new TaskActivityRow(position, record)))
	} finally {
		await storage.close()
	}
}

/** The stored activities of a task, in list order. */
export async function readTaskActivities(dlineDocsDir: string, taskId: string): Promise<TaskActivityRecord[]> {
	const root = taskRoot(dlineDocsDir, taskId)
	try {
		await access(new InstanceLayout(root).database(InstanceDatabase.Activities))
	} catch {
		return await readLegacyActivities(root)
	}
	const storage = openInstanceStorage(root)
	try {
		const database = await storage.openDatabase(InstanceDatabase.Activities, E2E_READER)
		const rows = await database.openStore(TaskActivityRow)
		const { records } = await rows.query({ orderBy: [asc(TaskActivityRow.storage.fields.position)] })
		return records.length > 0 ? records.map((row) => row.record) : await readLegacyActivities(root)
	} catch {
		return await readLegacyActivities(root)
	} finally {
		await storage.close().catch(() => undefined)
	}
}
