import { afterEach, describe, expect, it, vi } from "vitest"
import { Logger } from "@/shared/services/Logger"
import { RuntimeContentPolicy, TELEMETRY_MASK_VALUE } from "../../runtime/content-policy"
import type { RuntimeEventRecorderPort } from "../runtime"
import { ErrorEventRecorder } from "./ErrorEventRecorder"
import { installLoggerTelemetryBridge } from "./LoggerTelemetryBridge"

function harness(developmentMode = false) {
	const record = vi.fn<RuntimeEventRecorderPort["record"]>()
	return { record, recorder: new ErrorEventRecorder({ record }, { developmentMode }) }
}

describe("ErrorEventRecorder", () => {
	afterEach(() => vi.restoreAllMocks())

	it("uses one normalized runtime event contract for exceptions and messages", () => {
		const { record, recorder } = harness()
		const error = new Error("provider failed")

		recorder.exception(error, { modelId: "gpt-test", nested: { secret: true } })
		recorder.message("request failed", "warning", { status: 503 })

		expect(record).toHaveBeenNthCalledWith(1, {
			name: "extension.error",
			level: "error",
			error,
			attributes: {
				exception_message: TELEMETRY_MASK_VALUE,
				modelId: "gpt-test",
				nested: { secret: true },
			},
		})
		expect(record).toHaveBeenNthCalledWith(2, {
			name: "extension.message",
			level: "error",
			attributes: { message: TELEMETRY_MASK_VALUE, message_level: "warning", status: 503 },
		})
	})

	it("keeps production message fields fully masked", () => {
		const { record, recorder } = harness(false)
		const dispose = installLoggerTelemetryBridge(recorder, { developmentMode: false })
		vi.spyOn(Logger as unknown as { output: (message: string) => void }, "output").mockImplementation(() => undefined)

		Logger.warn("request failed apiKey=sk-live-123456", { token: "ghp_1234567890123456" })
		dispose()

		const attributes = record.mock.calls[0]?.[0].attributes
		expect(attributes).toEqual(
			expect.objectContaining({
				message: TELEMETRY_MASK_VALUE,
				logger_message: TELEMETRY_MASK_VALUE,
			}),
		)
		expect(attributes).not.toHaveProperty("diagnostic_message")
		expect(attributes).not.toHaveProperty("diagnostic_logger_message")
		expect(attributes).not.toHaveProperty("diagnostic_logger_args")
	})

	it("retains sanitized logger diagnostics only in development mode", () => {
		const { record, recorder } = harness(true)
		const dispose = installLoggerTelemetryBridge(recorder, { developmentMode: true })
		vi.spyOn(Logger as unknown as { output: (message: string) => void }, "output").mockImplementation(() => undefined)

		Logger.warn("request failed Authorization: Bearer sk-live-123456", {
			status: 401,
			apiKey: "sk-live-abcdef",
			token: "ghp_1234567890123456",
		})
		dispose()

		const attributes = record.mock.calls[0]?.[0].attributes
		expect(attributes).toEqual(
			expect.objectContaining({
				message: TELEMETRY_MASK_VALUE,
				logger_message: TELEMETRY_MASK_VALUE,
				diagnostic_message: "request failed Authorization: Bearer [REDACTED]",
				diagnostic_logger_message: "request failed Authorization: Bearer [REDACTED]",
				diagnostic_logger_args: ['{"status":401,"apiKey":"[REDACTED]","token":"[REDACTED]"}'],
			}),
		)

		const policy = new RuntimeContentPolicy(Buffer.alloc(32), { preserveDevelopmentDiagnostics: true })
		const exported = policy.apply(attributes).attributes
		expect(exported.diagnostic_message).toBe("request failed Authorization: Bearer [REDACTED]")
		expect(exported.diagnostic_logger_message).toBe("request failed Authorization: Bearer [REDACTED]")
		expect(exported["diagnostic_logger_args.0"]).toContain("[REDACTED]")
		expect(JSON.stringify(exported)).not.toContain("sk-live")
		expect(JSON.stringify(exported)).not.toContain("ghp_")
	})

	it("bridges only structured warn/error records and ignores internal diagnostics", () => {
		const { record, recorder } = harness()
		const dispose = installLoggerTelemetryBridge(recorder)
		vi.spyOn(Logger as unknown as { output: (message: string) => void }, "output").mockImplementation(() => undefined)

		Logger.warn("collector unavailable", {
			status: 503,
			provider: "openai-codex",
			modelId: "gpt-5.3-codex",
			snapshot: { status: "failed", count: 2 },
		})
		Logger.error("provider failed", new Error("private failure prose"), {
			provider: "openai-codex",
			apiFormat: "openai-responses",
		})
		Logger.internalError("exporter feedback", new Error("failed again"))
		Logger.info("ordinary output")
		dispose()

		expect(record).toHaveBeenCalledTimes(2)
		expect(record).toHaveBeenNthCalledWith(1, {
			name: "extension.message",
			level: "error",
			attributes: expect.objectContaining({
				message: TELEMETRY_MASK_VALUE,
				message_level: "warning",
				logger_message: TELEMETRY_MASK_VALUE,
				logger_metadata: [
					{
						status: 503,
						provider: "openai-codex",
						modelId: "gpt-5.3-codex",
						snapshot: { status: "failed", count: 2 },
					},
				],
			}),
		})
		expect(record).toHaveBeenNthCalledWith(2, {
			name: "extension.error",
			level: "error",
			error: expect.any(Error),
			attributes: expect.objectContaining({
				exception_message: TELEMETRY_MASK_VALUE,
				logger_message: TELEMETRY_MASK_VALUE,
				logger_metadata: [{ provider: "openai-codex", apiFormat: "openai-responses" }],
			}),
		})
	})
})
