import { randomUUID } from "node:crypto"
import path from "node:path"
import { getDlineDataDir } from "@/core/storage/disk"
import {
    type OAuthProfileIdentity,
    OpenAiCodexProfileAuthMigration,
    type OpenAiCodexProfileAuthMigrationResult,
    OpenAiCodexProfileAuthRepository,
    type OpenAiOAuthCredentials,
    parseOpenAiOAuthCredentials,
} from "@/core/storage/secrets"
import {
    type CompleteOAuthCallbackInput,
    FileOAuthFlowLease,
    LocalOAuthFlowCoordinator,
    type OAuthAuthorizationStrategy,
    OAuthFlowError,
    type OAuthFlowLease,
    type OAuthFlowStarted,
} from "@/services/oauth"
import { openExternal } from "@/utils/env"
import { resolveOpenAiCodexRuntimeConfig } from "./runtime-config"
import {
    type OpenAiCodexAccountIdentity,
    type OpenAiCodexCredentialContext,
    type OpenAiCodexProfileAuthStatus,
    OpenAiCodexProfileSessionRegistry,
    type OpenAiCodexRefreshStrategy,
} from "./session"
import { OpenAiCodexOAuthStrategy } from "./strategy"

export * from "./session"
export * from "./strategy"

export type OpenAiCodexCredentials = OpenAiOAuthCredentials

type OpenAiCodexManagerStrategy = OAuthAuthorizationStrategy<OpenAiOAuthCredentials> & OpenAiCodexRefreshStrategy

export interface OpenAiCodexAuthorizationFlow {
    flowId: string
    profileId: string
    authorizationUrl: string
    redirectUri: string
    expiresAtMs: number
    browserOpenStatus: "opened" | "failed"
}

export type OpenAiCodexAuthorizationFlowOutcomeStatus = "completed" | "cancelled" | "timed-out" | "failed"

export interface OpenAiCodexAuthorizationFlowOutcome {
    flowId: string
    profileId: string
    status: OpenAiCodexAuthorizationFlowOutcomeStatus
    endedAtMs: number
}

export type OpenAiCodexRuntimeMutationReason = "credential-saved" | "credential-cleared" | "reauthentication-required"

export interface OpenAiCodexRuntimeMutationEvent {
    profileId: string
    reason: OpenAiCodexRuntimeMutationReason
    revision: number
}

export type OpenAiCodexRuntimeMutationListener = (event: OpenAiCodexRuntimeMutationEvent) => void | Promise<void>

export interface OpenAiCodexOAuthManagerOptions {
    repository?: OpenAiCodexProfileAuthRepository
    strategy?: OpenAiCodexManagerStrategy
    lease?: OAuthFlowLease
    openExternal?: (authorizationUrl: string) => Promise<void>
    timeoutMs?: number
    profileCatalogLoader?: () => Promise<readonly OAuthProfileIdentity[]>
}

/**
 * Profile-targeted OpenAI Codex OAuth application service.
 *
 * Credential and refresh operations are delegated to the session registry;
 * browser and manual callbacks share the provider-neutral local flow coordinator.
 */
export class OpenAiCodexOAuthManager {
    readonly sessions: OpenAiCodexProfileSessionRegistry
    private readonly coordinator: LocalOAuthFlowCoordinator<OpenAiOAuthCredentials>
    private readonly migration: OpenAiCodexProfileAuthMigration
    private readonly profileCatalogLoader: () => Promise<readonly OAuthProfileIdentity[]>
    private migrationPromise: Promise<OpenAiCodexProfileAuthMigrationResult> | undefined
    private migrationResult: OpenAiCodexProfileAuthMigrationResult | undefined
    private readonly generations = new Map<string, number>()
    private readonly mutationTails = new Map<string, Promise<void>>()
    private readonly runtimeRevisions = new Map<string, number>()
    private readonly runtimeMutationListeners = new Set<OpenAiCodexRuntimeMutationListener>()
    private readonly publishedReauthenticationRequired = new Set<string>()
    private readonly lastFlowOutcomes = new Map<string, OpenAiCodexAuthorizationFlowOutcome>()
    private activeFlow:
        | ({ flowId: string; profileId: string; generation: number } & Partial<
              Omit<OpenAiCodexAuthorizationFlow, "flowId" | "profileId">
          >)
        | undefined

