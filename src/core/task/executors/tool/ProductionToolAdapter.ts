import { formatResponse } from "@core/prompts/responses"
import type { ClineUserAttachedDocumentBlock } from "@shared/messages/content"
import { serializeDurableToolResult, toolResultReplayOf } from "../../DurableToolResult"
import type { PostCommitPublisher } from "../../new-task/successor-handoff"
import type { ConversationJournal, TaskPayloadStore } from "../../stores"
import { putAttachedDocuments } from "../../stores/payload/AttachedDocuments"
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
    }): Promise<{
        readonly content: string
        readonly failed?: boolean
        readonly documents?: readonly ClineUserAttachedDocumentBlock[]
        readonly postCommit?: ToolPostCommitDirective
    }>
}

export interface ProductionToolAdapterOptions {
    readonly payloads: TaskPayloadStore
    readonly journal: ConversationJournal
    readonly resources: OwnedToolResources
    readonly surface: ToolDomainSurface
    readonly service: ProductionToolExecutionService
    /** Task-scoped WS-072 scheduler shared by every turn of this task. */
    readonly scheduler: TurnToolScheduler
    /** Abort and renew handler-owned operation scopes across runtime halts. */
    readonly operationCancellation?: ToolCommandExecutorOptions["operationCancellation"]
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
    /** Carries out a directive a result commits the task to, recording the result as it does. */
    readonly publishPostCommit?: PostCommitPublisher
    readonly onReleaseError?: (error: unknown) => void
    readonly roundCheckpoint?: ToolCommandExecutorOptions["roundCheckpoint"]
}

async function persistResult(
    options: ProductionToolAdapterOptions,
    command: ToolRunCommand,
    result: Omit<ToolResultEnvelope, "kind" | "blockId" | "documentPayloadRefs"> & {
        readonly documents?: readonly ClineUserAttachedDocumentBlock[]
    },
): Promise<void> {
    const { documents, ...outcome } = result
    const documentPayloadRefs = await putAttachedDocuments(options.payloads, documents)
    const envelope: ToolResultEnvelope = {
        kind: "tool_result",
        blockId: command.dlineTid,
        ...outcome,
        ...(documentPayloadRefs ? { documentPayloadRefs } : {}),
    }
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
        // A structured note keeps its resources by reference, resolved when the result is built.
        ...(feedback.admittedParts === undefined ? {} : { admittedParts: feedback.admittedParts }),
    }
    await options.journal.append({
        operationId: `tool.approval_feedback:${command.commandId}`,
        payloadRef: await options.payloads.put(encodeTaskPayload(envelope)),
        source: "dialog",
        causation: { commandId: command.commandId, turnId: command.turnId, interactionId: command.dlineTid },
    })
}

/**
 * Record a result whose effect follows it, such as `new_task`'s handoff.
 *
 * The result is written only once the publisher accepts the directive, inside
 * its `beforeStart`, so a refused directive never leaves a result claiming the
 * effect happened; the refusal is recorded as the call's failed result instead.
 * A directive the publisher does not carry out is recorded as an ordinary result.
 */
async function settleWithPostCommit(
    options: ProductionToolAdapterOptions,
    command: ToolRunCommand,
    directive: ToolPostCommitDirective,
    settle: () => Promise<void>,
    refusedContent: () => string,
): Promise<void> {
    if (!options.publishPostCommit) return settle()
    // The publisher must not throw from `beforeStart`: the source is already
    // consumed, so the successor starts either way and the failure surfaces here.
    let settleFailure: { readonly error: unknown } | undefined
    const outcome = await options.publishPostCommit({
        command,
        directive,
        beforeStart: () =>
            settle().catch((error: unknown) => {
                settleFailure = { error }
            }),
    })
    if (settleFailure) throw settleFailure.error
    if (outcome === "handed_off") return
    if (outcome === "not_a_handoff") return settle()
    await persistResult(options, command, { content: refusedContent(), failed: true })
    await persistApprovalFeedback(options, command)
}

/** Builds the canonical tool-domain options around one host execution service. */
export function createProductionToolAdapter(options: ProductionToolAdapterOptions): ToolCommandExecutorOptions {
    return {
        surface: options.surface,
        scheduler: options.scheduler,
        operationCancellation: options.operationCancellation,
        readMistakeLimit: options.readMistakeLimit,
        roundCheckpoint: options.roundCheckpoint,
        runner: createToolDomainRunner({
            resources: options.resources,
            onReleaseError: (error) => options.onReleaseError?.(error),
            execute: async (command) => {
                const invocation = decodeTaskPayload<ToolInvocationEnvelope>(await options.payloads.read(command.invocationRef))
                if (invocation.kind !== "tool_invocation") throw new Error("InvalidToolInvocationPayload")
                // A failed block still owes the conversation a tool result. Writing the
                // raw message instead produced a journal entry the next provider request
                // could not materialize, which failed every later turn of the task.
                const errorContent = (text: string) =>
                    serializeDurableToolResult(
                        {
                            type: "tool_result",
                            function_id: invocation.functionId,
                            dline_tid: invocation.dlineTid,
                            content: [{ type: "text", text }],
                            is_error: true,
                        },
                        toolResultReplayOf(invocation),
                    )
                const failureContent = (error: unknown) => errorContent(error instanceof Error ? error.message : String(error))
                try {
                    const result = await options.service.execute({ command, invocation, surface: options.surface })
                    const settle = async () => {
                        await persistResult(options, command, {
                            content: result.content,
                            ...(result.failed === undefined ? {} : { failed: result.failed }),
                            ...(result.documents === undefined ? {} : { documents: result.documents }),
                        })
                        await persistApprovalFeedback(options, command)
                    }
                    if (!result.postCommit) await settle()
                    else
                        await settleWithPostCommit(options, command, result.postCommit, settle, () =>
                            errorContent(formatResponse.postCommitRefused()),
                        )
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
