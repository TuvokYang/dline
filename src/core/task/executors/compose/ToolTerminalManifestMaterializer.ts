import { estimateContextValueBreakdown } from "@core/context/context-management/context-window-projection"
import { serializeDurableToolResult, toolResultReplayOf } from "../../DurableToolResult"
import type { ToolTerminalManifest, ToolTerminalPhase } from "../../kernel"
import type { ConversationJournal, JournalEntry, TaskPayloadStore } from "../../stores"
import { readAttachedDocuments } from "../../stores/payload/AttachedDocuments"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type {
	ToolInvocationEnvelope,
	ToolResultEnvelope,
	ToolTerminalManifestEnvelope,
} from "../../stores/payload/TaskPayloadEnvelopes"

interface JournalPayloadEntry {
	readonly entry: JournalEntry & { readonly payloadRef: string }
	readonly payload: ToolResultEnvelope
}

function hasPayload(entry: JournalEntry): entry is JournalEntry & { readonly payloadRef: string } {
	return entry.payloadRef !== undefined
}

/**
 * The answer a restored dialog recorded as its tool's result.
 *
 * It is written after the block ended, typically for a completion that
 * stopping kept open, so it is the call's result whatever the block's phase
 * and whatever the stop wrote before it, as dev replaces an interrupted
 * result with the restored feedback.
 */
const RESTORED_RESULT_OPERATION_PREFIX = "tool.restored_result:"

function terminalText(phase: ToolTerminalPhase): string {
	switch (phase) {
		case "rejected":
			return "Tool call rejected; it was not admitted or executed."
		case "skipped":
			return "Tool call skipped because an earlier call ended or rejected the turn; it was not executed."
		case "cancelled":
			return "Tool call cancelled before a canonical result was accepted. Verify observable state before retrying."
		case "failed":
			return "Tool execution failed without a durable result."
		case "completed":
			return "Tool execution completed without a durable result."
	}
}

/**
 * Words a refusal the way the refused tool reports it.
 *
 * Only the tool's handler knows what the refusal left behind, for example that
 * a file was not written, so the wording is resolved from its invocation.
 */
export interface ToolDenialPort {
	describe(invocationRef: string): Promise<string>
}

function syntheticResult(
	block: ToolTerminalManifest["blocks"][number],
	invocation: ToolInvocationEnvelope,
	text: string = terminalText(block.phase),
): ToolResultEnvelope {
	return {
		kind: "tool_result",
		blockId: block.blockId,
		content: serializeDurableToolResult(
			{
				type: "tool_result",
				function_id: invocation.functionId,
				dline_tid: invocation.dlineTid,
				content: [{ type: "text", text }],
				is_error: true,
			},
			toolResultReplayOf(invocation),
		),
		failed: true,
	}
}

/** A user's refusal reads as the tool's denial; a policy refusal keeps the generic wording. */
async function terminalResult(
	block: ToolTerminalManifest["blocks"][number],
	invocation: ToolInvocationEnvelope,
	denial: ToolDenialPort | undefined,
): Promise<ToolResultEnvelope> {
	if (block.phase === "rejected" && block.deniedByUser && denial) {
		return syntheticResult(block, invocation, await denial.describe(block.invocationRef))
	}
	return syntheticResult(block, invocation)
}

const TOKEN_ESTIMATE_BYTES = 4

/**
 * Conservative token estimate for the terminal content added to the next request.
 *
 * Attached PDFs are charged with the request estimator, which counts whichever of the
 * native document or its extracted text the endpoint may receive.
 */
async function estimateManifestTokens(
	manifest: ToolTerminalManifestEnvelope,
	payloads: Pick<TaskPayloadStore, "read">,
): Promise<number> {
	const bytes = manifest.results.reduce((total, result) => total + Buffer.byteLength(result.content, "utf8"), 0)
	const textTokens = bytes === 0 ? 0 : Math.ceil(bytes / TOKEN_ESTIMATE_BYTES)
	const documents = await readAttachedDocuments(
		payloads,
		manifest.results.flatMap((result) => result.documentPayloadRefs ?? []),
	)
	return documents.length === 0 ? textTokens : textTokens + estimateContextValueBreakdown(documents).totalTokens
}

