import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { describe, expect, it } from "vitest"
import { runtimeContentPolicyLimits, TELEMETRY_MASK_VALUE } from "../../content-policy"
import { ContentPolicyProcessor } from "../content-policy-processor"

/**
 * The privacy contract must survive the move to the official SDK. Moving export
 * to a standard exporter is only safe if redaction still happens before a
 * record can leave the process, so these tests drive the processor through a
 * real logger pipeline rather than calling it directly.
 */

function emitWith(attributes: Record<string, unknown>): InMemoryLogRecordExporter {
    const exporter = new InMemoryLogRecordExporter()
    const provider = new LoggerProvider()
    // Registration order mirrors production: redact, then export.
    provider.addLogRecordProcessor(new ContentPolicyProcessor())
    provider.addLogRecordProcessor(new SimpleLogRecordProcessor(exporter))

    provider.getLogger("test").emit({
        body: "task.phase",
        attributes: attributes as never,
    })
    return exporter
}

describe("ContentPolicyProcessor", () => {
    it("preserves sensitive field names while masking user and tool content", () => {
        const exporter = emitWith({
            command: "rm -rf /",
            prompt: "my secret prompt",
            stdout: "sensitive output",
            durationMs: 12,
        })

        const { attributes } = exporter.getFinishedLogRecords()[0]
        expect(attributes.command).toBe(TELEMETRY_MASK_VALUE)
        expect(attributes.prompt).toBe(TELEMETRY_MASK_VALUE)
        expect(attributes.stdout).toBe(TELEMETRY_MASK_VALUE)
        expect(attributes.durationMs).toBe(12)
    })

    it("flattens and retains safe operational metadata", () => {
        const exporter = emitWith({
            extension_version: "0.9.2-test",
            vscode_version: "1.134.0",
            provider: "openai-codex",
            modelId: "gpt-5.3-codex",
            apiFormat: "openai-responses",
            tokens: { input: 1200, output: 340 },
            model_list: ["gpt-5.3-codex", "gpt-5.2-codex"],
            capabilities: ["tools", "images"],
            snapshot: { phase: "flush", status: "complete", count: 3, durationMs: 42 },
        })

        const { attributes } = exporter.getFinishedLogRecords()[0]
        expect(attributes).toMatchObject({
            extension_version: "0.9.2-test",
            vscode_version: "1.134.0",
            provider: "openai-codex",
            modelId: "gpt-5.3-codex",
            apiFormat: "openai-responses",
            "tokens.input": 1200,
            "tokens.output": 340,
            "model_list.0": "gpt-5.3-codex",
            "model_list.1": "gpt-5.2-codex",
            "capabilities.0": "tools",
            "capabilities.1": "images",
            "snapshot.phase": "flush",
            "snapshot.status": "complete",
            "snapshot.count": 3,
            "snapshot.durationMs": 42,
        })
    })

    it("masks credentials and identities without removing their fields", () => {
        const exporter = emitWith({
            api_key: "sk-super-secret-value",
            oauth_token: "oauth-secret",
            user_id: "user-123",
            organization_name: "Private Org",
            message: "private failure prose",
        })

        const { attributes } = exporter.getFinishedLogRecords()[0]
        expect(attributes).toMatchObject({
            api_key: TELEMETRY_MASK_VALUE,
            oauth_token: TELEMETRY_MASK_VALUE,
            user_id: TELEMETRY_MASK_VALUE,
            organization_name: TELEMETRY_MASK_VALUE,
            message: TELEMETRY_MASK_VALUE,
        })
    })

    it("masks rather than truncates an over-long value", () => {
        // A truncated content value can still leak content.
        const exporter = emitWith({ note: "x".repeat(runtimeContentPolicyLimits.MAX_ATTRIBUTE_LENGTH + 1) })

        expect(exporter.getFinishedLogRecords()[0].attributes.note).toBe(TELEMETRY_MASK_VALUE)
    })

    it("keeps a value that sits exactly on the length limit", () => {
        const value = "x".repeat(runtimeContentPolicyLimits.MAX_ATTRIBUTE_LENGTH)
        const exporter = emitWith({ note: value })

        expect(exporter.getFinishedLogRecords()[0].attributes.note).toBe(value)
    })

    it("caps how many attributes one record may carry", () => {
        const attributes: Record<string, unknown> = {}
        for (let index = 0; index < runtimeContentPolicyLimits.MAX_ATTRIBUTE_COUNT + 10; index++) {
            attributes[`key${index}`] = index
        }

        const record = emitWith(attributes).getFinishedLogRecords()[0]
        expect(Object.keys(record.attributes)).toHaveLength(runtimeContentPolicyLimits.MAX_ATTRIBUTE_COUNT)
    })

    it("masks nested objects that could smuggle a request body through", () => {
        const exporter = emitWith({ payload: { nested: "value" }, component: "terminal" })

        const { attributes } = exporter.getFinishedLogRecords()[0]
        expect(attributes.payload).toBe(TELEMETRY_MASK_VALUE)
        expect(attributes.component).toBe("terminal")
    })

    it("leaves a record with no attributes untouched", () => {
        const exporter = emitWith({})

        expect(exporter.getFinishedLogRecords()[0].attributes).toEqual({})
    })
})
