import { describe, it } from "vitest"
import "should"
import { ClineError, ClineErrorType } from "../ClineError"

describe("ClineError", () => {
    it("preserves the request ID exposed by provider SDK errors", () => {
        const err = new ClineError({ message: "Provider failed", requestID: "req_sdk_123" }, "model-1", "openai")

        JSON.parse(err.serialize()).request_id.should.equal("req_sdk_123")
    })

    it("preserves an OpenAI 400 invalid request without mapping it to 502", () => {
        const details = {
            code: null,
            message: "No tool call found for function call output with call_id fc_test.",
            param: "input",
            type: "invalid_request_error",
        }
        const err = new ClineError({ message: `400 ${details.message}`, status: 400, error: details }, "gpt-5.6-sol", "openai")
        const serialized = JSON.parse(err.serialize())

        serialized.status.should.equal(400)
        serialized.message.should.equal(`400 ${details.message}`)
        serialized.details.should.deepEqual(details)
    })

    it("preserves an upstream 502 with an empty body as a distinct status", () => {
        const err = new ClineError({ message: "502 status code (no body)", status: 502 }, "gpt-5.6-sol", "openai")
        const serialized = JSON.parse(err.serialize())

        serialized.status.should.equal(502)
        serialized.message.should.equal("502 status code (no body)")
    })

    describe("getErrorType", () => {
        it("should return QuotaExceeded when code is INFERENCE_CAP_ERROR", () => {
            const err = new ClineError({ message: "Inference cap reached", code: "INFERENCE_CAP_ERROR" })
            ClineError.getErrorType(err)?.should.equal(ClineErrorType.QuotaExceeded)
        })
    })
})
