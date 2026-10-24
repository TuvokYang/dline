import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ExchangeOperationRepository } from "@/core/storage/telemetry-remote/ExchangeOperationRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { WireResponse } from "../../contracts/classification"
import type { AtomicDeviceGrant } from "../../contracts/deviceGrant"
import {
    EXCHANGE_OPERATION_TTL_MS,
    ExchangeOperationConflictError,
    ExchangeOperationExpiredError,
    type ExchangeOperationRequest,
    type RecoverableExchangeTransport,
} from "../../contracts/exchangeOperation"
import { type DeviceGrantPort, DeviceGrantRefusalError } from "../DeviceGrantPort"
import { RecoverableExchangeCoordinator } from "../RecoverableExchangeCoordinator"

const PRINCIPAL = "p".repeat(43)
const TOKEN = "t".repeat(43)
const REQUEST_ID_1 = "11111111-1111-4111-8111-111111111111"
const REQUEST_ID_2 = "22222222-2222-4222-8222-222222222222"
const DAY_MS = 24 * 60 * 60_000

function grantResponse(requestId: string, expiresAt: number): WireResponse {
    return {
        status: 200,
        retryAfter: null,
        json: {
            ok: true,
            request_id: requestId,
            access_token: TOKEN,
            device_id: "device-1",
            profile: "usage",
            scopes: ["usage"],
            expires_at: expiresAt,
            usage_contract: {
                schema_version: 4,
                contract_version: 4,
                max_body_bytes: 65_536,
                max_buckets: 8,
                max_facts: 32,
                max_tool_rows: 384,
                max_write_rows: 486,
                event_window_ms: 600_000,
                default_interval_ms: 600_000,
                new_batch_jitter_max_ms: 300_000,
            },
        },
    }
}

class MemoryGrantPort implements DeviceGrantPort {
    grant: AtomicDeviceGrant | null = null
    publishCount = 0

    async publish(grant: AtomicDeviceGrant): Promise<void> {
        this.publishCount += 1
        this.grant = grant
    }

    async readActive(now: number): Promise<AtomicDeviceGrant | null> {
        return this.grant && this.grant.expiresAt > now ? this.grant : null
    }
}

class ScriptedTransport implements RecoverableExchangeTransport {
    readonly requests: Array<ExchangeOperationRequest & object> = []
    readonly replies: Array<WireResponse | Error> = []

    async requestRecoverableDeviceOrIssueExchange(request: ExchangeOperationRequest & object): Promise<WireResponse> {
        this.requests.push(request)
        const reply = this.replies.shift()
        if (!reply) throw new Error("missing scripted response")
        if (reply instanceof Error) throw reply
        return reply
    }
}