    constructor(options: OpenAiCodexOAuthManagerOptions = {}) {
        const strategy = options.strategy ?? new OpenAiCodexOAuthStrategy()
        const repository = options.repository ?? new OpenAiCodexProfileAuthRepository()
        this.sessions = new OpenAiCodexProfileSessionRegistry({ repository, strategy })
        this.migration = new OpenAiCodexProfileAuthMigration({ secretsDir: repository.secretsDir, repository })
        this.profileCatalogLoader =
            options.profileCatalogLoader ??
            (async () => {
                const { readApiProfilesFresh } = await import("@/core/controller/file/getApiProfiles")
                return readApiProfilesFresh()
            })
        this.coordinator = new LocalOAuthFlowCoordinator(strategy, {
            lease: options.lease ?? new FileOAuthFlowLease(path.join(getDlineDataDir(), "oauth", "local-oauth-flow.json")),
            openExternal: options.openExternal ?? openExternal,
            onCredential: ({ flowId, profileId, credential }) => this.persistFlowCredential(flowId, profileId, credential),
            timeoutMs: options.timeoutMs,
        })
    }

    async getCredentialContext(profileId: string): Promise<OpenAiCodexCredentialContext | null> {
        await this.ensureLegacyMigration()
        if (this.isLegacyShared(profileId)) return null
        const context = await this.sessions.getCredentialContext(profileId)
        await this.publishReauthenticationRequiredIfNeeded(profileId, context)
        return context
    }

    async getAccountIdentity(profileId: string): Promise<OpenAiCodexAccountIdentity | null> {
        await this.ensureLegacyMigration()
        if (this.isLegacyShared(profileId)) return null
        return this.sessions.getAccountIdentity(profileId)
    }

    async forceRefreshCredentialContext(profileId: string): Promise<OpenAiCodexCredentialContext | null> {
        await this.ensureLegacyMigration()
        if (this.isLegacyShared(profileId)) return null
        const context = await this.sessions.forceRefreshCredentialContext(profileId)
        await this.publishReauthenticationRequiredIfNeeded(profileId, context)
        return context
    }

    async getAuthStatus(profileId: string): Promise<OpenAiCodexProfileAuthStatus> {
        const migration = await this.ensureLegacyMigration()
        const sessionStatus = await this.sessions.getAuthStatus(profileId)
        if (sessionStatus === "authenticated" || sessionStatus === "refreshable-expired") return sessionStatus
        if (sessionStatus === "malformed") return sessionStatus
        if (migration.status === "legacy-shared" && migration.profileIds.includes(profileId)) return "legacy-shared"
        if (
            migration.status === "malformed-legacy" ||
            migration.status === "malformed-marker" ||
            (migration.status === "destination-malformed" && migration.profileId === profileId)
        ) {
            return "malformed"
        }
        return sessionStatus
    }

    async isAuthenticated(profileId: string): Promise<boolean> {
        const status = await this.getAuthStatus(profileId)
        return status === "authenticated" || status === "refreshable-expired"
    }

    getActiveAuthorizationFlow(profileId: string): OpenAiCodexAuthorizationFlow | undefined {
        const flow = this.activeFlow
        if (
            flow?.profileId !== profileId ||
            !flow.authorizationUrl ||
            !flow.redirectUri ||
            flow.expiresAtMs === undefined ||
            !flow.browserOpenStatus
        ) {
            return undefined
        }
        return {
            profileId: flow.profileId,
            flowId: flow.flowId,
            authorizationUrl: flow.authorizationUrl,
            redirectUri: flow.redirectUri,
            expiresAtMs: flow.expiresAtMs,
            browserOpenStatus: flow.browserOpenStatus,
        }
    }

    getLastAuthorizationFlowOutcome(profileId: string): OpenAiCodexAuthorizationFlowOutcome | undefined {
        return this.lastFlowOutcomes.get(profileId)
    }

    subscribeToRuntimeMutations(listener: OpenAiCodexRuntimeMutationListener): () => void {
        this.runtimeMutationListeners.add(listener)
        return () => this.runtimeMutationListeners.delete(listener)
    }

    getRuntimeRevision(profileId: string): number {
        return this.runtimeRevisions.get(profileId) ?? 0
    }

    async saveCredentials(profileId: string, credentials: OpenAiCodexCredentials): Promise<void> {
        this.advanceGeneration(profileId)
        await this.withProfileMutation(profileId, async () => {
            await this.sessions.saveCredential(profileId, credentials)
        })
        this.publishedReauthenticationRequired.delete(profileId)
        await this.ensureLegacyMigration(true)
        await this.publishRuntimeMutation(profileId, "credential-saved")
    }

