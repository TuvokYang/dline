import { serializeDurableToolResult, toolResultReplayOf } from "../../DurableToolResult"
import type { ConversationJournal, TaskPayloadStore } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { DialogDraftEnvelope, ToolInvocationEnvelope, ToolResultEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import type { ToolPostCommitDirective } from "../../tools/ToolExecutionResult"
import type { ToolApprovalFeedbackLedger } from "./ToolApprovalFeedbackLedger"
import type { ToolCommandExecutorOptions } from "./ToolCommandExecutor"
import { createToolDomainRunner, type OwnedToolResources } from "./ToolDomainResources"
import type { ToolDomainSurface } from "./ToolDomainSurface"
import type { ToolRunCommand } from "./ToolExecutionDomain"
import type { TurnToolScheduler } from "./TurnToolScheduler"

export interface ProductionToolExecutionService {
	execute(input: {
		readonly command: ToolRunCommand
		readonly invocation: ToolInvocationEnvelope
		readonly surface: ToolDomainSurface
	}): Promise<{ readonly content: string; readonly failed?: boolean; readonly postCommit?: ToolPostCommitDirective }>
}

export interface ProductionToolAdapterOptions {
	readonly payloads: TaskPayloadStore
	readonly journal: ConversationJournal
	readonly resources: OwnedToolResources
	readonly surface: ToolDomainSurface
	readonly service: ProductionToolExecutionService
	/** Task-scoped WS-072 scheduler shared by every turn of this task. */
	readonly scheduler: TurnToolScheduler
	/** Read the task's consecutive mistake count and live configured ceiling. */
	readonly readMistakeLimit?: () => { readonly count: number; readonly limit: number }
	/**
	 * Approval feedback recorded against the block being executed.
	 *
	 * An approval is planned from the turn, so anything the user typed while
	 * approving is not an intake entry and would otherwise never reach the
	 * provider. Journaling it next to the result keeps it attributed to the
	 * tool call it was written for.
	 */
	readonly approvalFeedback?: ToolApprovalFeedbackLedger
	readonly publishPostCommit?: (input: {
		readonly command: ToolRunCommand
		readonly directive: ToolPostCommitDirective
	}) => Promise<void>
	readonly onReleaseError?: (error: unknown) => void
}

async function persistResult(
	options: ProductionToolAdapterOptions,
	command: ToolRunCommand,
	result: Omit<ToolResultEnvelope, "kind" | "blockId">,
): Promise<void> {
	const envelope: ToolResultEnvelope = { kind: "tool_result", blockId: command.dlineTid, ...result }
	const payloadRef = await options.payloads.put(encodeTaskPayload(envelope))
	await options.journal.append({
		operationId: `tool.result:${command.commandId}`,
		payloadRef,
		source: "tool",
		causation: { commandId: command.commandId, turnId: command.turnId },
	})
}

/**
 * Journal the approval feedback belonging to this block, once.
 *
 * Written after the result so the provider reads the tool outcome first and the
 * user's instruction second, which is the order the conversation implies.
 */
async function persistApprovalFeedback(options: ProductionToolAdapterOptions, command: ToolRunCommand): Promise<void> {
	const feedback = options.approvalFeedback?.take(command.dlineTid)
	if (!feedback) return
	const envelope: DialogDraftEnvelope = {
		kind: "dialog_draft",
		text: feedback.text ?? "",
		images: [...(feedback.images ?? [])],
		files: [...(feedback.files ?? [])],
	}
	await options.journal.append({
		operationId: `tool.approval_feedback:${command.commandId}`,
		payloadRef: await options.payloads.put(encodeTaskPayload(envelope)),
		source: "dialog",
		causation: { commandId: command.commandId, turnId: command.turnId },
	})
}

/** Builds the canonical tool-domain options around one host execution service. */
export function createProductionToolAdapter(options: ProductionToolAdapterOptions): ToolCommandExecutorOptions {
	return {
		surface: options.surface,
		scheduler: options.scheduler,
		readMistakeLimit: options.readMistakeLimit,
		runner: createToolDomainRunner({
			resources: options.resources,
			onReleaseError: (error) => options.onReleaseError?.(error),
			execute: async (command) => {
				const invocation = decodeTaskPayload<ToolInvocationEnvelope>(await options.payloads.read(command.invocationRef))
				if (invocation.kind !== "tool_invocation") throw new Error("InvalidToolInvocationPayload")
				// A failed block still owes the conversation a tool result. Writing the
				// raw message instead produced a journal entry the next provider request
				// could not materialize, which failed every later turn of the task.
				const failureContent = (error: unknown) =>
					serializeDurableToolResult(
						{
							type: "tool_result",
							function_id: invocation.functionId,
							dline_tid: invocation.dlineTid,
							content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
							is_error: true,
						},
						toolResultReplayOf(invocation),
					)
				try {
					const result = await options.service.execute({ command, invocation, surface: options.surface })
					await persistResult(options, command, {
						content: result.content,
						...(result.failed === undefined ? {} : { failed: result.failed }),
					})
					await persistApprovalFeedback(options, command)
					if (result.postCommit) await options.publishPostCommit?.({ command, directive: result.postCommit })
				} catch (error) {
					await persistResult(options, command, { content: failureContent(error), failed: true })
					// A failed tool still consumed the approval, so the instruction the
					// user attached to it must not leak into an unrelated later block.
					await persistApprovalFeedback(options, command)
					throw error
				}
			},
		}),
	}
}
