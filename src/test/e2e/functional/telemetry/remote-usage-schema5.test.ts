import { expectComposerText } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"
import {
    isOtelServiceMockAvailable,
    otelServiceMockEndpoint,
    readOtelServiceMockState,
    resetOtelServiceMock,
} from "../../../../services/telemetry/remote/__tests__/support/OtelServiceMock"

e2e(
    "VS Code runtime sends one real Provider attempt as schema 5 Usage through the dline-web mock",
    async ({ helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(300_000)
        const endpoint = otelServiceMockEndpoint()
        e2e.skip(!(await isOtelServiceMockAvailable(endpoint)), `dline-web telemetry mock is not listening at ${endpoint}`)
        await resetOtelServiceMock(endpoint)
        server.enqueueOpenAiResponses({
            type: "tool",
            id: "call_usage_schema5_complete",
            name: "attempt_completion",
            arguments: { result: "USAGE_SCHEMA5_E2E_COMPLETE" },
            delayMs: 61_000,
            usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
        })

        const app = await openVSCode(workspaceDir, { DLINE_OTEL_ENDPOINT: endpoint })
        try {
            const page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await E2ETestHelper.dismissWhatsNewModal(sidebar)
            await helper.signin(sidebar)

            const input = sidebar.getByTestId("chat-input")
            await input.fill("Produce one measured Provider attempt for the schema 5 Usage smoke.")
            await input.press("Enter")
            await expectComposerText(input, "")
            await expect(sidebar.getByText("USAGE_SCHEMA5_E2E_COMPLETE", { exact: false }).last()).toBeVisible({
                timeout: 120_000,
            })

            const schema5Deliveries = async () => {
                const state = await readOtelServiceMockState(endpoint)
                return state.accepted.filter(
                    (entry) =>
                        entry.path === "usage" &&
                        typeof entry.body === "object" &&
                        entry.body !== null &&
                        (entry.body as Record<string, unknown>).schema_version === 5,
                )
            }
            await expect.poll(async () => (await schema5Deliveries()).length, { timeout: 150_000 }).toBe(1)
            const delivery = (await schema5Deliveries())[0]
            if (!delivery) throw new Error("Schema 5 Usage delivery was not recorded")
            const body = delivery.body as Record<string, unknown>
            expect(body.schema_version).toBe(5)
            const buckets = body.buckets as Array<Record<string, unknown>>
            expect(buckets).toHaveLength(1)
            const bucket = buckets[0]
            if (!bucket) throw new Error("Schema 5 Usage bucket was not recorded")
            const facts = bucket.facts as Array<Record<string, unknown>>
            expect(facts).toHaveLength(1)
            const fact = facts[0]
            if (!fact) throw new Error("Schema 5 Usage fact was not recorded")
            expect(fact).toMatchObject({
                role: "task",
                provider: "openai",
                requests: { completed: 1, failed: 0, cancelled: 0, aborted: 0 },
                tokens: { input: 120, output: 30, cache_read: 0, cache_write: 0 },
                token_coverage: { reported: 1, unreported: 0 },
                duration_ms: { count: 1 },
            })
            expect(String(fact.model_id)).toMatch(/^(catalog:|custom:|state:(private|unknown)$)/u)
            expect(["number", "string"]).toContain(typeof fact.thinking)
            expect((fact.duration_ms as Record<string, number>).sum).toBeGreaterThanOrEqual(60_000)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)
