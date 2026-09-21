import type { ConversationJournal, TaskPayloadStore } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { ToolInvocationEnvelope, ToolResultEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import type { ToolPostCommitDirective } from "../../tools/ToolExecutionResult"
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

/** Builds the canonical tool-domain options around one host execution service. */
export function createProductionToolAdapter(options: ProductionToolAdapterOptions): ToolCommandExecutorOptions {
	return {
		surface: options.surface,
		scheduler: options.scheduler,
		runner: createToolDomainRunner({
			resources: options.resources,
			onReleaseError: (error) => options.onReleaseError?.(error),
			execute: async (command) => {
				const invocation = decodeTaskPayload<ToolInvocationEnvelope>(await options.payloads.read(command.invocationRef))
				if (invocation.kind !== "tool_invocation") throw new Error("InvalidToolInvocationPayload")
				try {
					const result = await options.service.execute({ command, invocation, surface: options.surface })
					await persistResult(options, command, {
						content: result.content,
						...(result.failed === undefined ? {} : { failed: result.failed }),
					})
					if (result.postCommit) await options.publishPostCommit?.({ command, directive: result.postCommit })
				} catch (error) {
					await persistResult(options, command, {
						content: error instanceof Error ? error.message : String(error),
						failed: true,
					})
					throw error
				}
			},
		}),
	}
}
