import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ExchangeOperationRepository } from "@/core/storage/telemetry-remote/ExchangeOperationRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { WireResponse } from "../../contracts/classification"
import {
    EXCHANGE_OPERATION_TTL_MS,
    ExchangeOperationConflictError,
    ExchangeOperationExpiredError,
    type IssueExchangeRequest,
    type IssueExchangeTransport,
} from "../../contracts/exchangeOperation"
import type { AtomicIssueGrant } from "../../contracts/issueGrant"
import type { IssueGrantPort } from "../IssueGrantPort"
import { RecoverableIssueExchangeCoordinator } from "../RecoverableIssueExchangeCoordinator"

const DEVICE_ID = `dev_${"d".repeat(32)}`
const DEVICE_TOKEN_1 = "a".repeat(43)
const DEVICE_TOKEN_2 = "b".repeat(43)
const CODE_1 = "c".repeat(43)
const CODE_2 = "e".repeat(43)
const ISSUE_TOKEN = "i".repeat(43)
const REQUEST_ID_1 = "11111111-1111-4111-8111-111111111111"
const REQUEST_ID_2 = "22222222-2222-4222-8222-222222222222"

function granted(requestId: string, expiresAt: number, revision = 2): WireResponse {
    return {
        status: 200,
        retryAfter: null,
        json: {
            ok: true,
            request_id: requestId,
            access_token: ISSUE_TOKEN,
            profile: "issue_diagnostic",
            scopes: ["error", "runtime", "debug", "high_density_metrics", "high_density_traces"],
            authorization_id: "auth-fixture-001",
            authorization_revision: revision,
            expires_at: expiresAt,
            capture_expires_at: expiresAt,
            rate_limits: {
                authorization_bytes: 8 * 1024 * 1024,
                authorization_requests: 120,
                authorization_records: 20_000,
            },
        },
    }
}

class MemoryIssuePort implements IssueGrantPort {
    grant: AtomicIssueGrant | null = null
    publishCount = 0
    readonly clears: string[] = []

    async publish(grant: AtomicIssueGrant): Promise<void> {
        this.publishCount += 1
        this.grant = grant
    }

    async readActive(now: number, revision: number): Promise<AtomicIssueGrant | null> {
        return this.grant && this.grant.authorizationRevision === revision && this.grant.expiresAt > now ? this.grant : null
    }

    async clear(reason: Parameters<IssueGrantPort["clear"]>[0]): Promise<void> {
        this.clears.push(reason)
        this.grant = null
    }
}

class ScriptedIssueTransport implements IssueExchangeTransport {
    readonly calls: Array<{ request: IssueExchangeRequest; token: string }> = []
    readonly replies: Array<WireResponse | Error> = []

    async requestRecoverableIssueExchange(request: IssueExchangeRequest, token: string): Promise<WireResponse> {
        this.calls.push({ request, token })
        const reply = this.replies.shift()
        if (!reply) throw new Error("missing scripted issue response")
        if (reply instanceof Error) throw reply
        return reply
    }
}

