import {
    OpenAiCodexProfileAuthRepository,
    type OpenAiOAuthCredentials,
    parseOpenAiOAuthCredentials,
} from "@/core/storage/secrets/OpenAiCodexProfileAuthRepository"
import { Logger } from "@/shared/services/Logger"
import {
    isOpenAiCodexCredentialExpired,
    OpenAiCodexOAuthTokenError,
    resolveOpenAiCodexAccessTokenAccountId,
    resolveOpenAiCodexStoredAccountIdentity,
} from "./strategy"

export type OpenAiCodexProfileAuthStatus =
    | "missing"
    | "malformed"
    | "legacy-shared"
    | "authenticated"
    | "refreshable-expired"
    | "reauthentication-required"

export interface OpenAiCodexCredentialContext {
    accessToken: string
    expires: number
    accountId?: string
}

export interface OpenAiCodexAccountIdentity {
    accountId?: string
    displayName?: string
    email?: string
    accountType?: string
    expiresAtMs?: number
}

export interface OpenAiCodexRefreshStrategy {
    refreshCredential(credential: OpenAiOAuthCredentials): Promise<OpenAiOAuthCredentials>
}

export type OpenAiCodexSessionErrorCode = "REFRESH_FAILED"

export class OpenAiCodexSessionError extends Error {
    constructor(
        public readonly code: OpenAiCodexSessionErrorCode,
        message: string,
    ) {
        super(message)
        this.name = "OpenAiCodexSessionError"
    }
}

export interface OpenAiCodexProfileSessionRegistryOptions {
    repository?: OpenAiCodexProfileAuthRepository
    strategy: OpenAiCodexRefreshStrategy
    now?: () => number
}

function toContext(credential: OpenAiOAuthCredentials): OpenAiCodexCredentialContext {
    const accessTokenAccount = resolveOpenAiCodexAccessTokenAccountId(credential.access_token)
    const accountId = accessTokenAccount.accountId ?? credential.accountId
    const accountIdSource = accessTokenAccount.accountId ? accessTokenAccount.source : credential.accountId ? "stored" : "missing"
    const storedAccountIdMatchesAccessToken =
        credential.accountId !== undefined && accessTokenAccount.accountId !== undefined
            ? credential.accountId === accessTokenAccount.accountId
            : undefined
    Logger.debug(
        `[OpenAiCodexSession] Account context resolved source=${accountIdSource} storedAccountIdMatchesAccessToken=${storedAccountIdMatchesAccessToken ?? "unknown"}`,
    )
    return {
        accessToken: credential.access_token,
        expires: credential.expires,
        ...(accountId !== undefined ? { accountId } : {}),
    }
}

function toIdentity(credential: OpenAiOAuthCredentials): OpenAiCodexAccountIdentity {
    return { ...resolveOpenAiCodexStoredAccountIdentity(credential), expiresAtMs: credential.expires }
}

export class OpenAiCodexProfileSessionRegistry {
    readonly repository: OpenAiCodexProfileAuthRepository
    private readonly strategy: OpenAiCodexRefreshStrategy
    private readonly now: () => number
    private readonly refreshes = new Map<string, Promise<OpenAiCodexCredentialContext | null>>()
    private readonly reauthenticationRequired = new Set<string>()

    constructor(options: OpenAiCodexProfileSessionRegistryOptions) {
        this.repository = options.repository ?? new OpenAiCodexProfileAuthRepository()
        this.strategy = options.strategy
        this.now = options.now ?? Date.now
    }

    async getAuthStatus(profileId: string): Promise<OpenAiCodexProfileAuthStatus> {
        this.requireProfileId(profileId)
        if (this.reauthenticationRequired.has(profileId)) return "reauthentication-required"
        const current = await this.repository.read(profileId)
        if (current.status !== "valid") return current.status
        if (!isOpenAiCodexCredentialExpired(current.credential, this.now())) return "authenticated"
        return current.credential.refresh_token ? "refreshable-expired" : "reauthentication-required"
    }

    async isAuthenticated(profileId: string): Promise<boolean> {
        const status = await this.getAuthStatus(profileId)
        return status === "authenticated" || status === "refreshable-expired"
    }

