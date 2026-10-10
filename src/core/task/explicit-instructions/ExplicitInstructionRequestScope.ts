import type { ClineDefaultTool } from "@shared/tools"
import type { ExplicitInstructionRegistry } from "./ExplicitInstructionRegistry"
import { getExplicitInstructionPolicy } from "./policy"
import type {
    ConsumeExplicitInstructionResult,
    ExplicitInstructionAuthorization,
    ExplicitInstructionConsumePort,
    ExplicitInstructionDeclaration,
    ExplicitInstructionRequestIdentity,
} from "./types"

/**
 * Owns all explicit instruction authority for one logical API request.
 * Provider retries advance the attempt identity without transferring old authority.
 */
export class ExplicitInstructionRequestScope {
    private identity: ExplicitInstructionRequestIdentity
    private readonly currentInstructionIds = new Set<string>()
    private providerAttemptStarted = false
    private closed = false

    constructor(
        private readonly registry: ExplicitInstructionRegistry,
        identity: ExplicitInstructionRequestIdentity,
    ) {
        this.identity = Object.freeze({ ...identity })
    }

    register(declaration: ExplicitInstructionDeclaration): ExplicitInstructionAuthorization {
        this.assertOpen()
        const authorization = this.registry.register({
            ...this.identity,
            ...declaration,
        })
        this.currentInstructionIds.add(authorization.instructionId)
        return authorization
    }

    registerInstruction(
        template: string,
        declaration: ExplicitInstructionDeclaration,
    ): { readonly text: string; readonly authorization: ExplicitInstructionAuthorization } {
        return Object.freeze({
            text: template,
            authorization: this.register(declaration),
        })
    }

    createConsumePort(): ExplicitInstructionConsumePort {
        const identity = Object.freeze({ ...this.identity })
        return Object.freeze({
            identity,
            getPendingToolAuthorization: (targetTool: ClineDefaultTool): ExplicitInstructionAuthorization | undefined =>
                this.registry.findPendingTool(identity, targetTool),
            consumeTool: (targetTool: ClineDefaultTool): ConsumeExplicitInstructionResult =>
                this.registry.consumeTool({ ...identity, targetTool }),
        })
    }

    consumeBehaviorInstructions(): readonly ExplicitInstructionAuthorization[] {
        this.assertOpen()
        return this.registry.consumeBehaviorInstructions(this.identity)
    }

    /**
     * Start one provider attempt for this logical request.
     *
     * The first attempt consumes request-bound behavior instructions. A retry must
     * supply a fresh attempt identity, expires the old attempt, and re-registers
     * only policy-approved pending tool authority.
     */
    beginProviderAttempt(attemptId?: string): void {
        this.assertOpen()
        if (!this.providerAttemptStarted) {
            if (attemptId !== undefined && attemptId !== this.identity.attemptId) {
                throw new Error("The first provider attempt must use the request scope identity.")
            }
            this.providerAttemptStarted = true
            this.consumeBehaviorInstructions()
            return
        }
        if (!attemptId) throw new Error("A provider retry must use a fresh attempt identity.")
        this.beginRetryAttempt(attemptId)
    }

    /** Advance to a fresh provider attempt and re-register only retryable pending authority. */
    beginRetryAttempt(attemptId: string): void {
        this.assertOpen()
        if (!attemptId || attemptId === this.identity.attemptId) {
            throw new Error("Explicit instruction retry attempt must use a fresh identity.")
        }

        const previousIdentity = this.identity
        const nextInstructionIds = new Set<string>()

        for (const instructionId of this.currentInstructionIds) {
            const authorization = this.registry.get(instructionId)
            if (!authorization || authorization.state !== "pending") continue
            if (!getExplicitInstructionPolicy(authorization.type).allowRetry) continue

            const retry = this.registry.registerRetry(instructionId, attemptId)
            nextInstructionIds.add(retry.instructionId)
        }

        this.registry.expireAttempt(previousIdentity)
        this.currentInstructionIds.clear()
        for (const instructionId of nextInstructionIds) this.currentInstructionIds.add(instructionId)
        this.identity = Object.freeze({ requestId: previousIdentity.requestId, attemptId })
    }

    getPendingToolAuthorization(targetTool: ClineDefaultTool): ExplicitInstructionAuthorization | undefined {
        return this.registry.findPendingTool(this.identity, targetTool)
    }

    close(): void {
        if (this.closed) return
        this.closed = true
        this.registry.closeRequest(this.identity.requestId)
    }

    cancel(): void {
        if (this.closed) return
        this.closed = true
        this.registry.cancelRequest(this.identity.requestId)
    }

    private assertOpen(): void {
        if (this.closed) throw new Error("Explicit instruction request scope is closed.")
    }
}
