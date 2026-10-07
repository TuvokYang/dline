import { describe, expect, it } from "vitest"
import { isGrpcRecorderRequested } from "@/core/controller/grpc-recorder/grpc-recorder.builder"

describe("isGrpcRecorderRequested", () => {
	it("stays off without the explicit recorder flag", () => {
		expect(isGrpcRecorderRequested({ DLINE_ENVIRONMENT: "local", E2E_TEST: "true" })).toBe(false)
	})

	it("turns on for a local source build", () => {
		expect(isGrpcRecorderRequested({ GRPC_RECORDER_ENABLED: "true", DLINE_ENVIRONMENT: "local" })).toBe(true)
	})

	it("turns on for an E2E run of a packaged production VSIX", () => {
		expect(
			isGrpcRecorderRequested({ GRPC_RECORDER_ENABLED: "true", DLINE_ENVIRONMENT: "production", E2E_TEST: "true" }),
		).toBe(true)
	})

	it("stays off for a production run that is not an E2E run", () => {
		expect(isGrpcRecorderRequested({ GRPC_RECORDER_ENABLED: "true", DLINE_ENVIRONMENT: "production" })).toBe(false)
	})
})