/** Persist the kernel's ordered terminal view and report its projected request growth. */
export async function materializeToolTerminalManifest(input: {
	readonly manifest: ToolTerminalManifest
	readonly payloads: TaskPayloadStore
	readonly journal: ConversationJournal
	readonly denial?: ToolDenialPort
}): Promise<number> {
	const operationId = `tool.terminal_manifest:${input.manifest.turnId}`
	const existing = await input.journal.findByOperation(operationId)
	if (existing) {
		if (existing.kind !== "message" || existing.source !== "tool" || !existing.payloadRef)
			throw new Error("InvalidToolTerminalManifestJournalEntry")
		const payload = decodeTaskPayload<ToolTerminalManifestEnvelope>(await input.payloads.read(existing.payloadRef))
		if (payload.kind !== "tool_terminal_manifest" || payload.turnId !== input.manifest.turnId)
			throw new Error("InvalidToolTerminalManifestPayload")
		return estimateManifestTokens(payload, input.payloads)
	}

	const rawResults = new Map<string, JournalPayloadEntry>()
	const restoredResults = new Map<string, JournalPayloadEntry>()
	const rawRefs = new Map<string, string[]>()
	const feedback = new Map<string, string>()
	for (const entry of await input.journal.read()) {
		if (!hasPayload(entry) || entry.causation?.turnId !== input.manifest.turnId) continue
		if (entry.source === "tool") {
			const payload = decodeTaskPayload<ToolResultEnvelope>(await input.payloads.read(entry.payloadRef))
			if (payload.kind === "tool_result") {
				const results = entry.operationId.startsWith(RESTORED_RESULT_OPERATION_PREFIX) ? restoredResults : rawResults
				results.set(payload.blockId, { entry, payload })
				rawRefs.set(payload.blockId, [...(rawRefs.get(payload.blockId) ?? []), entry.payloadRef])
			}
		}
		if (entry.source === "dialog" && entry.causation?.interactionId) {
			// A completion's dialog is keyed by its block, so the dialog's own
			// presentation shares the call's turn and interaction. Only a draft the
			// user wrote is that call's approval feedback.
			const payload = decodeTaskPayload<{ readonly kind: string }>(await input.payloads.read(entry.payloadRef))
			if (payload.kind === "dialog_draft") feedback.set(entry.causation.interactionId, entry.payloadRef)
		}
	}

	const superseded = new Set<string>()
	const results: ToolTerminalManifestEnvelope["results"][number][] = []
	for (const block of input.manifest.blocks) {
		const invocation = decodeTaskPayload<ToolInvocationEnvelope>(await input.payloads.read(block.invocationRef))
		if (invocation.kind !== "tool_invocation" || invocation.dlineTid !== block.blockId)
			throw new Error(`InvalidToolTerminalInvocation:${block.blockId}`)
		const raw = rawResults.get(block.blockId)
		const restored = restoredResults.get(block.blockId)
		for (const ref of rawRefs.get(block.blockId) ?? []) superseded.add(ref)
		const recordedFeedback = feedback.get(block.blockId)
		if (recordedFeedback) superseded.add(recordedFeedback)
		const result = restored
			? restored.payload
			: (block.phase === "completed" || block.phase === "failed") && raw
				? raw.payload
				: await terminalResult(block, invocation, input.denial)
		const feedbackRef = block.approvalFeedbackRef ?? recordedFeedback
		results.push({
			blockId: block.blockId,
			phase: block.phase,
			content: result.content,
			...(result.failed === undefined ? {} : { failed: result.failed }),
			...(feedbackRef === undefined ? {} : { feedbackRef }),
			...(result.documentPayloadRefs?.length ? { documentPayloadRefs: result.documentPayloadRefs } : {}),
		})
	}

	const envelope: ToolTerminalManifestEnvelope = {
		kind: "tool_terminal_manifest",
		turnId: input.manifest.turnId,
		results,
		supersededPayloadRefs: [...superseded],
	}
	await input.journal.append({
		operationId,
		payloadRef: await input.payloads.put(encodeTaskPayload(envelope)),
		source: "tool",
		causation: { turnId: input.manifest.turnId },
	})
	return estimateManifestTokens(envelope, input.payloads)
}
