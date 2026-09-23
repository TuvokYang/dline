import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { FileLock } from "../backend/jsonl/FileLock"
import { getDlineDataDir } from "../disk"
import { getClaudeCodeProfileAuthPath } from "./ClaudeCodeProfileAuthPath"

const MINIMUM_VALID_EXPIRY_MS = 1_000_000_000_000
const RENAME_RETRY_DELAYS_MS = [10, 25, 50] as const
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"])
const KNOWN_CREDENTIAL_KEYS = new Set([
	"type",
	"access_token",
	"refresh_token",
	"expires",
	"scopes",
	"displayName",
	"email",
	"accountId",
	"organizationName",
])

export interface ClaudeCodeOAuthCredentials {
	type?: string
	access_token: string
	refresh_token?: string
	expires: number
	scopes?: string
	displayName?: string
	email?: string
	accountId?: string
	organizationName?: string
}

export type ClaudeCodeProfileAuthReadResult =
	| { status: "missing" }
	| { status: "malformed" }
	| { status: "valid"; credential: ClaudeCodeOAuthCredentials }

export type ClaudeCodeProfileAuthReplaceResult = "saved" | "changed" | "missing" | "malformed"
export type ClaudeCodeProfileAuthDeleteIfMatchesResult = "deleted" | "changed" | "missing" | "malformed"

export interface ClaudeCodeProfileAuthRepositoryOptions {
	secretsDir?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseClaudeCodeOAuthCredentials(value: unknown): ClaudeCodeOAuthCredentials {
	if (!isRecord(value)) throw new Error("Claude Code OAuth credential must be a JSON object.")
	const accessToken = value.access_token
	if (typeof accessToken !== "string" || accessToken.length === 0) {
		throw new Error("Claude Code OAuth credential access_token must be a non-empty string.")
	}
	const expires = value.expires
	if (!Number.isSafeInteger(expires) || (expires as number) < MINIMUM_VALID_EXPIRY_MS) {
		throw new Error("Claude Code OAuth credential expires must be a valid millisecond timestamp.")
	}
	const refreshToken = value.refresh_token
	if (refreshToken !== undefined && (typeof refreshToken !== "string" || refreshToken.length === 0)) {
		throw new Error("Claude Code OAuth credential refresh_token must be a non-empty string when provided.")
	}

	return {
		access_token: accessToken,
		...(refreshToken !== undefined ? { refresh_token: refreshToken } : {}),
		expires: expires as number,
		...(typeof value.type === "string" ? { type: value.type } : {}),
		...(typeof value.scopes === "string" ? { scopes: value.scopes } : {}),
		...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
		...(typeof value.email === "string" ? { email: value.email } : {}),
		...(typeof value.accountId === "string" ? { accountId: value.accountId } : {}),
		...(typeof value.organizationName === "string" ? { organizationName: value.organizationName } : {}),
	}
}

function credentialsEqual(left: ClaudeCodeOAuthCredentials, right: ClaudeCodeOAuthCredentials): boolean {
	return (
		left.type === right.type &&
		left.access_token === right.access_token &&
		left.refresh_token === right.refresh_token &&
		left.expires === right.expires &&
		left.scopes === right.scopes &&
		left.displayName === right.displayName &&
		left.email === right.email &&
		left.accountId === right.accountId &&
		left.organizationName === right.organizationName
	)
}

function serializeCredential(credential: ClaudeCodeOAuthCredentials): Record<string, unknown> {
	return {
		...(credential.type !== undefined ? { type: credential.type } : {}),
		access_token: credential.access_token,
		...(credential.refresh_token !== undefined ? { refresh_token: credential.refresh_token } : {}),
		expires: credential.expires,
		...(credential.scopes !== undefined ? { scopes: credential.scopes } : {}),
		...(credential.displayName !== undefined ? { displayName: credential.displayName } : {}),
		...(credential.email !== undefined ? { email: credential.email } : {}),
		...(credential.accountId !== undefined ? { accountId: credential.accountId } : {}),
		...(credential.organizationName !== undefined ? { organizationName: credential.organizationName } : {}),
	}
}

/**
 * Keep fields this version does not model.
 *
 * A newer Dline may add credential fields; preserving them means an older
 * client that rewrites the document does not silently drop them.
 */
function preserveUnknownFields(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return {}
	return Object.fromEntries(Object.entries(value).filter(([key]) => !KNOWN_CREDENTIAL_KEYS.has(key)))
}

async function renameWithRetry(sourcePath: string, destinationPath: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rename(sourcePath, destinationPath)
			return
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (!code || !RETRYABLE_RENAME_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error
			await new Promise<void>((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]))
		}
	}
}