    async importCredentials(profileId: string, value: unknown): Promise<OpenAiCodexCredentials> {
        parseOpenAiOAuthCredentials(value)
        this.advanceGeneration(profileId)
        const activeFlow = this.activeFlow?.profileId === profileId ? this.activeFlow : undefined
        if (activeFlow) await this.cancelCoordinatorFlow(activeFlow.profileId, activeFlow.flowId)
        const credential = await this.withProfileMutation(profileId, () => this.sessions.importCredential(profileId, value))
        this.publishedReauthenticationRequired.delete(profileId)
        await this.ensureLegacyMigration(true)
        await this.publishRuntimeMutation(profileId, "credential-saved")
        return credential
    }

    async clearCredentials(profileId: string): Promise<void> {
        await this.ensureLegacyMigration()
        this.advanceGeneration(profileId)
        const activeFlow = this.activeFlow?.profileId === profileId ? this.activeFlow : undefined
        if (activeFlow) await this.cancelCoordinatorFlow(activeFlow.profileId, activeFlow.flowId)
        await this.withProfileMutation(profileId, async () => {
            await this.sessions.clearCredential(profileId)
        })
        this.publishedReauthenticationRequired.delete(profileId)
        await this.publishRuntimeMutation(profileId, "credential-cleared")
    }

    async startAuthorizationFlow(profileId: string): Promise<OAuthFlowStarted<OpenAiCodexCredentials>> {
        await this.ensureLegacyMigration()
        if (this.activeFlow) {
            throw new OAuthFlowError("FLOW_ALREADY_IN_PROGRESS", "An OAuth authorization flow is already active.")
        }
        const flowId = randomUUID()
        const generation = this.advanceGeneration(profileId)
        this.lastFlowOutcomes.delete(profileId)
        this.activeFlow = { flowId, profileId, generation }
        try {
            const started = await this.coordinator.startFlow({ profileId, flowId })
            if (this.activeFlow?.flowId === flowId) {
                this.activeFlow = {
                    flowId,
                    profileId,
                    generation,
                    authorizationUrl: started.authorizationUrl,
                    redirectUri: started.redirectUri,
                    expiresAtMs: started.expiresAtMs,
                    browserOpenStatus: started.browserOpenStatus,
                }
            }
            void started.result
                .then(
                    () => this.recordFlowOutcome(profileId, flowId, "completed"),
                    (error: unknown) =>
                        this.recordFlowOutcome(
                            profileId,
                            flowId,
                            error instanceof OAuthFlowError && error.code === "FLOW_TIMED_OUT"
                                ? "timed-out"
                                : error instanceof OAuthFlowError && error.code === "FLOW_CANCELLED"
                                  ? "cancelled"
                                  : "failed",
                        ),
                )
                .finally(() => {
                    if (this.activeFlow?.flowId === started.flowId) this.activeFlow = undefined
                })
            return started
        } catch (error) {
            if (this.activeFlow?.flowId === flowId) this.activeFlow = undefined
            throw error
        }
    }

    completeFromCallbackUri(input: CompleteOAuthCallbackInput): Promise<OpenAiCodexCredentials> {
        return this.coordinator.completeFromCallbackUri(input)
    }

    async cancelAuthorizationFlow(profileId: string, flowId?: string): Promise<void> {
        const targetFlow = flowId ? { flowId, profileId } : this.activeFlow?.profileId === profileId ? this.activeFlow : undefined
        if (!targetFlow) return
        this.advanceGeneration(profileId)
        await this.cancelCoordinatorFlow(targetFlow.profileId, targetFlow.flowId)
    }

    async migrateLegacyCredentials(profiles: readonly OAuthProfileIdentity[]): Promise<OpenAiCodexProfileAuthMigrationResult> {
        const result = await this.migration.migrate(profiles)
        this.migrationResult = result
        this.migrationPromise = Promise.resolve(result)
        return result
    }

    async dispose(): Promise<void> {
        if (this.activeFlow) this.advanceGeneration(this.activeFlow.profileId)
        this.activeFlow = undefined
        this.lastFlowOutcomes.clear()
        this.runtimeMutationListeners.clear()
        await this.coordinator.dispose()
    }

    private recordFlowOutcome(profileId: string, flowId: string, status: OpenAiCodexAuthorizationFlowOutcomeStatus): void {
        this.lastFlowOutcomes.set(profileId, { profileId, flowId, status, endedAtMs: Date.now() })
    }