describe("RecoverableExchangeCoordinator", () => {
    let root: string
    let now: number
    let repository: ExchangeOperationRepository
    let port: MemoryGrantPort

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-recoverable-exchange-"))
        now = 1_900_000_000_000
        repository = new ExchangeOperationRepository(resolveOtelStorageLayout(path.join(root, "data")), { clock: () => now })
        port = new MemoryGrantPort()
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function coordinator(transport: RecoverableExchangeTransport, requestId = REQUEST_ID_1, clientVersion = "0.11.1") {
        return new RecoverableExchangeCoordinator({
            port,
            repository,
            transport,
            clientVersion,
            platform: "win32",
            clock: () => now,
            requestId: () => requestId,
        })
    }

    it("replays the same request identity after an unknown transport outcome", async () => {
        const failed = new ScriptedTransport()
        failed.replies.push(new Error("connection reset"))
        await expect(coordinator(failed).ensureActiveGrant(PRINCIPAL)).resolves.toBeNull()

        const recovered = new ScriptedTransport()
        recovered.replies.push(grantResponse(REQUEST_ID_1, now + 30 * DAY_MS))
        const grant = await coordinator(recovered, REQUEST_ID_2).ensureActiveGrant(PRINCIPAL)

        expect(failed.requests[0]).toMatchObject({ request_id: REQUEST_ID_1 })
        expect(recovered.requests[0]).toMatchObject({ request_id: REQUEST_ID_1 })
        expect(grant?.accessToken).toBe(TOKEN)
        expect(port.publishCount).toBe(1)
    })

    it("does not seal retryable service errors and retries the same request over the network", async () => {
        const transport = new ScriptedTransport()
        transport.replies.push(
            { status: 503, json: { ok: false, error: { code: "unavailable" } }, retryAfter: "5" },
            grantResponse(REQUEST_ID_1, now + 30 * DAY_MS),
        )
        const running = coordinator(transport)

        await expect(running.ensureActiveGrant(PRINCIPAL)).resolves.toBeNull()
        await expect(running.ensureActiveGrant(PRINCIPAL)).resolves.toMatchObject({ accessToken: TOKEN })

        expect(transport.requests).toHaveLength(2)
        expect(new Set(transport.requests.map((request) => request.request_id))).toEqual(new Set([REQUEST_ID_1]))
    })

    it("surfaces a revoked credential so the broker can clear every local token", async () => {
        const transport = new ScriptedTransport()
        transport.replies.push({
            status: 403,
            json: { ok: false, error: { code: "device_revoked" } },
            retryAfter: null,
        })

        const error = await coordinator(transport)
            .ensureActiveGrant(PRINCIPAL)
            .then(
                () => undefined,
                (failure: unknown) => failure,
            )

        expect(error).toBeInstanceOf(DeviceGrantRefusalError)
        expect((error as DeviceGrantRefusalError).refusal).toEqual({ kind: "reset_credential", code: "device_revoked" })
    })

    it("recovers an encrypted receipt without another network request", async () => {
        const request = {
            operation: "device.grant" as const,
            request_id: REQUEST_ID_1,
            device_secret: PRINCIPAL,
            requested_profile: "usage",
            client_version: "0.11.1",
            platform: "win32",
            supported_usage_schema_versions: [4] as const,
        }
        const prepared = await repository.prepare({ principal: PRINCIPAL, request })
        await repository.storeReceipt(prepared.intent, PRINCIPAL, grantResponse(REQUEST_ID_1, now + 30 * DAY_MS))
        const transport: RecoverableExchangeTransport = {
            requestRecoverableDeviceOrIssueExchange: vi.fn(() => Promise.reject(new Error("must not send"))),
        }

        const grant = await coordinator(transport, REQUEST_ID_2).ensureActiveGrant(PRINCIPAL)

        expect(grant?.accessToken).toBe(TOKEN)
        expect(transport.requestRecoverableDeviceOrIssueExchange).not.toHaveBeenCalled()
        expect(port.publishCount).toBe(1)
    })

    it("fails closed when an upgrade changes the pending canonical body", async () => {
        const first = new ScriptedTransport()
        first.replies.push(new Error("unknown outcome"))
        await coordinator(first, REQUEST_ID_1, "0.11.1").ensureActiveGrant(PRINCIPAL)

        await expect(
            coordinator(new ScriptedTransport(), REQUEST_ID_2, "0.11.2").ensureActiveGrant(PRINCIPAL),
        ).rejects.toBeInstanceOf(ExchangeOperationConflictError)
    })

    it("fails an expired pending identity without issuing another request", async () => {
        const first = new ScriptedTransport()
        first.replies.push(new Error("unknown outcome"))
        await coordinator(first).ensureActiveGrant(PRINCIPAL)
        now += EXCHANGE_OPERATION_TTL_MS
        const transport = new ScriptedTransport()

        await expect(coordinator(transport, REQUEST_ID_2).ensureActiveGrant(PRINCIPAL)).rejects.toBeInstanceOf(
            ExchangeOperationExpiredError,
        )
        expect(transport.requests).toHaveLength(0)
    })

    it("shares one transport attempt between concurrent callers", async () => {
        let release: ((response: WireResponse) => void) | undefined
        const transport: RecoverableExchangeTransport = {
            requestRecoverableDeviceOrIssueExchange: vi.fn(() => new Promise<WireResponse>((resolve) => (release = resolve))),
        }
        const running = coordinator(transport)
        const first = running.ensureActiveGrant(PRINCIPAL)
        const second = running.ensureActiveGrant(PRINCIPAL)
        while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
        release(grantResponse(REQUEST_ID_1, now + 30 * DAY_MS))

        const results = await Promise.all([first, second])
        expect(results).toEqual([port.grant, port.grant])
        expect(results[0]?.accessToken).toBe(TOKEN)
        expect(transport.requestRecoverableDeviceOrIssueExchange).toHaveBeenCalledTimes(1)
        expect(running.allowsLegacyFallback).toBe(false)
    })
})
