import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { stableJsonStringify } from "@shared/stable-json"
import { writeJsonAtomic } from "@shared/storage/atomic-file"
import type { WireResponse } from "@/services/telemetry/remote/contracts/classification"
import {
    EXCHANGE_OPERATION_SCHEMA_VERSION,
    EXCHANGE_OPERATION_TTL_MS,
    type ExchangeOperation,
    ExchangeOperationConflictError,
    ExchangeOperationExpiredError,
    type ExchangeOperationIntent,
    type ExchangeOperationRequest,
    exchangeOperationKey,
    hashCanonicalExchangeBody,
    hashExchangePrincipal,
    validateExchangeIntent,
} from "@/services/telemetry/remote/contracts/exchangeOperation"
import { FileLock } from "../backend/jsonl/FileLock"
import type { OtelStorageLayout } from "./OtelStorageLayout"
import { OWNER_ONLY_DIRECTORY_MODE, type QuarantineObserver, quarantineDocument } from "./quarantine"

const EXCHANGE_OPERATION_FILE_MODE = 0o600
const LOCK_ACQUIRE_ATTEMPTS = 50
const RECEIPT_IV_BYTES = 12
const RECEIPT_TAG_BYTES = 16
const RECEIPT_KEY_BYTES = 32
const MAX_RECEIPT_BYTES = 32 * 1024
const MAX_OPERATIONS = 64
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

interface EncryptedExchangeReceipt {
    readonly algorithm: "aes-256-gcm"
    readonly iv: string
    readonly ciphertext: string
    readonly tag: string
}

interface StoredExchangeOperation {
    readonly intent: ExchangeOperationIntent
    readonly receipt?: EncryptedExchangeReceipt
}

interface ExchangeOperationDocument {
    readonly operations: Readonly<Record<string, StoredExchangeOperation>>
}

interface StoredExchangeOperationDocument {
    readonly schema_version: typeof EXCHANGE_OPERATION_SCHEMA_VERSION
    readonly operations: Readonly<Record<string, unknown>>
}

export interface PrepareExchangeOperationInput {
    /** Stable operation identity, for example the device ID or device secret hash domain. */
    readonly principal: string
    /** Secret key material for the local receipt; defaults to principal for device bootstrap compatibility. */
    readonly receiptSecret?: string
    readonly request: ExchangeOperationRequest & object
}

export interface PreparedExchangeOperation {
    readonly intent: ExchangeOperationIntent
    /** Present only after a prior response was durably sealed before credential publication. */
    readonly response?: WireResponse
}

export interface ExchangeOperationRepositoryOptions {
    readonly clock?: () => number
    readonly onQuarantine?: QuarantineObserver
}

/**
 * Owner of the local recoverable-exchange journal.
 *
 * The document stores only privacy-safe intent hashes and an authenticated-
 * encrypted response. It never stores the principal, request body, bearer token
 * or decrypted response. A short cross-process lock protects intent selection
 * and receipt publication, and is never held across network I/O.
 */
export class ExchangeOperationRepository {
    private readonly lock = new FileLock({ maxAcquireAttempts: LOCK_ACQUIRE_ATTEMPTS })
    private readonly clock: () => number
    private readonly onQuarantine: QuarantineObserver | undefined
    private readonly filePath: string

    constructor(
        private readonly layout: OtelStorageLayout,
        options: ExchangeOperationRepositoryOptions = {},
    ) {
        this.clock = options.clock ?? Date.now
        this.onQuarantine = options.onQuarantine
        this.filePath = path.join(layout.secretsDir, "exchange-operations.json")
    }

    /** Persist a new intent or resume the exact existing operation before any request is sent. */
    async prepare(input: PrepareExchangeOperationInput): Promise<PreparedExchangeOperation> {
        const principalHash = hashExchangePrincipal(input.principal)
        const operation = input.request.operation
        const key = exchangeOperationKey(principalHash, operation)
        const bodyHash = hashCanonicalExchangeBody(input.request)
        return this.withLock(async () => {
            const document = await this.readForWrite()
            const existing = document.operations[key]
            if (existing) {
                if (existing.intent.bodyHash !== bodyHash) throw new ExchangeOperationConflictError()
                if (this.clock() >= existing.intent.expiresAt) throw new ExchangeOperationExpiredError()
                if (!existing.receipt) return { intent: existing.intent }
                try {
                    return {
                        intent: existing.intent,
                        response: decryptReceipt(existing.intent, existing.receipt, input.receiptSecret ?? input.principal),
                    }
                } catch {
                    // The request may already have committed remotely. Drop only the unreadable local
                    // receipt and replay the same identity/body instead of minting another operation.
                    await this.write({ operations: { ...document.operations, [key]: { intent: existing.intent } } })
                    return { intent: existing.intent }
                }
            }
            if (Object.keys(document.operations).length >= MAX_OPERATIONS) {
                throw new Error("Exchange operation journal capacity was exceeded")
            }
            const createdAt = this.clock()
            const intent = validateExchangeIntent({
                operation,
                requestId: input.request.request_id,
                principalHash,
                bodyHash,
                createdAt,
                expiresAt: createdAt + EXCHANGE_OPERATION_TTL_MS,
            })
            await this.write({ operations: { ...document.operations, [key]: { intent } } })
            return { intent }
        })
    }

