import { mockFetchForTesting } from "@shared/net"
import { describe, expect, it } from "vitest"
import { classifyDeliveryResponse } from "../../contracts/classification"
import { DlineOtelHttpClient, DlineOtelTransportError, loopbackEndpointOverride } from "../DlineOtelHttpClient"

const TOKEN = "tok_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd"
const REQUEST_ID = "0b4f8a52-5d0e-4e55-9a0c-5a1f1e7c0a01"
/** Differs from the running build, so a user agent taken from anywhere but the option shows. */
const VERSION = "0.11.1-contract.7"

interface Captured {
    url: string
    init: RequestInit
}

function respondWith(response: () => Response, captured: Captured[] = []): typeof globalThis.fetch {
    return async (input, init) => {
        captured.push({ url: String(input), init: init ?? {} })
        return response()
    }
}

/** A fetch that only settles when its signal aborts, as a stalled connection would. */
const stalled: typeof globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    })

function failure(promise: Promise<unknown>): Promise<DlineOtelTransportError> {
    return promise.then(
        () => {
            throw new Error("expected the request to fail")
        },
        (error: unknown) => {
            if (!(error instanceof DlineOtelTransportError)) throw error
            return error
        },
    )
}

describe("DlineOtelHttpClient", () => {
    it("posts exact schema 5 Usage bytes with the fixed contract header and refuses redirects", async () => {
        const captured: Captured[] = []
        const body = new TextEncoder().encode('{"schema_version":5,"buckets":[]}')
        const ok = () =>
            new Response(JSON.stringify({ ok: true, disposition: "duplicate", next_eligible_at: 5 }), {
                status: 200,
                headers: { "retry-after": "3" },
            })

        const response = await mockFetchForTesting(respondWith(ok, captured), () =>
            new DlineOtelHttpClient({ clientVersion: VERSION, endpoint: "https://otel.example.test" }).sendUsage({
                accessToken: TOKEN,
                requestId: REQUEST_ID,
                body,
            }),
        )

        expect(captured).toHaveLength(1)
        expect(captured[0].url).toBe("https://otel.example.test/usage")
        expect(captured[0].init).toMatchObject({ method: "POST", redirect: "error", body })
        expect(captured[0].init.headers).toEqual({
            "User-Agent": `Dline/${VERSION}`,
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
            "x-dline-request-id": REQUEST_ID,
            "x-dline-contract": "5",
        })
        expect(classifyDeliveryResponse(response))
        expect(response.retryAfter).toBe("3")
    })

    it("keeps the OTLP specification path for logs and leaves Dline's own paths unprefixed", async () => {
        const captured: Captured[] = []
        const client = new DlineOtelHttpClient({ clientVersion: VERSION, endpoint: "https://otel.example.test" })
        const delivery = { accessToken: TOKEN, requestId: REQUEST_ID, body: new Uint8Array() }

        await mockFetchForTesting(
            respondWith(() => new Response("{}", { status: 503 }), captured),
            async () => {
                await client.sendLogs(delivery)
                await client.sendUsage(delivery)
            },
        )

        // `/v1` belongs to the OTLP wire convention; the service does not implement
        // the unprefixed spelling. `/usage` is Dline's own protocol and takes none.
        expect(captured[0].url).toBe("https://otel.example.test/v1/logs")
        expect(captured[1].url).toBe("https://otel.example.test/usage")
    })

    it("routes issue-only OTLP streams with the issue token and contract 5", async () => {
        const captured: Captured[] = []
        const client = new DlineOtelHttpClient({ clientVersion: VERSION, endpoint: "https://otel.example.test" })
        const body = new TextEncoder().encode("{}")

        await mockFetchForTesting(
            respondWith(() => new Response(JSON.stringify({ ok: true, disposition: "accepted" }), { status: 200 }), captured),
            async () => {
                for (const stream of ["logs", "metrics", "traces"] as const) {
                    await client.sendIssueDiagnostics({
                        stream,
                        accessToken: TOKEN,
                        requestId: `${REQUEST_ID}-${stream}`,
                        body,
                    })
                }
            },
        )

        expect(captured.map((request) => request.url)).toEqual([
            "https://otel.example.test/v1/logs",
            "https://otel.example.test/v1/metrics",
            "https://otel.example.test/v1/traces",
        ])
        for (const request of captured) {
            const headers = new Headers(request.init.headers)
            expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
            expect(headers.get("x-dline-contract")).toBe("5")
            expect(request.init.redirect).toBe("error")
        }
    })

    it("requests a device grant with the same request ID in the header and schema 5 body", async () => {
        const captured: Captured[] = []
        const request = {
            operation: "device.grant" as const,
            request_id: REQUEST_ID,
            device_secret: "s".repeat(43),
            requested_profile: "production" as const,
            client_version: "0.12.0",
            platform: "win32",
            supported_usage_schema_versions: [5] as const,
        }

        await mockFetchForTesting(
            respondWith(() => new Response("{}", { status: 503 }), captured),
            () =>
                new DlineOtelHttpClient({
                    clientVersion: VERSION,
                    endpoint: "http://127.0.0.1:8787",
                }).requestRecoverableDeviceOrIssueExchange(request),
        )

        expect(captured[0].url).toBe("http://127.0.0.1:8787/auth/device/grant")
        expect(captured[0].init).toMatchObject({ method: "POST", redirect: "error" })
        expect(captured[0].init.headers).toEqual({
            "User-Agent": `Dline/${VERSION}`,
            "content-type": "application/json",
            "x-dline-contract": "5",
            "x-dline-request-id": REQUEST_ID,
        })
        expect(JSON.parse(String(captured[0].init.body))).toEqual(request)
    })

    it("sends the server-owned issue exchange body with matching header identity and transport-only bearer", async () => {
        const captured: Captured[] = []
        const deviceToken = "d".repeat(43)
        const request = {
            operation: "issue.exchange" as const,
            request_id: REQUEST_ID,
            authorization_code: "s".repeat(43),
            authorization_revision: 1,
            client_version: VERSION,
            platform: "win32",
        }

        await mockFetchForTesting(
            respondWith(() => new Response("{}", { status: 503 }), captured),
            () =>
                new DlineOtelHttpClient({
                    clientVersion: VERSION,
                    endpoint: "http://127.0.0.1:8787",
                }).requestRecoverableIssueExchange(request, deviceToken),
        )

        expect(captured[0].url).toBe("http://127.0.0.1:8787/auth/exchange")
        expect(captured[0].init.headers).toEqual({
            "User-Agent": `Dline/${VERSION}`,
            authorization: `Bearer ${deviceToken}`,
            "content-type": "application/json",
            "x-dline-contract": "5",
            "x-dline-request-id": REQUEST_ID,
        })
        expect(JSON.parse(String(captured[0].init.body))).toEqual(request)
        expect(String(captured[0].init.body)).not.toContain(deviceToken)
    })

    it("refuses to send issue exchange through the unauthenticated device-grant transport", async () => {
        const client = new DlineOtelHttpClient({ clientVersion: VERSION })
        const request = {
            operation: "issue.exchange" as const,
            request_id: REQUEST_ID,
            authorization_code: "s".repeat(43),
            authorization_revision: 1,
            client_version: VERSION,
            platform: "win32",
        }
        expect(() => client.requestRecoverableDeviceOrIssueExchange(request)).toThrow("authenticated issue transport")
    })

    it("sends ticket issuance with its replay identity and the status query without one", async () => {
        const captured: Captured[] = []
        const deviceToken = "d".repeat(43)
        const authorizationCode = "s".repeat(43)
        const request = {
            operation: "report.authorize" as const,
            request_id: REQUEST_ID,
            temporary_telemetry_consent: true as const,
            client_version: VERSION,
            platform: "win32",
        }
        const client = new DlineOtelHttpClient({ clientVersion: VERSION, endpoint: "http://127.0.0.1:8787" })

        await mockFetchForTesting(
            respondWith(() => new Response("{}", { status: 503 }), captured),
            async () => {
                await client.requestReportAuthorization(request, deviceToken)
                await client.queryReportAuthorization(authorizationCode, deviceToken)
            },
        )

        expect(captured.map((entry) => entry.url)).toEqual([
            "http://127.0.0.1:8787/auth/report-authorizations",
            "http://127.0.0.1:8787/auth/report-authorizations/status",
        ])
        expect(captured[0].init.headers).toMatchObject({
            authorization: `Bearer ${deviceToken}`,
            "x-dline-request-id": REQUEST_ID,
        })
        expect(JSON.parse(String(captured[0].init.body))).toEqual(request)
        // A read-only query is answered with the current state; it has no replay identity.
        expect(captured[1].init.headers).not.toHaveProperty("x-dline-request-id")
        expect(captured[1].init.headers).toMatchObject({ authorization: `Bearer ${deviceToken}` })
        expect(JSON.parse(String(captured[1].init.body))).toEqual({ authorization_code: authorizationCode })
    })

    it("reports an edge page that is not JSON so the classifier stops every profile", async () => {
        const blockPage = () => new Response("<html>Access denied</html>", { status: 403 })

        const response = await mockFetchForTesting(respondWith(blockPage), () =>
            new DlineOtelHttpClient({ clientVersion: VERSION }).sendUsage({
                accessToken: TOKEN,
                requestId: REQUEST_ID,
                body: new Uint8Array(),
            }),
        )

        expect(response.json).toBeUndefined()
        expect(classifyDeliveryResponse(response)).toMatchObject({ kind: "stop", scope: "all" })
    })

    it("does not parse a response larger than the service ever sends", async () => {
        const huge = () => new Response(JSON.stringify({ ok: true, disposition: "accepted", pad: "x".repeat(20_000) }))

        const response = await mockFetchForTesting(respondWith(huge), () =>
            new DlineOtelHttpClient({ clientVersion: VERSION }).sendUsage({
                accessToken: TOKEN,
                requestId: REQUEST_ID,
                body: new Uint8Array(),
            }),
        )

        expect(response.json).toBeUndefined()
        expect(classifyDeliveryResponse(response)).toEqual({ kind: "replay" })
    })

    it("turns a stalled request into a timeout and a caller abort into an abort", async () => {
        const client = new DlineOtelHttpClient({ clientVersion: VERSION, timeoutMs: 20 })
        const caller = new AbortController()

        const timedOut = await mockFetchForTesting(stalled, () =>
            failure(client.sendUsage({ accessToken: TOKEN, requestId: REQUEST_ID, body: new Uint8Array() })),
        )
        const aborted = await mockFetchForTesting(stalled, () => {
            const pending = failure(
                new DlineOtelHttpClient({ clientVersion: VERSION, timeoutMs: 60_000 }).sendUsage(
                    { accessToken: TOKEN, requestId: REQUEST_ID, body: new Uint8Array() },
                    caller.signal,
                ),
            )
            caller.abort()
            return pending
        })

        expect(timedOut.failure).toBe("timeout")
        expect(aborted.failure).toBe("aborted")
    })

    it("reports a network failure without the token, URL or cause text", async () => {
        const broken: typeof globalThis.fetch = async () => {
            throw new TypeError(`connect ECONNREFUSED https://otel.dline.cc Bearer ${TOKEN}`)
        }

        const error = await mockFetchForTesting(broken, () =>
            failure(
                new DlineOtelHttpClient({ clientVersion: VERSION }).sendUsage({
                    accessToken: TOKEN,
                    requestId: REQUEST_ID,
                    body: new Uint8Array(),
                }),
            ),
        )

        expect(error.failure).toBe("network")
        expect(error.message).not.toContain(TOKEN)
        expect(error.message).not.toContain("otel.dline.cc")
        expect(error.cause).toBeUndefined()
    })

    it("only accepts an HTTPS origin, or plain HTTP to loopback", () => {
        expect(() => new DlineOtelHttpClient({ clientVersion: VERSION, endpoint: "http://otel.dline.cc" })).toThrow()
        expect(() => new DlineOtelHttpClient({ clientVersion: VERSION, endpoint: "https://user:pw@otel.dline.cc" })).toThrow()
        expect(() => new DlineOtelHttpClient({ clientVersion: VERSION, endpoint: "http://localhost:8787" })).not.toThrow()
    })

    it("honours an environment override only when it names a loopback origin", () => {
        expect(loopbackEndpointOverride("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787")
        expect(loopbackEndpointOverride("https://localhost:8443")).toBe("https://localhost:8443")
        // A remote HTTPS host is a valid client endpoint but must not replace the service from the environment.
        expect(loopbackEndpointOverride("https://otel.example.test")).toBeUndefined()
        expect(loopbackEndpointOverride("http://127.0.0.1:8787/?redirect=x")).toBeUndefined()
        expect(loopbackEndpointOverride("not a url")).toBeUndefined()
        expect(loopbackEndpointOverride("")).toBeUndefined()
        expect(loopbackEndpointOverride(undefined)).toBeUndefined()
    })
})
