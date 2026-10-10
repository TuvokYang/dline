import type { ApiHandler } from "@core/api"
import type { ChatContent } from "@shared/ChatContent"
import type { Mode } from "@shared/storage/types"

export type ModeCompactResult = "completed" | "cancelled" | "failed"

export interface ModeSwitchExecutionScope {
    operationId: string
    api: ApiHandler
    mode: Mode
}

interface ActiveCompaction extends ModeSwitchExecutionScope {
    complete: (result: ModeCompactResult) => void
    completion: Promise<ModeCompactResult>
    release: Promise<void>
    releaseNow: () => void
    chatContent?: ChatContent
    completionDone: boolean
    releaseDone: boolean
}

/** Coordinate one forced source-mode compaction and its commit barrier. */
export class ModeSwitchCompaction {
    private active: ActiveCompaction | undefined
    private pendingChatContent: ChatContent | undefined

    /**
     * Register one forced compaction and wake a pending conversational ask.
     *
     * @param operationId Coordinator operation identity.
     * @param api Pending target handler used by every fitting Pass.
     * @param mode Pending target mode captured with the handler.
     * @param wakeInteraction Callback that resolves a current conversational ask internally.
     * @returns Final compaction result after summary application or failure.
     */
    request(
        operationId: string,
        api: ApiHandler,
        mode: Mode,
        wakeInteraction: () => boolean | undefined | Promise<boolean | undefined>,
        chatContent?: ChatContent,
    ): Promise<ModeCompactResult> {
        if (this.active) {
            return Promise.resolve("failed")
        }
        let completeValue: ((result: ModeCompactResult) => void) | undefined
        let releaseValue: (() => void) | undefined
        const completion = new Promise<ModeCompactResult>((resolve) => {
            completeValue = resolve
        })
        const release = new Promise<void>((resolve) => {
            releaseValue = resolve
        })
        this.active = {
            operationId,
            api,
            mode,
            completion,
            complete: (result) => completeValue?.(result),
            release,
            releaseNow: () => releaseValue?.(),
            chatContent: cloneChatContent(chatContent),
            completionDone: false,
            releaseDone: false,
        }
        try {
            const wakeResult = wakeInteraction()
            void Promise.resolve(wakeResult)
                .then((accepted) => {
                    if (accepted === false) {
                        this.fail(operationId, "No compatible interaction is available for mode compaction.")
                    }
                })
                .catch(() => {
                    this.fail(operationId, "Failed to continue the active interaction for mode compaction.")
                })
        } catch {
            this.fail(operationId, "Failed to continue the active interaction for mode compaction.")
        }
        return completion
    }

    /**
     * Report whether the next task turn must compact regardless of user settings.
     *
     * @returns True while an operation awaits summary application.
     */
    shouldForce(): boolean {
        return Boolean(this.active && !this.active.completionDone)
    }

    /**
     * Complete the operation after summary state is applied, then await mode commit release.
     *
     * @returns A promise held until Coordinator commits or fails the transaction.
     */
    async markApplied(): Promise<void> {
        const active = this.active
        if (!active) {
            return
        }
        if (!active.completionDone) {
            active.completionDone = true
            active.complete("completed")
        }
        await active.release
        if (this.active === active) {
            this.pendingChatContent = cloneChatContent(active.chatContent)
            this.active = undefined
        }
    }

    /**
     * Release the task loop after target-mode commit.
     *
     * @param operationId Active Coordinator operation identity.
     */
    release(operationId: string): void {
        const active = this.match(operationId)
        if (!active || active.releaseDone) {
            return
        }
        active.releaseDone = true
        active.releaseNow()
    }

    /**
     * Fail the matching operation and release any pending task barrier.
     *
     * @param operationId Active Coordinator operation identity.
     * @param _reason Internal diagnostic reason owned by the Coordinator snapshot.
     */
    fail(operationId: string, _reason: string): void {
        const active = this.match(operationId)
        if (!active) {
            return
        }
        if (!active.completionDone) {
            active.completionDone = true
            active.complete("failed")
        }
        this.release(operationId)
        if (this.active === active) {
            this.active = undefined
        }
    }

    /** Cancel the active compaction during task abort or termination. */
    abort(): void {
        const active = this.active
        if (!active) {
            return
        }
        if (!active.completionDone) {
            active.completionDone = true
            active.complete("cancelled")
        }
        this.release(active.operationId)
        if (this.active === active) {
            this.active = undefined
        }
    }

    /** Consume user-authored draft content after the target mode has committed. */
    takeChatContent(): ChatContent | undefined {
        const content = this.pendingChatContent
        this.pendingChatContent = undefined
        return cloneChatContent(content)
    }

    /** Return the frozen target handler and mode for the next forced Pass. */
    getExecutionScope(): ModeSwitchExecutionScope | undefined {
        const active = this.active
        return active ? { operationId: active.operationId, api: active.api, mode: active.mode } : undefined
    }

    /**
     * Return the active operation identity for lifecycle integration and tests.
     *
     * @returns Current operation ID, if any.
     */
    getOperationId(): string | undefined {
        return this.active?.operationId
    }

    /** Return the active operation only when identity matches. */
    private match(operationId: string): ActiveCompaction | undefined {
        return this.active?.operationId === operationId ? this.active : undefined
    }
}

/** Detach retained draft arrays from mutable Webview request objects. */
function cloneChatContent(content?: ChatContent): ChatContent | undefined {
    if (!content) return undefined
    return {
        message: content.message,
        images: content.images ? [...content.images] : undefined,
        files: content.files ? [...content.files] : undefined,
    }
}
