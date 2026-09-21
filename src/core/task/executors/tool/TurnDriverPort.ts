import type { AssistantMessageContent, ToolUse } from "@core/assistant-message"
import type { ClineContent } from "@shared/messages"
import type { BlockLifecycle, BlockPhase } from "../../BlockPhaseMachine"
import type { InteractionOutcome } from "../../interaction/InteractionCoordinator"
import type { InteractionDraft } from "../../interaction/InteractionResponse"
import type { ProviderRequestRoundAdmission } from "../../performance/provider-request-round-port"
import type { TaskEvent } from "../../runtime/TaskEvent"
import type { TaskDispatchResult } from "../../runtime/TaskRuntime"
import type { TaskRuntimeState } from "../../runtime/TaskRuntimeState"
import type { ToolApprovalPresentation, ToolPreflightAdmission, ToolPreflightResult } from "./ToolPreflight"

/** Outcome of one block's lifecycle. */
export type BlockLifecycleOutcome = "completed" | "halt_turn" | "retry_admission"

/**
 * Outcome of submitting one block to the pool.
 *
 * `suppressed` is distinct from `completed`: the pool retired the block without
 * running it, so it has produced no result of its own and the caller still owes
 * it a durable one.
 */
export type BlockSubmissionOutcome = BlockLifecycleOutcome | "suppressed"

/** Input retained from the provider round while its tool turn executes. */
export interface FinalizedTurnInput {
	contextTokens: number
	contextWindow: number
	providerRequestRound?: ProviderRequestRoundAdmission
}

/** Data-only directive emitted by a completed tool and consumed after the turn commits. */
export interface TurnPostCommitDirective {
	readonly type: "start_successor_task"
	readonly context: string
	readonly functionId: string
	readonly dlineTid: string
}

/** Provider execution identity retained until the tool turn or its turn-ending interaction settles. */
export interface ProviderExecutionRegistration {
	turnId: string
	toolCount: number
	turnEndInteractionIds: readonly string[]
}

/** Task state and composition operations the extracted driver consumes. */
export interface TurnDriverTaskPort {
	getTaskId(): string
	isAborted(): boolean
	isCurrentTask(): boolean
	getAssistantMessageContent(): readonly AssistantMessageContent[]
	getAssistantApiIndex(): number
	buildTurn(assistantApiIndex: number, autoApprove: (toolName: string, dlineTid: string) => boolean): BlockLifecycle[]
	isParallelToolCallingEnabled(): boolean
	getPendingUserMessageContent(): readonly ClineContent[]
	markPartialToolComplete(ts: number): void
	recordToolCall(functionId: string, toolName: string): void
	markUserMessageContentReady(): void
	applyCompactionFit(input: FinalizedTurnInput): void
}

/** Runtime dispatch and inspection. */
export interface TurnDriverRuntimePort {
	getState(): TaskRuntimeState
	dispatch(event: TaskEvent): Promise<TaskDispatchResult>
}

/** Per-block operations whose implementations belong outside the driver. */
export interface TurnDriverBlockPort {
	prepareAdmission(tool: ToolUse): ToolPreflightResult<void>
	commitInterruptedResult(tool: ToolUse, reason: string): Promise<void>
	awaitInitialCheckpoint(toolName: string): Promise<void>
	/** The denial wording for one rejected tool, including any tool-specific state note. */
	describeDenial(tool: ToolUse): Promise<string>
	/**
	 * Let one rejected tool move its own presentation row to a refused state.
	 *
	 * The driver owns the turn, not the rows a tool created, so a tool that
	 * shows live progress reports its own refusal here instead of leaving a row
	 * that still claims to be waiting to start.
	 */
	presentDenial(tool: ToolUse): Promise<void>
}

/** Manual approval presentation is injected so the driver owns sequencing, not UI details. */
export interface TurnDriverApprovalPort {
	request(tool: ToolUse, presentation: ToolApprovalPresentation): Promise<InteractionOutcome>
	stageFeedback(tool: ToolUse, draft: InteractionDraft): Promise<void>
}

/** One live scheduling session for a finalized turn. */
export interface TurnDriverSchedulingSession {
	/**
	 * Stop every later block that has not started, after one was refused.
	 *
	 * The halt is one-way and never suspends a caller: work already running
	 * finishes and reports its real result, while work still queued is retired
	 * by the pool. Blocks that never reached the pool observe it through
	 * `isHaltedBefore`.
	 */
	haltAfter(index: number): void
	/** Whether a halt raised earlier in this turn now suppresses this block. */
	isHaltedBefore(index: number): boolean
	/** Admission settled without pool execution, such as rejection or durable skip. */
	markAdmissionSettled(index: number): void
	/** A pooled block was revoked and returned to Admission before its permit is released. */
	markAdmissionUnsettled(index: number): void
	/** Submit one approved block with its final confirmed lanes. */
	submit(
		tool: ToolUse,
		index: number,
		admission: ToolPreflightAdmission<void>,
		run: (signal: AbortSignal) => Promise<BlockSubmissionOutcome>,
	): Promise<BlockSubmissionOutcome>
}

/** Scheduling is owned by the turn pool, not by the driver. */
export interface TurnDriverSchedulerPort {
	cancelActiveTurn(): void
	notifyLimitChanged(): void
	/**
	 * Retire one block that never reached the pool.
	 *
	 * Blocks the pool owns are retired by its own skip path. A block suppressed
	 * before submission has no pool entry, so it reports through the same
	 * handler to keep one durable skip outcome for the turn.
	 */
	reportSkipped(dlineTid: string): Promise<void>
	runTurn(
		toolUses: ToolUse[],
		run: (session: TurnDriverSchedulingSession) => Promise<BlockLifecycleOutcome>,
	): Promise<BlockLifecycleOutcome>
}

/** Provider accounting stays in the task, reached through one explicit adapter. */
export interface TurnDriverProviderPort {
	registerExecution(admission: ProviderRequestRoundAdmission, registration: ProviderExecutionRegistration): void
}

/** Tool directives are consumed only after their runtime blocks and turn commit. */
export interface TurnDriverPostCommitPort {
	takeDirective(dlineTid: string): TurnPostCommitDirective | undefined
	startSuccessor(directive: TurnPostCommitDirective): Promise<void>
}

/** Everything the turn driver depends on. */
export interface TurnDriverPorts {
	task: TurnDriverTaskPort
	runtime: TurnDriverRuntimePort
	block: TurnDriverBlockPort
	approval: TurnDriverApprovalPort
	scheduler: TurnDriverSchedulerPort
	provider: TurnDriverProviderPort
	postCommit: TurnDriverPostCommitPort
}

/** Narrow phase type exported for helpers that index.ts still delegates to. */
export type RuntimeBlockPhase = BlockPhase
