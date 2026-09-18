import type { ToolUse } from "@core/assistant-message"
import type { ClineUserToolResultContentBlock } from "@shared/messages"
import { isTurnEndingToolName } from "../../assistant-message-order"
import { BlockPhase } from "../../BlockPhaseMachine"
import { TaskPhase } from "../../TaskPhase"
import type { ToolPreflightResult } from "./ToolPreflight"
import type { BlockLifecycleOutcome, FinalizedTurnInput, RuntimeBlockPhase, TurnDriverPorts } from "./TurnDriverPort"

/**
 * Drives one finalized assistant tool turn.
 *
 * The task remains the composition root, but the ordering, block lifecycle and
 * terminal-result rules live here. Every dependency arrives through a port, so
 * this module never imports the Task implementation it replaces.
 */
export class TurnDriver {
	constructor(private readonly ports: TurnDriverPorts) {}

	/** Whether a runtime block no longer needs execution. */
	isTerminalRuntimeBlock(phase: RuntimeBlockPhase): boolean {
		return (
			phase === BlockPhase.COMPLETED ||
			phase === BlockPhase.REJECTED ||
			phase === BlockPhase.SKIPPED ||
			phase === BlockPhase.CANCELLED
		)
	}

	/** Whether the pending next-turn content already contains one exact tool result. */
	hasPendingToolResult(dlineTid: string, functionId: string): boolean {
		return this.ports.task
			.getPendingUserMessageContent()
			.some(
				(content): content is ClineUserToolResultContentBlock =>
					content.type === "tool_result" && content.dline_tid === dlineTid && content.function_id === functionId,
			)
	}

	/** Persist the canonical fallback result for a skipped or cancelled block exactly once. */
	async ensureTerminalToolResult(block: ToolUse, phase: RuntimeBlockPhase): Promise<void> {
		const reason =
			phase === BlockPhase.SKIPPED
				? "The tool was skipped after an earlier interaction was rejected."
				: phase === BlockPhase.CANCELLED
					? "The tool was cancelled before a durable result was recorded."
					: undefined
		if (!reason) return

		const { dline_tid: dlineTid, function_id: functionId } = block
		if (!dlineTid || !functionId) {
			throw new Error(`Terminal tool block is missing canonical identity: tool=${block.name}`)
		}
		if (this.hasPendingToolResult(dlineTid, functionId)) return

		await this.ports.block.commitInterruptedResult(block, reason)
	}

