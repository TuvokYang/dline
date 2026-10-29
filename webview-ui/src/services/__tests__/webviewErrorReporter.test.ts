import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const reportWebviewError = vi.hoisted(() => vi.fn(() => Promise.resolve()))

vi.mock("@/services/grpc-client", () => ({
    StateServiceClient: { serviceName: "dline.StateService", reportWebviewError },
}))

import { PLATFORM_CONFIG } from "../../config/platform.config"
import { ProtoBusClient, UNARY_RPC_TIMEOUT_MS } from "../grpc-client-base"
import { installGlobalWebviewErrorReporting } from "../webviewErrorReporter"

const RESIZE_OBSERVER_LOOP_NOTICE = "ResizeObserver loop completed with undelivered notifications."

function dispatchWindowError(init: ErrorEventInit): void {
    window.dispatchEvent(new ErrorEvent("error", init))
}

describe("global Webview error reporting", () => {
    beforeAll(() => installGlobalWebviewErrorReporting())
    beforeEach(() => reportWebviewError.mockClear())

    it("does not report the browser's ResizeObserver loop notice as an uncaught error", () => {
        dispatchWindowError({ message: RESIZE_OBSERVER_LOOP_NOTICE })
        dispatchWindowError({ message: "ResizeObserver loop limit exceeded" })

        expect(reportWebviewError).not.toHaveBeenCalled()
    })

    it("still reports a thrown error whose text matches the notice", () => {
        const thrown = new Error(RESIZE_OBSERVER_LOOP_NOTICE)
        dispatchWindowError({ message: thrown.message, error: thrown })

        expect(reportWebviewError).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "uncaught", name: "Error", message: RESIZE_OBSERVER_LOOP_NOTICE }),
        )
    })

    it("reports any other uncaught error event", () => {
        dispatchWindowError({ message: "Script error." })

        expect(reportWebviewError).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "uncaught", name: "NonError", message: "Script error." }),
        )
    })
})

class SlowServiceClient extends ProtoBusClient {
    static override serviceName = "dline.SlowService"
}

class StalledStateServiceClient extends ProtoBusClient {
    static override serviceName = "dline.StateService"
}

const identity = (value: any) => value

describe("unary RPC timeout reporting", () => {
    beforeAll(() => installGlobalWebviewErrorReporting())
    beforeEach(() => {
        reportWebviewError.mockClear()
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it("names the RPC the extension left unanswered once the guard fires", async () => {
        const settled = SlowServiceClient.makeUnaryRequest("fetchMessage", {}, identity, identity).catch((error) => error)

        vi.advanceTimersByTime(UNARY_RPC_TIMEOUT_MS - 1)
        expect(reportWebviewError).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)

        expect(await settled).toBeInstanceOf(Error)
        expect(reportWebviewError).toHaveBeenCalledTimes(1)
        expect(reportWebviewError).toHaveBeenCalledWith({
            kind: "rpc_timeout",
            name: "UnaryRpcTimeout",
            message: "dline.SlowService.fetchMessage",
            stack: undefined,
            componentStack: undefined,
        })
    })

    it("does not report an RPC that was answered before the guard", async () => {
        const postMessage = vi.spyOn(PLATFORM_CONFIG, "postMessage").mockImplementation(() => {})
        const answered = SlowServiceClient.makeUnaryRequest("getLatestState", {}, identity, identity)
        const requestId = postMessage.mock.calls[0]?.[0]?.grpc_request?.request_id
        window.dispatchEvent(
            new MessageEvent("message", {
                data: { type: "grpc_response", grpc_response: { request_id: requestId, message: { ok: true } } },
            }),
        )

        await expect(answered).resolves.toEqual({ ok: true })
        vi.advanceTimersByTime(UNARY_RPC_TIMEOUT_MS)

        expect(reportWebviewError).not.toHaveBeenCalled()
    })

    it("does not report the stalled error report through the same transport", async () => {
        const settled = StalledStateServiceClient.makeUnaryRequest("reportWebviewError", {}, identity, identity).catch(
            (error) => error,
        )

        vi.advanceTimersByTime(UNARY_RPC_TIMEOUT_MS)

        expect(await settled).toBeInstanceOf(Error)
        expect(reportWebviewError).not.toHaveBeenCalled()
    })
})
