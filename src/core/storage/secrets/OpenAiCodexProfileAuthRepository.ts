import fs from "node:fs/promises"
import path from "node:path"
import { writeJsonAtomic } from "@shared/storage/atomic-file"
import { FileLock } from "../backend/jsonl/FileLock"
import { getDlineDataDir } from "../disk"
import { getLegacyHashedOpenAiCodexProfileAuthPath, getOpenAiCodexProfileAuthPath } from "./OpenAiCodexProfileAuthPath"

const MINIMUM_VALID_EXPIRY_MS = 1_000_000_000_000
/** Credentials are readable by their owner only. */
const CREDENTIAL_FILE_MODE = 0o600
const KNOWN_CREDENTIAL_KEYS = new Set([
	"type",
	"access_token",
	"refresh_token",
	"expires",
	"displayName",
	"email",
	"accountId",
	"accountType",
])

export interface OpenAiOAuthCredentials {
	type?: string
	access_token: string
	refresh_token?: string
	expires: number
	displayName?: string
	email?: string
	accountId?: string
	accountType?: string
}

export type OpenAiCodexProfileAuthReadResult =
	| { status: "missing" }
	| { status: "malformed" }
	| { status: "valid"; credential: OpenAiOAuthCredentials }

export type OpenAiCodexProfileAuthSaveIfMissingResult = "saved" | "existing" | "malformed"
export type OpenAiCodexProfileAuthReplaceResult = "saved" | "changed" | "missing" | "malformed"
export type OpenAiCodexProfileAuthDeleteIfMatchesResult = "deleted" | "changed" | "missing" | "malformed"

export interface OpenAiCodexProfileAuthRepositoryOptions {
	secretsDir?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireNonEmptyString(record: Record<string, unknown>, key: "access_token"): string {
	const value = record[key]
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`OpenAI OAuth credential ${key} must be a non-empty string.`)
	}
	return value
}

function optionalNonEmptyString(record: Record<string, unknown>, key: "refresh_token"): string | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`OpenAI OAuth credential ${key} must be a non-empty string when provided.`)
	}
	return value
}

export function parseOpenAiOAuthCredentials(value: unknown): OpenAiOAuthCredentials {
	if (!isRecord(value)) throw new Error("OpenAI OAuth credential must be a JSON object.")
	const expires = value.expires
	if (!Number.isSafeInteger(expires) || (expires as number) < MINIMUM_VALID_EXPIRY_MS) {
		throw new Error("OpenAI OAuth credential expires must be a valid millisecond timestamp.")
	}
	const refreshToken = optionalNonEmptyString(value, "refresh_token")

	return {
		access_token: requireNonEmptyString(value, "access_token"),
		...(refreshToken !== undefined ? { refresh_token: refreshToken } : {}),
		expires: expires as number,
		...(typeof value.type === "string" ? { type: value.type } : {}),
		...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
		...(typeof value.email === "string" ? { email: value.email } : {}),
		...(typeof value.accountId === "string" ? { accountId: value.accountId } : {}),
		...(typeof value.accountType === "string" ? { accountType: value.accountType } : {}),
	}
}

function credentialsEqual(left: OpenAiOAuthCredentials, right: OpenAiOAuthCredentials): boolean {
	return (
		left.type === right.type &&
		left.access_token === right.access_token &&
		left.refresh_token === right.refresh_token &&
		left.expires === right.expires &&
		left.displayName === right.displayName &&
		left.email === right.email &&
		left.accountId === right.accountId &&
		left.accountType === right.accountType
	)
}

function serializeCredential(credential: OpenAiOAuthCredentials): Record<string, unknown> {
	return {
		...(credential.type !== undefined ? { type: credential.type } : {}),
		access_token: credential.access_token,
		...(credential.refresh_token !== undefined ? { refresh_token: credential.refresh_token } : {}),
		expires: credential.expires,
		...(credential.displayName !== undefined ? { displayName: credential.displayName } : {}),
		...(credential.email !== undefined ? { email: credential.email } : {}),
		...(credential.accountId !== undefined ? { accountId: credential.accountId } : {}),
		...(credential.accountType !== undefined ? { accountType: credential.accountType } : {}),
	}
}

function preserveUnknownFields(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return {}
	return Object.fromEntries(Object.entries(value).filter(([key]) => !KNOWN_CREDENTIAL_KEYS.has(key)))
}

async function atomicWriteCredential(filePath: string, value: Record<string, unknown>): Promise<void> {
	await writeJsonAtomic(filePath, value, { mode: CREDENTIAL_FILE_MODE })
}

async function unlinkIfExists(filePath: string): Promise<void> {
	await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error
	})
}

export class OpenAiCodexProfileAuthRepository {
	readonly secretsDir: string
	private readonly lock = new FileLock()

	constructor(options: OpenAiCodexProfileAuthRepositoryOptions = {}) {
		this.secretsDir = path.resolve(options.secretsDir ?? path.join(getDlineDataDir(), "secrets"))
	}

	filePath(profileId: string): string {
		return getOpenAiCodexProfileAuthPath(this.secretsDir, profileId)
	}

	legacyHashedFilePath(profileId: string): string {
		return getLegacyHashedOpenAiCodexProfileAuthPath(this.secretsDir, profileId)
	}

	async read(profileId: string): Promise<OpenAiCodexProfileAuthReadResult> {
		const filePath = this.filePath(profileId)
		const legacyFilePath = this.legacyHashedFilePath(profileId)
		const [current, legacy] = await Promise.all([this.readPath(filePath), this.readPath(legacyFilePath)])
		if (current.status !== "missing" && legacy.status === "missing") return current
		if (current.status === "malformed") return current
		if (current.status === "missing" && legacy.status !== "valid") return legacy
		return this.withProfileFiles(profileId, (lockedFilePath, lockedLegacyFilePath) =>
			this.readAndMigrateLocked(lockedFilePath, lockedLegacyFilePath),
		)
	}

