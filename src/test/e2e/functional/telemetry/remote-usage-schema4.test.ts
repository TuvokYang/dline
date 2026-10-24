import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { expectComposerText } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"

interface CapturedUsage {
    readonly headers: Readonly<Record<string, string | string[] | undefined>>
    readonly body: Record<string, unknown>
}

class UsageCollector {
    readonly grants: Record<string, unknown>[] = []
    readonly usage: CapturedUsage[] = []
    private server: Server | undefined
    origin = ""

    async start(): Promise<void> {
        this.server = createServer((request, response) => {
            const body: Buffer[] = []
            request.on("data", (chunk) => body.push(Buffer.from(chunk)))
            request.on("end", () => {
                const parsed = JSON.parse(Buffer.concat(body).toString("utf8")) as Record<string, unknown>
                if (request.url === "/auth/device/grant") {
                    this.grants.push(parsed)
                    response.writeHead(200, { "content-type": "application/json" })
                    response.end(
                        JSON.stringify({
                            ok: true,
                            request_id: parsed["request_id"],
                            access_token: "A".repeat(43),
                            device_id: "dev_e2e_usage_schema4",
                            profile: "usage",
                            scopes: ["usage"],
                            expires_at: Date.now() + 60 * 60_000,
                            usage_contract: {
                                schema_version: 4,
                                contract_version: 4,
                                max_body_bytes: 65_536,
                                max_buckets: 8,
                                max_facts: 32,
                                max_tool_rows: 384,
                                max_write_rows: 486,
                                event_window_ms: 600_000,
                                default_interval_ms: 1_000,
                                new_batch_jitter_max_ms: 0,
                            },
                        }),
                    )
                    return
                }
                if (request.url === "/usage") {
                    this.usage.push({ headers: request.headers, body: parsed })
                    const requestId = request.headers["x-dline-request-id"]
                    response.writeHead(200, { "content-type": "application/json" })
                    response.end(
                        JSON.stringify({
                            ok: true,
                            request_id: requestId,
                            retryable: false,
                            stream: "usage",
                            disposition: "accepted",
                            duplicate: false,
                            batch_id: requestId,
                            persisted_at: Date.now(),
                            next_eligible_at: Date.now() + 1_000,
                        }),
                    )
                    return
                }
                response.writeHead(404, { "content-type": "application/json" })
                response.end(JSON.stringify({ error: "not_found" }))
            })
        })
        await new Promise<void>((resolve, reject) => {
            this.server!.once("error", reject)
            this.server!.listen(0, "127.0.0.1", resolve)
        })
        const address = this.server.address() as AddressInfo
        this.origin = `http://127.0.0.1:${address.port}`
    }

    async close(): Promise<void> {
        const server = this.server
        if (!server) return
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
}

e2e(
    "packaged dev VSIX sends one real Provider attempt as schema 4 Usage",
    async ({ helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(300_000)
        const collector = new UsageCollector()
        await collector.start()
        server.enqueueOpenAiResponses({
            type: "tool",
            id: "call_usage_schema4_complete",
            name: "attempt_completion",
            arguments: { result: "USAGE_SCHEMA4_E2E_COMPLETE" },
            delayMs: 61_000,
            usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
        })

        const app = await openVSCode(workspaceDir, { DLINE_OTEL_ENDPOINT: collector.origin })
        try {
            const page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await E2ETestHelper.dismissWhatsNewModal(sidebar)
            await helper.signin(sidebar)

            const input = sidebar.getByTestId("chat-input")
            await input.fill("Produce one measured Provider attempt for the schema 4 Usage smoke.")
            await input.press("Enter")
            await expectComposerText(input, "")
            await expect(sidebar.getByText("USAGE_SCHEMA4_E2E_COMPLETE", { exact: false }).last()).toBeVisible({
                timeout: 120_000,
            })

            await expect.poll(() => collector.grants.length, { timeout: 120_000 }).toBeGreaterThan(0)
            const schema4Deliveries = () =>
                collector.usage.filter((entry) => entry.headers["x-dline-contract"] === "4" && entry.body["schema_version"] === 4)
            await expect.poll(() => schema4Deliveries().length, { timeout: 150_000 }).toBe(1)
            const delivery = schema4Deliveries()[0]
            expect(delivery.headers["x-dline-contract"]).toBe("4")
            expect(delivery.headers.authorization).toBe(`Bearer ${"A".repeat(43)}`)
            expect(delivery.body["schema_version"]).toBe(4)
            const buckets = delivery.body["buckets"] as Array<Record<string, unknown>>
            expect(buckets).toHaveLength(1)
            const facts = buckets[0]["facts"] as Array<Record<string, unknown>>
            expect(facts).toHaveLength(1)
            expect(facts[0]).toMatchObject({
                role: "task",
                provider: "openai",
                requests: { completed: 1, failed: 0, cancelled: 0, aborted: 0 },
                tokens: { input: 120, output: 30, cache_read: 0, cache_write: 0 },
                token_coverage: { reported: 1, unreported: 0 },
                duration_ms: { count: 1 },
            })
            expect(String(facts[0]["model_id"])).toMatch(/^(catalog:|state:(private|unknown)$)/u)
            expect(["number", "string"]).toContain(typeof facts[0]["thinking"])
            expect((facts[0]["duration_ms"] as Record<string, number>)["sum"]).toBeGreaterThanOrEqual(60_000)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
            await collector.close()
        }
    },
)