async function atomicWriteCredential(filePath: string, value: Record<string, unknown>): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
	try {
		await fs.writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 })
		await renameWithRetry(tempPath, filePath)
		await fs.chmod(filePath, 0o600)
	} catch (error) {
		await fs.unlink(tempPath).catch(() => undefined)
		throw error
	}
}

async function unlinkIfExists(filePath: string): Promise<void> {
	await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error
	})
}

/**
 * Owner of one Claude Code OAuth credential document per API Profile.
 *
 * Credentials are keyed by stable Profile ID and never share a document, so a
 * second Profile signing in cannot overwrite the first. They deliberately stay
 * out of the shared global secret blob.
 */
export class ClaudeCodeProfileAuthRepository {
	readonly secretsDir: string
	private readonly lock = new FileLock()

	constructor(options: ClaudeCodeProfileAuthRepositoryOptions = {}) {
		this.secretsDir = path.resolve(options.secretsDir ?? path.join(getDlineDataDir(), "secrets"))
	}

	filePath(profileId: string): string {
		return getClaudeCodeProfileAuthPath(this.secretsDir, profileId)
	}

	async read(profileId: string): Promise<ClaudeCodeProfileAuthReadResult> {
		return this.readPath(this.filePath(profileId))
	}

	async save(profileId: string, credential: ClaudeCodeOAuthCredentials): Promise<void> {
		const validated = parseClaudeCodeOAuthCredentials(credential)
		await this.withProfileFile(profileId, async (filePath) => {
			const existing = await this.readRawObject(filePath)
			await atomicWriteCredential(filePath, { ...preserveUnknownFields(existing), ...serializeCredential(validated) })
		})
	}

	async importCredential(profileId: string, value: unknown): Promise<ClaudeCodeOAuthCredentials> {
		const credential = parseClaudeCodeOAuthCredentials(value)
		await this.withProfileFile(profileId, async (filePath) => {
			await atomicWriteCredential(filePath, { ...preserveUnknownFields(value), ...serializeCredential(credential) })
		})
		return credential
	}

	async delete(profileId: string): Promise<void> {
		await this.withProfileFile(profileId, (filePath) => unlinkIfExists(filePath))
	}

	/**
	 * Replace a credential only when the stored document still matches.
	 *
	 * A refresh started from a stale in-memory copy must not clobber a newer
	 * credential written by another window.
	 */
	async replaceIfMatches(
		profileId: string,
		expectedCredential: ClaudeCodeOAuthCredentials,
		nextCredential: ClaudeCodeOAuthCredentials,
	): Promise<ClaudeCodeProfileAuthReplaceResult> {
		const expected = parseClaudeCodeOAuthCredentials(expectedCredential)
		const next = parseClaudeCodeOAuthCredentials(nextCredential)
		return this.withProfileFile(profileId, async (filePath) => {
			const current = await this.readPath(filePath)
			if (current.status !== "valid") return current.status
			if (!credentialsEqual(current.credential, expected)) return "changed"
			const existing = await this.readRawObject(filePath)
			await atomicWriteCredential(filePath, { ...preserveUnknownFields(existing), ...serializeCredential(next) })
			return "saved"
		})
	}

	async deleteIfMatches(
		profileId: string,
		expectedCredential: ClaudeCodeOAuthCredentials,
	): Promise<ClaudeCodeProfileAuthDeleteIfMatchesResult> {
		const expected = parseClaudeCodeOAuthCredentials(expectedCredential)
		return this.withProfileFile(profileId, async (filePath) => {
			const current = await this.readPath(filePath)
			if (current.status !== "valid") return current.status
			if (!credentialsEqual(current.credential, expected)) return "changed"
			await unlinkIfExists(filePath)
			return "deleted"
		})
	}

	private async withProfileFile<T>(profileId: string, operation: (filePath: string) => Promise<T>): Promise<T> {
		const filePath = this.filePath(profileId)
		await fs.mkdir(this.secretsDir, { recursive: true })
		return this.lock.withLock(filePath, () => operation(filePath))
	}

	private async readPath(filePath: string): Promise<ClaudeCodeProfileAuthReadResult> {
		let raw: string
		try {
			raw = await fs.readFile(filePath, "utf8")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" }
			throw error
		}
		try {
			return { status: "valid", credential: parseClaudeCodeOAuthCredentials(JSON.parse(raw)) }
		} catch {
			return { status: "malformed" }
		}
	}

	private async readRawObject(filePath: string): Promise<unknown> {
		try {
			return JSON.parse(await fs.readFile(filePath, "utf8"))
		} catch {
			return undefined
		}
	}
}