	async save(profileId: string, credential: OpenAiOAuthCredentials): Promise<void> {
		const validated = parseOpenAiOAuthCredentials(credential)
		await this.withProfileFiles(profileId, async (filePath, legacyFilePath) => {
			const current = await this.readRawObject(filePath)
			const existing = current ?? (await this.readRawObject(legacyFilePath))
			await atomicWriteCredential(filePath, { ...preserveUnknownFields(existing), ...serializeCredential(validated) })
			await unlinkIfExists(legacyFilePath)
		})
	}

	async importCredential(profileId: string, value: unknown): Promise<OpenAiOAuthCredentials> {
		const credential = parseOpenAiOAuthCredentials(value)
		await this.withProfileFiles(profileId, async (filePath, legacyFilePath) => {
			await atomicWriteCredential(filePath, { ...preserveUnknownFields(value), ...serializeCredential(credential) })
			await unlinkIfExists(legacyFilePath)
		})
		return credential
	}

	async saveIfMissing(
		profileId: string,
		credential: OpenAiOAuthCredentials,
	): Promise<OpenAiCodexProfileAuthSaveIfMissingResult> {
		return this.writeIfMissing(profileId, parseOpenAiOAuthCredentials(credential), {})
	}

	async importLegacyIfMissing(profileId: string, legacyValue: unknown): Promise<OpenAiCodexProfileAuthSaveIfMissingResult> {
		return this.writeIfMissing(profileId, parseOpenAiOAuthCredentials(legacyValue), preserveUnknownFields(legacyValue))
	}

	async delete(profileId: string): Promise<void> {
		await this.withProfileFiles(profileId, async (filePath, legacyFilePath) => {
			await unlinkIfExists(filePath)
			await unlinkIfExists(legacyFilePath)
		})
	}

	async replaceIfMatches(
		profileId: string,
		expectedCredential: OpenAiOAuthCredentials,
		nextCredential: OpenAiOAuthCredentials,
	): Promise<OpenAiCodexProfileAuthReplaceResult> {
		const expected = parseOpenAiOAuthCredentials(expectedCredential)
		const next = parseOpenAiOAuthCredentials(nextCredential)
		return this.withProfileFiles(profileId, async (filePath, legacyFilePath) => {
			const current = await this.readAndMigrateLocked(filePath, legacyFilePath)
			if (current.status !== "valid") return current.status
			if (!credentialsEqual(current.credential, expected)) return "changed"
			const existing = await this.readRawObject(filePath)
			await atomicWriteCredential(filePath, { ...preserveUnknownFields(existing), ...serializeCredential(next) })
			await unlinkIfExists(legacyFilePath)
			return "saved"
		})
	}

	async deleteIfMatches(
		profileId: string,
		expectedCredential: OpenAiOAuthCredentials,
	): Promise<OpenAiCodexProfileAuthDeleteIfMatchesResult> {
		const expected = parseOpenAiOAuthCredentials(expectedCredential)
		return this.withProfileFiles(profileId, async (filePath, legacyFilePath) => {
			const current = await this.readAndMigrateLocked(filePath, legacyFilePath)
			if (current.status !== "valid") return current.status
			if (!credentialsEqual(current.credential, expected)) return "changed"
			await unlinkIfExists(filePath)
			await unlinkIfExists(legacyFilePath)
			return "deleted"
		})
	}

	private async writeIfMissing(
		profileId: string,
		credential: OpenAiOAuthCredentials,
		unknownFields: Record<string, unknown>,
	): Promise<OpenAiCodexProfileAuthSaveIfMissingResult> {
		return this.withProfileFiles(profileId, async (filePath, legacyFilePath) => {
			const current = await this.readAndMigrateLocked(filePath, legacyFilePath)
			if (current.status === "valid") return "existing"
			if (current.status === "malformed") return "malformed"
			await atomicWriteCredential(filePath, { ...unknownFields, ...serializeCredential(credential) })
			await unlinkIfExists(legacyFilePath)
			return "saved"
		})
	}

	private async withProfileFiles<T>(
		profileId: string,
		operation: (filePath: string, legacyFilePath: string) => Promise<T>,
	): Promise<T> {
		const filePath = this.filePath(profileId)
		const legacyFilePath = this.legacyHashedFilePath(profileId)
		const [firstLockPath, secondLockPath] = [filePath, legacyFilePath].sort()
		await fs.mkdir(this.secretsDir, { recursive: true })
		return this.lock.withLock(firstLockPath, () =>
			this.lock.withLock(secondLockPath, () => operation(filePath, legacyFilePath)),
		)
	}

	private async readAndMigrateLocked(filePath: string, legacyFilePath: string): Promise<OpenAiCodexProfileAuthReadResult> {
		const current = await this.readPath(filePath)
		if (current.status === "valid") {
			await unlinkIfExists(legacyFilePath)
			return current
		}
		if (current.status === "malformed") return current

		const legacy = await this.readPath(legacyFilePath)
		if (legacy.status !== "valid") return legacy
		const raw = await this.readRawObject(legacyFilePath)
		await atomicWriteCredential(filePath, { ...preserveUnknownFields(raw), ...serializeCredential(legacy.credential) })
		await unlinkIfExists(legacyFilePath)
		return legacy
	}

	private async readPath(filePath: string): Promise<OpenAiCodexProfileAuthReadResult> {
		let raw: string
		try {
			raw = await fs.readFile(filePath, "utf8")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" }
			throw error
		}
		try {
			return { status: "valid", credential: parseOpenAiOAuthCredentials(JSON.parse(raw)) }
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
