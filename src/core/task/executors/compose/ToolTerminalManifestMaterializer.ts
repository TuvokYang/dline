import { serializeDurableToolResult, toolResultReplayOf } from "../../DurableToolResult"
import type { ToolTerminalManifest, ToolTerminalPhase } from "../../kernel"
import type { ConversationJournal, JournalEntry, TaskPayloadStore } from "../../stores"
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

function syntheticResult(block: ToolTerminalManifest["blocks"][number], invocation: ToolInvocationEnvelope): ToolResultEnvelope {
	return {
		kind: "tool_result",
		blockId: block.blockId,
		content: serializeDurableToolResult(
			{
				type: "tool_result",
				function_id: invocation.functionId,
				dline_tid: invocation.dlineTid,
				content: [{ type: "text", text: terminalText(block.phase) }],
				is_error: true,
			},
			toolResultReplayOf(invocation),
		),
		failed: true,
	}
}

const TOKEN_ESTIMATE_BYTES = 4

/** Conservative text-token estimate for the terminal content added to the next request. */
function estimateManifestTokens(manifest: ToolTerminalManifestEnvelope): number {
	const bytes = manifest.results.reduce((total, result) => total + Buffer.byteLength(result.content, "utf8"), 0)
	return bytes === 0 ? 0 : Math.ceil(bytes / TOKEN_ESTIMATE_BYTES)
}

/** Persist the kernel's ordered terminal view and report its projected request growth. */
export async function materializeToolTerminalManifest(input: {
	readonly manifest: ToolTerminalManifest
	readonly payloads: TaskPayloadStore
	readonly journal: ConversationJournal
}): Promise<number> {
	const operationId = `tool.terminal_manifest:${input.manifest.turnId}`
	const existing = await input.journal.findByOperation(operationId)
	if (existing) {
		if (existing.kind !== "message" || existing.source !== "tool" || !existing.payloadRef)
			throw new Error("InvalidToolTerminalManifestJournalEntry")
		const payload = decodeTaskPayload<ToolTerminalManifestEnvelope>(await input.payloads.read(existing.payloadRef))
		if (payload.kind !== "tool_terminal_manifest" || payload.turnId !== input.manifest.turnId)
			throw new Error("InvalidToolTerminalManifestPayload")
		return estimateManifestTokens(payload)
	}

	const rawResults = new Map<string, JournalPayloadEntry>()
	const feedback = new Map<string, string>()
	for (const entry of await input.journal.read()) {
		if (!hasPayload(entry) || entry.causation?.turnId !== input.manifest.turnId) continue
		if (entry.source === "tool") {
			const payload = decodeTaskPayload<ToolResultEnvelope>(await input.payloads.read(entry.payloadRef))
			if (payload.kind === "tool_result") rawResults.set(payload.blockId, { entry, payload })
		}
		if (entry.source === "dialog" && entry.causation?.interactionId) {
			feedback.set(entry.causation.interactionId, entry.payloadRef)
		}
	}

	const superseded = new Set<string>()
	const results: ToolTerminalManifestEnvelope["results"][number][] = []
	for (const block of input.manifest.blocks) {
		const invocation = decodeTaskPayload<ToolInvocationEnvelope>(await input.payloads.read(block.invocationRef))
		if (invocation.kind !== "tool_invocation" || invocation.dlineTid !== block.blockId)
			throw new Error(`InvalidToolTerminalInvocation:${block.blockId}`)
		const raw = rawResults.get(block.blockId)
		if (raw) superseded.add(raw.entry.payloadRef)
		const recordedFeedback = feedback.get(block.blockId)
		if (recordedFeedback) superseded.add(recordedFeedback)
		const result =
			(block.phase === "completed" || block.phase === "failed") && raw ? raw.payload : syntheticResult(block, invocation)
		const feedbackRef = block.approvalFeedbackRef ?? recordedFeedback
		results.push({
			blockId: block.blockId,
			phase: block.phase,
			content: result.content,
			...(result.failed === undefined ? {} : { failed: result.failed }),
			...(feedbackRef === undefined ? {} : { feedbackRef }),
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
	return estimateManifestTokens(envelope)
}