    async getCredentialContext(profileId: string): Promise<OpenAiCodexCredentialContext | null> {
        this.requireProfileId(profileId)
        const current = await this.repository.read(profileId)
        if (current.status !== "valid") return null
        if (isOpenAiCodexCredentialExpired(current.credential, this.now())) {
            if (!current.credential.refresh_token) {
                this.reauthenticationRequired.add(profileId)
                return null
            }
            return this.refresh(profileId, current.credential)
        }
        this.reauthenticationRequired.delete(profileId)
        return toContext(current.credential)
    }

    async getAccountIdentity(profileId: string): Promise<OpenAiCodexAccountIdentity | null> {
        this.requireProfileId(profileId)
        const current = await this.repository.read(profileId)
        return current.status === "valid" ? toIdentity(current.credential) : null
    }

    async forceRefreshCredentialContext(profileId: string): Promise<OpenAiCodexCredentialContext | null> {
        this.requireProfileId(profileId)
        const current = await this.repository.read(profileId)
        if (current.status !== "valid") return null
        if (!current.credential.refresh_token) {
            this.reauthenticationRequired.add(profileId)
            return null
        }
        this.reauthenticationRequired.delete(profileId)
        return this.refresh(profileId, current.credential)
    }

    async saveCredential(profileId: string, credential: OpenAiOAuthCredentials): Promise<void> {
        this.requireProfileId(profileId)
        await this.repository.save(profileId, parseOpenAiOAuthCredentials(credential))
        this.reauthenticationRequired.delete(profileId)
    }

    async importCredential(profileId: string, value: unknown): Promise<OpenAiOAuthCredentials> {
        this.requireProfileId(profileId)
        const credential = await this.repository.importCredential(profileId, value)
        this.reauthenticationRequired.delete(profileId)
        return credential
    }

    async clearCredential(profileId: string): Promise<void> {
        this.requireProfileId(profileId)
        await this.repository.delete(profileId)
        this.reauthenticationRequired.delete(profileId)
    }

    private refresh(profileId: string, sourceCredential: OpenAiOAuthCredentials): Promise<OpenAiCodexCredentialContext | null> {
        if (!sourceCredential.refresh_token) {
            this.reauthenticationRequired.add(profileId)
            return Promise.resolve(null)
        }
        const pending = this.refreshes.get(profileId)
        if (pending) return pending
        const refresh = this.performRefresh(profileId, sourceCredential).finally(() => {
            if (this.refreshes.get(profileId) === refresh) this.refreshes.delete(profileId)
        })
        this.refreshes.set(profileId, refresh)
        return refresh
    }

    private async performRefresh(
        profileId: string,
        sourceCredential: OpenAiOAuthCredentials,
    ): Promise<OpenAiCodexCredentialContext | null> {
        let refreshed: OpenAiOAuthCredentials
        try {
            refreshed = parseOpenAiOAuthCredentials(await this.strategy.refreshCredential(sourceCredential))
        } catch (error) {
            if (error instanceof OpenAiCodexOAuthTokenError && error.isInvalidGrant()) {
                const deleted = await this.repository.deleteIfMatches(profileId, sourceCredential)
                if (deleted === "deleted") this.reauthenticationRequired.add(profileId)
                return this.readLatestContext(profileId)
            }
            throw new OpenAiCodexSessionError("REFRESH_FAILED", "The OAuth credential could not be refreshed.")
        }

        const replaced = await this.repository.replaceIfMatches(profileId, sourceCredential, refreshed)
        if (replaced === "saved") {
            this.reauthenticationRequired.delete(profileId)
            return toContext(refreshed)
        }
        return this.readLatestContext(profileId)
    }

    private async readLatestContext(profileId: string): Promise<OpenAiCodexCredentialContext | null> {
        const latest = await this.repository.read(profileId)
        if (latest.status !== "valid") return null
        this.reauthenticationRequired.delete(profileId)
        return toContext(latest.credential)
    }

    private requireProfileId(profileId: string): void {
        if (typeof profileId !== "string" || profileId.length === 0) {
            throw new Error("OpenAI Codex OAuth requires a non-empty profile ID.")
        }
    }
}