    /** Seal the exact response before any credential or authorization projection is published. */
    async storeReceipt(intent: ExchangeOperationIntent, receiptSecret: string, response: WireResponse): Promise<void> {
        const validatedIntent = validateExchangeIntent(intent)
        const key = exchangeOperationKey(validatedIntent.principalHash, validatedIntent.operation)
        await this.withLock(async () => {
            const document = await this.readForWrite()
            const existing = document.operations[key]
            if (!existing || !sameIntent(existing.intent, validatedIntent)) {
                throw new Error("Exchange operation intent changed before its response was sealed")
            }
            if (this.clock() >= existing.intent.expiresAt) throw new ExchangeOperationExpiredError()
            const receipt = encryptReceipt(existing.intent, response, receiptSecret)
            await this.write({ operations: { ...document.operations, [key]: { intent: existing.intent, receipt } } })
        })
    }

    /** Drop only a non-publishable legacy receipt while preserving the original operation identity for retry. */
    async clearReceipt(intent: ExchangeOperationIntent): Promise<void> {
        const validatedIntent = validateExchangeIntent(intent)
        const key = exchangeOperationKey(validatedIntent.principalHash, validatedIntent.operation)
        await this.withLock(async () => {
            const document = await this.readForWrite()
            const existing = document.operations[key]
            if (!existing?.receipt || !sameIntent(existing.intent, validatedIntent)) return
            await this.write({ operations: { ...document.operations, [key]: { intent: existing.intent } } })
        })
    }

    /** Remove a completed operation only after its stable authority accepted the recovered response. */
    async complete(principal: string, operation: ExchangeOperation, requestId?: string): Promise<void> {
        const key = exchangeOperationKey(hashExchangePrincipal(principal), operation)
        await this.withLock(async () => {
            const document = await this.readForWrite()
            const existing = document.operations[key]
            if (!existing || (requestId !== undefined && existing.intent.requestId !== requestId)) return
            const operations = { ...document.operations }
            delete operations[key]
            await this.write({ operations })
        })
    }

    /** An already-published authority projection makes every local intent for this operation obsolete. */
    async completeAll(operation: ExchangeOperation): Promise<void> {
        await this.withLock(async () => {
            const document = await this.readForWrite()
            const operations = Object.fromEntries(
                Object.entries(document.operations).filter(([, entry]) => entry.intent.operation !== operation),
            )
            if (Object.keys(operations).length === Object.keys(document.operations).length) return
            await this.write({ operations })
        })
    }

    private async withLock<T>(operation: () => Promise<T>): Promise<T> {
        await fs.mkdir(this.layout.secretsDir, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
        return this.lock.withLock(this.filePath, operation)
    }

    private async readForWrite(): Promise<ExchangeOperationDocument> {
        let raw: string
        try {
            raw = await fs.readFile(this.filePath, "utf8")
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { operations: {} }
            throw error
        }
        try {
            return parseDocument(JSON.parse(raw))
        } catch (error) {
            if (isUnsupportedDocument(error)) throw error
            if (await quarantineDocument(this.filePath, this.layout.secretsQuarantineDir, this.clock())) {
                this.onQuarantine?.(path.basename(this.filePath))
            }
            return { operations: {} }
        }
    }

    private write(document: ExchangeOperationDocument): Promise<void> {
        return writeJsonAtomic(this.filePath, serializeDocument(document), {
            fsync: true,
            mode: EXCHANGE_OPERATION_FILE_MODE,
        })
    }
}

function encryptReceipt(
    intent: ExchangeOperationIntent,
    response: WireResponse,
    receiptSecret: string,
): EncryptedExchangeReceipt {
    const plaintext = Buffer.from(
        JSON.stringify({
            status: response.status,
            has_json: response.json !== undefined,
            ...(response.json === undefined ? {} : { json: response.json }),
            retry_after: response.retryAfter,
        }),
        "utf8",
    )
    if (plaintext.byteLength > MAX_RECEIPT_BYTES) throw new Error("Exchange response receipt is too large")
    const iv = randomBytes(RECEIPT_IV_BYTES)
    const cipher = createCipheriv("aes-256-gcm", deriveReceiptKey(receiptSecret), iv, { authTagLength: RECEIPT_TAG_BYTES })
    cipher.setAAD(Buffer.from(stableJsonStringify(intent), "utf8"))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return {
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
    }
}

function decryptReceipt(intent: ExchangeOperationIntent, receipt: EncryptedExchangeReceipt, receiptSecret: string): WireResponse {
    const decipher = createDecipheriv("aes-256-gcm", deriveReceiptKey(receiptSecret), Buffer.from(receipt.iv, "base64url"), {
        authTagLength: RECEIPT_TAG_BYTES,
    })
    decipher.setAAD(Buffer.from(stableJsonStringify(intent), "utf8"))
    decipher.setAuthTag(Buffer.from(receipt.tag, "base64url"))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(receipt.ciphertext, "base64url")), decipher.final()])
    if (plaintext.byteLength > MAX_RECEIPT_BYTES) throw new Error("Exchange response receipt is too large")
    return parseReceiptPayload(JSON.parse(plaintext.toString("utf8")))
}