    private async persistFlowCredential(flowId: string, profileId: string, credential: OpenAiCodexCredentials): Promise<void> {
        await this.withProfileMutation(profileId, async () => {
            const activeFlow = this.activeFlow
            if (
                !activeFlow ||
                activeFlow.flowId !== flowId ||
                activeFlow.profileId !== profileId ||
                this.currentGeneration(profileId) !== activeFlow.generation
            ) {
                throw new Error("The OAuth authorization flow is no longer current.")
            }
            await this.sessions.saveCredential(profileId, credential)
            this.publishedReauthenticationRequired.delete(profileId)
            await this.ensureLegacyMigration(true)
        })
        await this.publishRuntimeMutation(profileId, "credential-saved")
    }

    private async ensureLegacyMigration(force = false): Promise<OpenAiCodexProfileAuthMigrationResult> {
        if (!force && this.migrationPromise) return this.migrationPromise
        const previous = this.migrationPromise
        const operation = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(async () => {
            const result = await this.migration.migrate(await this.profileCatalogLoader())
            this.migrationResult = result
            return result
        })
        this.migrationPromise = operation
        try {
            return await operation
        } catch (error) {
            if (this.migrationPromise === operation) this.migrationPromise = undefined
            throw error
        }
    }

    private async publishReauthenticationRequiredIfNeeded(
        profileId: string,
        context: OpenAiCodexCredentialContext | null,
    ): Promise<void> {
        if (context) {
            this.publishedReauthenticationRequired.delete(profileId)
            return
        }
        if ((await this.sessions.getAuthStatus(profileId)) !== "reauthentication-required") return
        if (this.publishedReauthenticationRequired.has(profileId)) return
        this.publishedReauthenticationRequired.add(profileId)
        await this.publishRuntimeMutation(profileId, "reauthentication-required")
    }

    private async publishRuntimeMutation(profileId: string, reason: OpenAiCodexRuntimeMutationReason): Promise<void> {
        const revision = this.getRuntimeRevision(profileId) + 1
        this.runtimeRevisions.set(profileId, revision)
        await Promise.allSettled([...this.runtimeMutationListeners].map((listener) => listener({ profileId, reason, revision })))
    }

    private isLegacyShared(profileId: string): boolean {
        return this.migrationResult?.status === "legacy-shared" && this.migrationResult.profileIds.includes(profileId)
    }

    private advanceGeneration(profileId: string): number {
        const generation = this.currentGeneration(profileId) + 1
        this.generations.set(profileId, generation)
        return generation
    }

    private currentGeneration(profileId: string): number {
        return this.generations.get(profileId) ?? 0
    }

    private async withProfileMutation<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.mutationTails.get(profileId) ?? Promise.resolve()
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const tail = previous.catch(() => undefined).then(() => gate)
        this.mutationTails.set(profileId, tail)
        await previous.catch(() => undefined)
        try {
            return await operation()
        } finally {
            release()
            if (this.mutationTails.get(profileId) === tail) this.mutationTails.delete(profileId)
        }
    }

    private async cancelCoordinatorFlow(profileId: string, flowId: string): Promise<void> {
        try {
            await this.coordinator.cancelFlow({ profileId, flowId })
        } catch (error) {
            if (!(error instanceof OAuthFlowError) || (error.code !== "FLOW_NOT_FOUND" && error.code !== "FLOW_TIMED_OUT"))
                throw error
        } finally {
            if (this.activeFlow?.flowId === flowId) this.activeFlow = undefined
        }
    }
}

async function rejectUnconfiguredE2EOAuth(): Promise<void> {
    throw new OAuthFlowError("BROWSER_OPEN_FAILED", "OpenAI Codex OAuth E2E requires an explicit loopback authorization server.")
}

function createDefaultOpenAiCodexOAuthManager(): OpenAiCodexOAuthManager {
    const runtimeConfig = resolveOpenAiCodexRuntimeConfig()
    if (!runtimeConfig.e2eOAuth) {
        return new OpenAiCodexOAuthManager({
            ...(process.env.E2E_TEST === "true" ? { openExternal: rejectUnconfiguredE2EOAuth } : {}),
        })
    }

    const { authorizationEndpoint, tokenEndpoint, callbackPorts, timeoutMs } = runtimeConfig.e2eOAuth
    return new OpenAiCodexOAuthManager({
        strategy: new OpenAiCodexOAuthStrategy({
            configuration: { authorizationEndpoint, tokenEndpoint, ...(callbackPorts ? { callbackPorts } : {}) },
        }),
        openExternal,
        timeoutMs,
    })
}

export const openAiCodexOAuthManager = createDefaultOpenAiCodexOAuthManager()
