import type { ToolUse } from "@core/assistant-message"
import { STANDARD_TOOL_SPECS } from "@core/prompts/tools/tool-specs"
import { DlineDefaultTool } from "@shared/tools"
import { Logger } from "@/shared/services/Logger"
import { FocusChainPrompts } from "../focus-chain/prompts"
import { FocusChainDiagnostics, type FocusChainUpdateResult } from "../focus-chain/update-result"
import { normalizeToolExecutionResult, type ToolHandlerResult } from "./ToolExecutionResult"
import type { TaskConfig, TaskInteractionPorts } from "./types/TaskConfig"

/** The checklist owner alone validates, commits, publishes, and observes accepted updates. */
export interface ToolCallSideEffectPort {
    readonly reportProgress?: (progress: string) => Promise<FocusChainUpdateResult | undefined>
}

export function resolveToolCallSideEffects(config: TaskConfig): ToolCallSideEffectPort {
    const report = config.callbacks?.updateFCListFromToolResponse
    return report ? { reportProgress: (progress) => report(progress) } : {}
}

const progressTools = new Set(
    STANDARD_TOOL_SPECS.filter((spec) => spec.parameters?.some((parameter) => parameter.name === "task_progress")).map(
        (spec) => spec.id,
    ),
)

/** A call-local, once-only lifecycle. Feedback never replays the original progress. */
export class ToolCallProgress {
    private committed?: Promise<void>
    private diagnostic?: string

    constructor(
        private readonly config: TaskConfig,
        private readonly block: ToolUse,
        private readonly tool: DlineDefaultTool,
    ) {}

    commit = (presented = false): Promise<void> => {
        this.committed ??= this.config.commitToolProgress
            ? this.config.commitToolProgress(() => this.apply(), presented)
            : this.apply()
        return this.committed
    }

    private async apply(): Promise<void> {
        if (this.tool === DlineDefaultTool.ATTEMPT) {
            if (Object.hasOwn(this.block.params, "task_progress")) {
                this.diagnostic = FocusChainPrompts.ignoredCompletionProgress
                await this.config.callbacks.say("error", FocusChainDiagnostics.ignoredCompletionProgress)
            }
            return
        }
        if (!progressTools.has(this.tool)) return
        const progress = this.block.params.task_progress
        if (!progress?.trim()) return
        try {
            const result = await resolveToolCallSideEffects(this.config).reportProgress?.(progress)
            if (result?.kind === "failed" || result?.kind === "rejected") this.diagnostic = result.message
        } catch (error) {
            Logger.error(`Failed to apply task_progress from ${this.block.name}`, error instanceof Error ? error : undefined)
            this.diagnostic = FocusChainPrompts.persistenceFailed
            await this.config.callbacks.say("error", FocusChainDiagnostics.persistenceFailed)
        }
    }

    /** Decorate presentation, not outcomes: the hook runs before the dialog can accept feedback. */
    interactions(port: TaskInteractionPorts): TaskInteractionPorts {
        const present = port.present?.bind(port)
        return {
            open: (request) =>
                port.open({
                    ...request,
                    afterPresented: async () => {
                        await request.afterPresented?.()
                        await this.commit(true)
                    },
                }),
            complete: (request) =>
                port.complete({
                    ...request,
                    afterPresented: async () => {
                        await request.afterPresented?.()
                        await this.commit(true)
                    },
                }),
            ...(present
                ? {
                      present: (request: Parameters<NonNullable<TaskInteractionPorts["present"]>>[0]) =>
                          present({
                              ...request,
                              afterPresented: async () => {
                                  await request.afterPresented?.()
                                  await this.commit(true)
                              },
                          }),
                  }
                : {}),
            ...(port.stageCompletion ? { stageCompletion: port.stageCompletion.bind(port) } : {}),
            say: port.say.bind(port),
        }
    }

    async finish(result: ToolHandlerResult): Promise<ToolHandlerResult> {
        await this.commit()
        if (!this.diagnostic) return result
        const normalized = normalizeToolExecutionResult(result)
        const content =
            typeof normalized.response === "string" ? [{ type: "text" as const, text: normalized.response }] : normalized.response
        const response = [...content, { type: "text" as const, text: this.diagnostic }]
        return { ...normalized, response }
    }
}