function deriveReceiptKey(receiptSecret: string): Buffer {
    return Buffer.from(
        hkdfSync(
            "sha256",
            Buffer.from(receiptSecret, "utf8"),
            Buffer.from("dline.exchange.local-receipt.salt.v1", "utf8"),
            Buffer.from("dline.exchange.local-receipt.key.v1", "utf8"),
            RECEIPT_KEY_BYTES,
        ),
    )
}

function parseReceiptPayload(value: unknown): WireResponse {
    if (!isRecord(value)) throw new Error("Exchange response receipt is invalid")
    const status = value.status
    if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
        throw new Error("Exchange response receipt is invalid")
    }
    if (typeof value.has_json !== "boolean") throw new Error("Exchange response receipt JSON marker is invalid")
    if (value.retry_after !== null && typeof value.retry_after !== "string") {
        throw new Error("Exchange response receipt retry-after value is invalid")
    }
    return {
        status,
        json: value.has_json ? value.json : undefined,
        retryAfter: value.retry_after,
    }
}

function parseDocument(value: unknown): ExchangeOperationDocument {
    if (!isRecord(value)) throw new Error("Invalid exchange operation journal")
    const schemaVersion = value.schema_version
    if (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion)) {
        throw new Error("Invalid exchange operation journal")
    }
    if (schemaVersion > EXCHANGE_OPERATION_SCHEMA_VERSION) {
        const error = new Error("Exchange operation journal belongs to a newer Dline")
        error.name = "UnsupportedExchangeOperationDocument"
        throw error
    }
    if (schemaVersion !== EXCHANGE_OPERATION_SCHEMA_VERSION || !isRecord(value.operations)) {
        throw new Error("Invalid exchange operation journal")
    }
    const entries = Object.entries(value.operations)
    if (entries.length > MAX_OPERATIONS) throw new Error("Exchange operation journal contains too many entries")
    const operations: Record<string, StoredExchangeOperation> = {}
    for (const [key, raw] of entries) {
        if (!/^sha256:[0-9a-f]{64}$/.test(key) || !isRecord(raw)) throw new Error("Invalid exchange operation entry")
        const intent = parseIntent(raw.intent)
        if (exchangeOperationKey(intent.principalHash, intent.operation) !== key)
            throw new Error("Exchange operation key mismatch")
        operations[key] = {
            intent,
            ...(raw.receipt === undefined ? {} : { receipt: parseEncryptedReceipt(raw.receipt) }),
        }
    }
    return { operations }
}

function parseIntent(value: unknown): ExchangeOperationIntent {
    if (!isRecord(value)) throw new Error("Invalid exchange operation intent")
    return validateExchangeIntent({
        operation: value.operation as ExchangeOperation,
        requestId: value.request_id as string,
        principalHash: value.principal_hash as string,
        bodyHash: value.body_hash as string,
        createdAt: value.created_at as number,
        expiresAt: value.expires_at as number,
    })
}

function parseEncryptedReceipt(value: unknown): EncryptedExchangeReceipt {
    if (
        !isRecord(value) ||
        value.algorithm !== "aes-256-gcm" ||
        !isBase64Url(value.iv) ||
        !isBase64Url(value.ciphertext) ||
        !isBase64Url(value.tag) ||
        Buffer.from(value.iv, "base64url").byteLength !== RECEIPT_IV_BYTES ||
        Buffer.from(value.tag, "base64url").byteLength !== RECEIPT_TAG_BYTES
    ) {
        throw new Error("Invalid encrypted exchange receipt")
    }
    return { algorithm: "aes-256-gcm", iv: value.iv, ciphertext: value.ciphertext, tag: value.tag }
}

function serializeDocument(document: ExchangeOperationDocument): StoredExchangeOperationDocument {
    return {
        schema_version: EXCHANGE_OPERATION_SCHEMA_VERSION,
        operations: Object.fromEntries(
            Object.entries(document.operations).map(([key, operation]) => [
                key,
                {
                    intent: {
                        operation: operation.intent.operation,
                        request_id: operation.intent.requestId,
                        principal_hash: operation.intent.principalHash,
                        body_hash: operation.intent.bodyHash,
                        created_at: operation.intent.createdAt,
                        expires_at: operation.intent.expiresAt,
                    },
                    ...(operation.receipt ? { receipt: operation.receipt } : {}),
                },
            ]),
        ),
    }
}

function sameIntent(left: ExchangeOperationIntent, right: ExchangeOperationIntent): boolean {
    return stableJsonStringify(left) === stableJsonStringify(right)
}

function isBase64Url(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && BASE64URL_PATTERN.test(value)
}

function isUnsupportedDocument(error: unknown): boolean {
    return error instanceof Error && error.name === "UnsupportedExchangeOperationDocument"
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