	/** Execute one fully persisted assistant tool turn exactly once. */
	async execute(compactionFitInput?: FinalizedTurnInput): Promise<void> {
		const providerRequestRound = compactionFitInput?.providerRequestRound
		const toolUses = this.ports.task
			.getAssistantMessageContent()
			.filter((block): block is ToolUse => block.type === "tool_use" && !block.partial)
		if (toolUses.length === 0) {
			providerRequestRound?.completeProviderOnly()
			this.ports.task.markUserMessageContentReady()
			return
		}

		const firstDlineTid = toolUses[0]?.dline_tid
		if (!firstDlineTid || toolUses.some((block) => !block.dline_tid || !block.function_id)) {
			throw new Error("Finalized assistant turn contains a tool without canonical identity")
		}

		const admissions = new Map<string, ToolPreflightResult<void>>()
		for (const tool of toolUses) {
			const dlineTid = tool.dline_tid
			if (!dlineTid) throw new Error("Finalized assistant turn contains a tool without canonical identity")
			admissions.set(dlineTid, this.ports.block.prepareAdmission(tool))
		}
		const turnId = `turn:${firstDlineTid}`
		const turnEndInteractionIds = toolUses
			.filter((tool) => isTurnEndingToolName(tool.name))
			.flatMap((tool) => (tool.dline_tid ? [tool.dline_tid] : []))
		if (providerRequestRound) {
			this.ports.provider.registerExecution(providerRequestRound, {
				turnId,
				toolCount: toolUses.length,
				turnEndInteractionIds,
			})
		}

		let runtimeTurn = this.ports.runtime.getState().turn
		if (!runtimeTurn || runtimeTurn.turnId !== turnId) {
			const assistantApiIndex = this.ports.task.getAssistantApiIndex()
			const blocks = this.ports.task.buildTurn(assistantApiIndex, (_toolName, dlineTid) => {
				const admission = admissions.get(dlineTid)
				return (
					admission?.outcome === "admitted" &&
					(admission.decision.kind === "none" || admission.decision.kind === "automatic")
				)
			})
			const created = await this.ports.runtime.dispatch({
				type: "TURN_CREATED",
				turnId,
				assistantApiIndex,
				mode: this.ports.task.isParallelToolCallingEnabled() ? "parallel" : "serial",
				blocks: blocks.map(({ phase: _phase, ...block }) => block),
			})
			if (!created.accepted) {
				const state = this.ports.runtime.getState()
				if (this.ports.task.isAborted() || state.phase === TaskPhase.CANCELLING) return
				throw new Error(`Turn creation rejected: ${created.error?.code ?? "invalid_runtime_event"}`)
			}
			runtimeTurn = created.next.turn
		}

		if (
			!runtimeTurn ||
			toolUses.some((tool) => {
				const runtimeBlock = runtimeTurn?.blocks.find((block) => block.dlineTid === tool.dline_tid)
				return !runtimeBlock || runtimeBlock.functionId !== tool.function_id
			})
		) {
			throw new Error("Finalized assistant turn does not match the canonical runtime turn")
		}

		let manualAdmissionTail: Promise<void> = Promise.resolve()
		const withManualAdmissionSlot = <T>(work: () => Promise<T>): Promise<T> => {
			const run = manualAdmissionTail.then(work, work)
			manualAdmissionTail = run.then(
				() => undefined,
				() => undefined,
			)
			return run
		}
		const resolveBlockAdmission = async (
			tool: ToolUse,
			index: number,
			prepared: ToolPreflightResult<void>,
			session: import("./TurnDriverPort").TurnDriverSchedulingSession,
		): Promise<ToolPreflightResult<void> | undefined> => {
			const dlineTid = tool.dline_tid
			if (!dlineTid) return undefined
			let runtimeBlock = this.ports.runtime.getState().turn?.blocks.find((block) => block.dlineTid === dlineTid)
			if (!runtimeBlock) throw new Error(`Canonical runtime block is missing for tool=${tool.name}`)
			if (this.isTerminalRuntimeBlock(runtimeBlock.phase)) {
				session.markAdmissionSettled(index)
				await this.ensureTerminalToolResult(tool, runtimeBlock.phase)
				this.markFinalizedToolPresented(tool)
				return undefined
			}
			if (prepared.outcome === "rejected") {
				const rejected = await this.ports.runtime.dispatch({ type: "BLOCK_ADMISSION_REJECTED", turnId, dlineTid })
				if (!rejected.accepted)
					throw new Error(`Block admission rejection was rejected: ${rejected.error?.code ?? "invalid_runtime_event"}`)
				session.markAdmissionSettled(index)
				await this.ports.block.commitInterruptedResult(tool, prepared.rejection.message)
				this.markFinalizedToolPresented(tool)
				return undefined
			}
			let admission = prepared
			if (admission.prepareApproval) {
				const approvalPrepared = await admission.prepareApproval()
				if (approvalPrepared.outcome === "rejected") {
					const rejected = await this.ports.runtime.dispatch({ type: "BLOCK_ADMISSION_REJECTED", turnId, dlineTid })
					if (!rejected.accepted) {
						throw new Error(
							`Block admission rejection was rejected: ${rejected.error?.code ?? "invalid_runtime_event"}`,
						)
					}
					session.markAdmissionSettled(index)
					await this.ports.block.commitInterruptedResult(tool, approvalPrepared.rejection.message)
					this.markFinalizedToolPresented(tool)
					return undefined
				}
				admission = approvalPrepared
			}
			admissions.set(dlineTid, admission)
			const resolveReadyState = async (): Promise<ToolPreflightResult<void> | undefined> => {
				runtimeBlock = this.ports.runtime.getState().turn?.blocks.find((block) => block.dlineTid === dlineTid)
				if (!runtimeBlock || this.isTerminalRuntimeBlock(runtimeBlock.phase)) {
					session.markAdmissionSettled(index)
					if (runtimeBlock) await this.ensureTerminalToolResult(tool, runtimeBlock.phase)
					this.markFinalizedToolPresented(tool)
					return undefined
				}
				if (runtimeBlock.phase === BlockPhase.STREAMING) {
					const ready = await this.ports.runtime.dispatch({ type: "BLOCK_READY", turnId, dlineTid })
					if (!ready.accepted) {
						const state = this.ports.runtime.getState()
						if (this.ports.task.isAborted() || state.phase === TaskPhase.CANCELLING) return undefined
						throw new Error(`Block readiness rejected: ${ready.error?.code ?? "invalid_runtime_event"}`)
					}
				}
				return admission
			}
			const requiresManualAdmission = (candidate: Extract<ToolPreflightResult<void>, { outcome: "admitted" }>): boolean =>
				candidate.decision.kind === "manual" || candidate.decision.kind === "ai_approver"
			const confirmForScheduling = async (): Promise<boolean> => {
				if (!admission.confirm) return true
				const confirmed = await admission.confirm()
				if (confirmed.outcome === "rejected") {
					const rejected = await this.ports.runtime.dispatch({ type: "BLOCK_ADMISSION_REJECTED", turnId, dlineTid })
					if (!rejected.accepted) {
						throw new Error(
							`Block admission rejection was rejected: ${rejected.error?.code ?? "invalid_runtime_event"}`,
						)
					}
					session.markAdmissionSettled(index)
					await this.ports.block.commitInterruptedResult(tool, confirmed.rejection.message)
					this.markFinalizedToolPresented(tool)
					return false
				}
				admission = confirmed
				admissions.set(dlineTid, admission)
				return true
			}
			if (!requiresManualAdmission(admission)) {
				if (!(await confirmForScheduling())) return undefined
				if (!requiresManualAdmission(admission)) return resolveReadyState()
			}
			return withManualAdmissionSlot(async () => {
				runtimeBlock = this.ports.runtime.getState().turn?.blocks.find((block) => block.dlineTid === dlineTid)
				if (!runtimeBlock || this.isTerminalRuntimeBlock(runtimeBlock.phase)) return resolveReadyState()
				const presentation = admission.presentation
				if (!presentation) throw new Error(`Manual admission is missing approval presentation: tool=${tool.name}`)
				if (runtimeBlock.phase === BlockPhase.STREAMING) {
					const required = await this.ports.runtime.dispatch({ type: "BLOCK_APPROVAL_REQUIRED", turnId, dlineTid })
					if (!required.accepted)
						throw new Error(`Block approval request rejected: ${required.error?.code ?? "invalid_runtime_event"}`)
				}
				const approvalOutcome = await this.ports.approval.request(tool, presentation)
				if (approvalOutcome.draft) await this.ports.approval.stageFeedback(tool, approvalOutcome.draft)
				const approved = approvalOutcome.actionId === "approve" || approvalOutcome.actionId === "confirm_utility"
				runtimeBlock = this.ports.runtime.getState().turn?.blocks.find((block) => block.dlineTid === dlineTid)
				if (runtimeBlock?.phase === BlockPhase.AWAITING_APPROVAL) {
					const resolved = await this.ports.runtime.dispatch({
						type: approved ? "BLOCK_APPROVED" : "BLOCK_REJECTED",
						turnId,
						dlineTid,
					})
					if (!resolved.accepted)
						throw new Error(`Block approval resolution rejected: ${resolved.error?.code ?? "invalid_runtime_event"}`)
				}
				if (!approved) {
					session.markAdmissionSettled(index)
					await this.ports.block.commitInterruptedResult(tool, "The tool was rejected by the user.")
					this.markFinalizedToolPresented(tool)
					return undefined
				}
				if (!(await confirmForScheduling())) return undefined
				admission = { ...admission, confirm: undefined, manualApprovalSatisfied: true }
				admissions.set(dlineTid, admission)
				return admission
			})
		}

		const runBlockLifecycle = async (
			tool: ToolUse,
			admission: import("./ToolPreflight").ToolPreflightAdmission<void>,
		): Promise<BlockLifecycleOutcome> => {
			if (this.ports.task.isAborted() || !this.ports.task.isCurrentTask()) return "halt_turn"
			const dlineTid = tool.dline_tid
			if (!dlineTid) return "completed"

			let runtimeBlock = this.ports.runtime.getState().turn?.blocks.find((block) => block.dlineTid === dlineTid)
			if (!runtimeBlock) throw new Error(`Canonical runtime block is missing for tool=${tool.name}`)
			if (this.isTerminalRuntimeBlock(runtimeBlock.phase)) {
				await this.ensureTerminalToolResult(tool, runtimeBlock.phase)
				this.markFinalizedToolPresented(tool)
				return "completed"
			}

			await this.ports.block.awaitInitialCheckpoint(tool.name)
			if (this.ports.task.isAborted()) return "halt_turn"

			if (admission.decision.kind === "automatic" && admission.manualApprovalSatisfied !== true) {
				const currentAdmission = admission.refreshDecision?.() ?? admission
				admissions.set(dlineTid, currentAdmission)
				if (currentAdmission.decision.kind !== "automatic") {
					const revoked = await this.ports.runtime.dispatch({ type: "BLOCK_ADMISSION_REVOKED", turnId, dlineTid })
					if (!revoked.accepted) {
						const state = this.ports.runtime.getState()
						if (this.ports.task.isAborted() || state.phase === TaskPhase.CANCELLING) return "halt_turn"
						throw new Error(`Block admission revocation rejected: ${revoked.error?.code ?? "invalid_runtime_event"}`)
					}
					return "retry_admission"
				}
			}

			const execution = await this.ports.runtime.dispatch({ type: "BLOCK_EXECUTION_STARTED", turnId, dlineTid })
			if (!execution.accepted) {
				const state = this.ports.runtime.getState()
				const currentBlock = state.turn?.blocks.find((block) => block.dlineTid === dlineTid)
				if (
					this.ports.task.isAborted() ||
					state.phase === TaskPhase.CANCELLING ||
					(currentBlock && this.isTerminalRuntimeBlock(currentBlock.phase))
				) {
					return "halt_turn"
				}
				if (execution.effectError) {
					throw new Error(
						`Block execution effect failed (${execution.effectError.effectType}, ${execution.effectError.effectId}): ${execution.effectError.message}`,
					)
				}
				throw new Error(`Block execution rejected: ${execution.error?.code ?? "invalid_runtime_event"}`)
			}

			if (!this.ports.task.isCurrentTask()) return "halt_turn"
			runtimeBlock = this.ports.runtime.getState().turn?.blocks.find((block) => block.dlineTid === dlineTid)
			if (!runtimeBlock) {
				this.markFinalizedToolPresented(tool)
				return "completed"
			}
			if (this.isTerminalRuntimeBlock(runtimeBlock.phase)) {
				await this.ensureTerminalToolResult(tool, runtimeBlock.phase)
				this.markFinalizedToolPresented(tool)
				return "completed"
			}
			if (this.ports.runtime.getState().phase === TaskPhase.COMPLETED) {
				this.markFinalizedToolPresented(tool)
				return "completed"
			}

			const completed = await this.ports.runtime.dispatch({ type: "BLOCK_EXECUTION_COMPLETED", turnId, dlineTid })
			if (!completed.accepted) {
				const state = this.ports.runtime.getState()
				if (this.ports.task.isAborted() || state.phase === TaskPhase.CANCELLING) return "halt_turn"
				throw new Error(`Block completion rejected: ${completed.error?.code ?? "invalid_runtime_event"}`)
			}
			this.markFinalizedToolPresented(tool)
			return "completed"
		}

		const outcome = await this.ports.scheduler.runTurn(toolUses, async (session) => {
			const processBlock = async (tool: ToolUse, index: number): Promise<BlockLifecycleOutcome> => {
				let prepared = admissions.get(tool.dline_tid ?? "")
				if (!prepared) throw new Error(`Prepared admission is missing for tool=${tool.name}`)
				while (true) {
					const resolved = await resolveBlockAdmission(tool, index, prepared, session)
					if (!resolved || resolved.outcome === "rejected") return "completed"
					prepared = resolved
					const executionOutcome = await session.submit(tool, index, resolved, () => runBlockLifecycle(tool, resolved))
					if (executionOutcome !== "retry_admission") return executionOutcome
					prepared = admissions.get(tool.dline_tid ?? "") ?? resolved
				}
			}
			const firstRejectedIndex = toolUses.findIndex((tool) => admissions.get(tool.dline_tid ?? "")?.outcome === "rejected")
			if (firstRejectedIndex >= 0) {
				for (let index = 0; index <= firstRejectedIndex; index += 1) {
					const blockOutcome = await processBlock(toolUses[index], index)
					if (blockOutcome === "halt_turn") return blockOutcome
				}
				for (let index = firstRejectedIndex + 1; index < toolUses.length; index += 1) {
					session.markAdmissionSettled(index)
					const block = this.ports.runtime
						.getState()
						.turn?.blocks.find((candidate) => candidate.dlineTid === toolUses[index].dline_tid)
					if (block) await this.ensureTerminalToolResult(toolUses[index], block.phase)
					this.markFinalizedToolPresented(toolUses[index])
				}
				return "completed"
			}
			const outcomes = await Promise.all(toolUses.map((tool, index) => processBlock(tool, index)))
			return outcomes.includes("halt_turn") ? "halt_turn" : "completed"
		})
		if (outcome === "halt_turn") return

		if (compactionFitInput) this.ports.task.applyCompactionFit(compactionFitInput)

		const finalState = this.ports.runtime.getState()
		const finalTurn = finalState.turn
		if (
			finalState.phase !== TaskPhase.COMPLETED &&
			finalTurn?.turnId === turnId &&
			finalTurn.blocks.every((block) => this.isTerminalRuntimeBlock(block.phase))
		) {
			const completed = await this.ports.runtime.dispatch({ type: "TURN_COMPLETED", turnId })
			if (!completed.accepted) {
				const state = this.ports.runtime.getState()
				if (this.ports.task.isAborted() || state.phase === TaskPhase.CANCELLING) return
				throw new Error(`Turn completion rejected: ${completed.error?.code ?? "invalid_runtime_event"}`)
			}
		}

		const postCommitDirectives = toolUses.flatMap((tool) => {
			const directive = this.ports.postCommit.takeDirective(tool.dline_tid)
			return directive ? [directive] : []
		})
		if (postCommitDirectives.length > 1) {
			throw new Error("A finalized assistant turn produced multiple post-commit directives")
		}
		const postCommitDirective = postCommitDirectives[0]
		if (postCommitDirective) await this.ports.postCommit.startSuccessor(postCommitDirective)
		this.ports.task.markUserMessageContentReady()
	}

	private markFinalizedToolPresented(tool: ToolUse): void {
		if (tool.ts !== undefined) this.ports.task.markPartialToolComplete(tool.ts)
		this.ports.task.recordToolCall(tool.function_id, tool.name)
	}
}
