import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
    EXCHANGE_OPERATION_TTL_MS,
    ExchangeOperationConflictError,
    ExchangeOperationExpiredError,
} from "@/services/telemetry/remote/contracts/exchangeOperation"
import { ExchangeOperationRepository } from "../ExchangeOperationRepository"
import { resolveOtelStorageLayout } from "../OtelStorageLayout"

const PRINCIPAL = "p".repeat(43)
const REQUEST_ID_1 = "11111111-1111-4111-8111-111111111111"
const REQUEST_ID_2 = "22222222-2222-4222-8222-222222222222"
const TOKEN = "t".repeat(43)

function request(requestId: string, clientVersion = "0.11.1") {
    return {
        operation: "device.grant" as const,
        request_id: requestId,
        device_secret: PRINCIPAL,
        requested_profile: "usage",
        client_version: clientVersion,
        platform: "win32",
        supported_usage_schema_versions: [4] as const,
    }
}

describe("ExchangeOperationRepository", () => {
    let root: string
    let now: number

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-exchange-operation-"))
        now = 1_900_000_000_000
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function repository() {
        return new ExchangeOperationRepository(resolveOtelStorageLayout(path.join(root, "data")), { clock: () => now })
    }

    it("persists one request identity before transport and resumes it across repository instances", async () => {
        const first = await repository().prepare({ principal: PRINCIPAL, request: request(REQUEST_ID_1) })
        const resumed = await repository().prepare({ principal: PRINCIPAL, request: request(REQUEST_ID_2) })

        expect(first.intent.requestId).toBe(REQUEST_ID_1)
        expect(resumed).toEqual(first)
        expect(first.intent.expiresAt - first.intent.createdAt).toBe(EXCHANGE_OPERATION_TTL_MS)
    })

    it("rejects a changed canonical body under the pending operation", async () => {
        const operations = repository()
        await operations.prepare({ principal: PRINCIPAL, request: request(REQUEST_ID_1) })

        await expect(
            operations.prepare({ principal: PRINCIPAL, request: request(REQUEST_ID_2, "0.11.2") }),
        ).rejects.toBeInstanceOf(ExchangeOperationConflictError)
    })

    it("fails an expired identity explicitly instead of minting another request", async () => {
        const operations = repository()
        await operations.prepare({ principal: PRINCIPAL, request: request(REQUEST_ID_1) })
        now += EXCHANGE_OPERATION_TTL_MS

        await expect(operations.prepare({ principal: PRINCIPAL, request: request(REQUEST_ID_2) })).rejects.toBeInstanceOf(
            ExchangeOperationExpiredError,
        )
    })

    it("stores only an authenticated-encrypted receipt and recovers the exact response", async () => {
        const operations = repository()
        const prepared = await operations.prepare({ principal: PRINCIPAL, request: request(REQUEST_ID_1) })
        const response = {
            status: 200,
            json: { ok: true, request_id: REQUEST_ID_1, access_token: TOKEN },
            retryAfter: null,
        }

        await operations.storeReceipt(prepared.intent, PRINCIPAL, response)
        const replay = await repository().prepare({ principal: PRINCIPAL, request: request(REQUEST_ID_2) })
        const filePath = path.join(root, "data", "secrets", "otel", "exchange-operations.json")
        const raw = await fs.readFile(filePath, "utf8")

        expect(replay.response).toEqual(response)
        expect(raw).not.toContain(PRINCIPAL)
        expect(raw).not.toContain(TOKEN)
        expect(raw).not.toContain("access_token")
        if (process.platform !== "win32") expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600)
    })

    it("removes a completed operation only after publication", async () => {
        const operations = repository()
        const prepared = await operations.prepare({ principal: PRINCIPAL, request: request(REQUEST_ID_1) })
        await operations.storeReceipt(prepared.intent, PRINCIPAL, { status: 200, json: { ok: true }, retryAfter: null })

        await operations.complete(PRINCIPAL, "device.grant", prepared.intent.requestId)
        const next = await operations.prepare({ principal: PRINCIPAL, request: request(REQUEST_ID_2) })

        expect(next.intent.requestId).toBe(REQUEST_ID_2)
        expect(next.response).toBeUndefined()
    })
})