describe("RecoverableIssueExchangeCoordinator", () => {
    let root: string
    let now: number
    let repository: ExchangeOperationRepository
    let port: MemoryIssuePort

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-issue-exchange-"))
        now = 1_900_000_000_000
        repository = new ExchangeOperationRepository(resolveOtelStorageLayout(path.join(root, "data")), { clock: () => now })
        port = new MemoryIssuePort()
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function coordinator(transport: IssueExchangeTransport, requestId = REQUEST_ID_1) {
        return new RecoverableIssueExchangeCoordinator({
            port,
            repository,
            transport,
            clientVersion: "0.12.0",
            platform: "win32",
            clock: () => now,
            requestId: () => requestId,
        })
    }

    const input = (token = DEVICE_TOKEN_1, authorizationCode = CODE_1, revision = 2) => ({
        deviceId: DEVICE_ID,
        deviceAccessToken: token,
        authorizationCode,
        authorizationRevision: revision,
    })

    it("replays the same server request after an unknown outcome while allowing a refreshed device bearer", async () => {
        const first = new ScriptedIssueTransport()
        first.replies.push(new Error("connection reset"))
        await expect(coordinator(first).exchange(input())).resolves.toEqual({ status: "retry", code: "transport_unknown" })

        const second = new ScriptedIssueTransport()
        second.replies.push(granted(REQUEST_ID_1, now + 60_000))
        const result = await coordinator(second, REQUEST_ID_2).exchange(input(DEVICE_TOKEN_2))

        expect(first.calls[0]?.request).toEqual({
            operation: "issue.exchange",
            request_id: REQUEST_ID_1,
            authorization_code: CODE_1,
            authorization_revision: 2,
            client_version: "0.12.0",
            platform: "win32",
        })
        expect(second.calls[0]).toMatchObject({ request: { request_id: REQUEST_ID_1 }, token: DEVICE_TOKEN_2 })
        expect(result).toMatchObject({ status: "ready", grant: { accessToken: ISSUE_TOKEN } })
        expect(port.publishCount).toBe(1)
    })

    it("recovers an encrypted successful receipt before making another request", async () => {
        const request: IssueExchangeRequest = {
            operation: "issue.exchange",
            request_id: REQUEST_ID_1,
            authorization_code: CODE_1,
            authorization_revision: 2,
            client_version: "0.12.0",
            platform: "win32",
        }
        const prepared = await repository.prepare({ principal: DEVICE_ID, receiptSecret: CODE_1, request })
        await repository.storeReceipt(prepared.intent, CODE_1, granted(REQUEST_ID_1, now + 60_000))
        const transport: IssueExchangeTransport = {
            requestRecoverableIssueExchange: vi.fn(() => Promise.reject(new Error("must not send"))),
        }

        const result = await coordinator(transport, REQUEST_ID_2).exchange(input())

        expect(result.status).toBe("ready")
        expect(transport.requestRecoverableIssueExchange).not.toHaveBeenCalled()
        expect(port.publishCount).toBe(1)
        const raw = await fs
            .readFile(path.join(root, "data", "secrets", "otel", "exchange-operations.json"), "utf8")
            .catch(() => "")
        expect(raw).not.toContain(CODE_1)
        expect(raw).not.toContain(ISSUE_TOKEN)
    })

    it("does not seal pending or unauthorized responses and retries the same operation", async () => {
        const transport = new ScriptedIssueTransport()
        transport.replies.push(
            {
                status: 202,
                retryAfter: "60",
                json: { ok: false, error: { code: "authorization_pending" } },
            },
            {
                status: 401,
                retryAfter: null,
                json: { ok: false, error: { code: "invalid_access_token" } },
            },
            granted(REQUEST_ID_1, now + 60_000),
        )
        const running = coordinator(transport)

        await expect(running.exchange(input())).resolves.toMatchObject({ status: "pending", code: "authorization_pending" })
        await expect(running.exchange(input())).resolves.toEqual({ status: "refresh_device", code: "invalid_access_token" })
        await expect(running.exchange(input(DEVICE_TOKEN_2))).resolves.toMatchObject({ status: "ready" })

        expect(transport.calls).toHaveLength(3)
        expect(new Set(transport.calls.map((call) => call.request.request_id))).toEqual(new Set([REQUEST_ID_1]))
        expect(transport.calls[2]?.token).toBe(DEVICE_TOKEN_2)
    })

    it("shares only the exact same in-flight issue operation", async () => {
        let release: ((response: WireResponse) => void) | undefined
        const transport: IssueExchangeTransport = {
            requestRecoverableIssueExchange: vi.fn(() => new Promise<WireResponse>((resolve) => (release = resolve))),
        }
        const running = coordinator(transport)
        const first = running.exchange(input())
        const second = running.exchange(input())
        while (!release) await new Promise((resolve) => setTimeout(resolve, 1))

        await expect(running.exchange(input(DEVICE_TOKEN_1, CODE_2, 3))).rejects.toBeInstanceOf(ExchangeOperationConflictError)
        release(granted(REQUEST_ID_1, now + 60_000))
        await expect(Promise.all([first, second])).resolves.toHaveLength(2)
        expect(transport.requestRecoverableIssueExchange).toHaveBeenCalledTimes(1)
    })

    it("does not turn a malformed request refusal into a local revoke tombstone", async () => {
        const transport = new ScriptedIssueTransport()
        transport.replies.push({
            status: 400,
            retryAfter: null,
            json: { ok: false, error: { code: "invalid_exchange_request" } },
        })

        await expect(coordinator(transport).exchange(input())).resolves.toEqual({
            status: "stopped",
            code: "invalid_exchange_request",
        })
        expect(port.clears).toEqual([])
    })

    it("rejects a changed authorization code or revision while the original operation is pending", async () => {
        const transport = new ScriptedIssueTransport()
        transport.replies.push(new Error("unknown outcome"))
        await coordinator(transport).exchange(input())

        await expect(
            coordinator(new ScriptedIssueTransport(), REQUEST_ID_2).exchange(input(DEVICE_TOKEN_1, CODE_2, 3)),
        ).rejects.toBeInstanceOf(ExchangeOperationConflictError)
    })

    it("stops on an unknown authorization code instead of treating the 404 as pending", async () => {
        const transport = new ScriptedIssueTransport()
        transport.replies.push({
            status: 404,
            retryAfter: null,
            json: { ok: false, error: { code: "report_authorization_not_found" } },
        })

        await expect(coordinator(transport).exchange(input())).resolves.toEqual({
            status: "stopped",
            code: "report_authorization_not_found",
        })
        expect(port.clears).toEqual(["deleted"])
    })

    it("maps the server replay expiry and permits a later operation to use a new ID", async () => {
        const first = new ScriptedIssueTransport()
        first.replies.push({
            status: 410,
            retryAfter: null,
            json: { ok: false, error: { code: "exchange_operation_expired" } },
        })

        await expect(coordinator(first).exchange(input())).rejects.toBeInstanceOf(ExchangeOperationExpiredError)

        const replacement = new ScriptedIssueTransport()
        replacement.replies.push(granted(REQUEST_ID_2, now + 60_000))
        await expect(coordinator(replacement, REQUEST_ID_2).exchange(input())).resolves.toMatchObject({ status: "ready" })
        expect(replacement.calls[0]?.request.request_id).toBe(REQUEST_ID_2)
    })

    it("expires the local operation identity after twenty-four hours", async () => {
        const first = new ScriptedIssueTransport()
        first.replies.push(new Error("unknown outcome"))
        await coordinator(first).exchange(input())
        now += EXCHANGE_OPERATION_TTL_MS

        await expect(coordinator(new ScriptedIssueTransport(), REQUEST_ID_2).exchange(input())).rejects.toBeInstanceOf(
            ExchangeOperationExpiredError,
        )
    })

    it("clears the local issue grant when authorization is revoked", async () => {
        const transport = new ScriptedIssueTransport()
        transport.replies.push({
            status: 403,
            retryAfter: null,
            json: { ok: false, error: { code: "authorization_revoked" } },
        })

        await expect(coordinator(transport).exchange(input())).resolves.toEqual({
            status: "stopped",
            code: "authorization_revoked",
        })
        expect(port.clears).toEqual(["revoked"])
    })
})
