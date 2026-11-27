import type OpenAI from "openai"
import { MessageEvent as UndiciMessageEvent, WebSocket as UndiciWebSocket } from "undici"
import { ApiHandler } from "../ApiHandler"
import { OutputLimitExceededError } from "../stream/OutputLimitExceededError"

export const OPENAI_RESPONSES_WEBSOCKET_BETA_HEADER = "responses_websockets=2026-02-06"
const DEFAULT_OPENAI_API_BASE_URL = "https://api.openai.com/v1"

export type ResponsesWebsocketError = Error & {
    status?: number
    code?: string
    type?: string
    param?: string
    responseBody?: string
}

/** Derive the OpenAI Responses WebSocket endpoint URL from a configured HTTP/WS base URL. */
export function resolveOpenAIResponsesWebsocketUrl(baseUrl?: string): string {
    const trimmed = baseUrl?.trim()
    const url = new URL(trimmed || DEFAULT_OPENAI_API_BASE_URL)
    if (url.protocol === "https:") {
        url.protocol = "wss:"
    } else if (url.protocol === "http:") {
        url.protocol = "ws:"
    }
    const pathname = url.pathname.replace(/\/+$/, "")
    url.pathname = pathname.endsWith("/responses") ? pathname : `${pathname}/responses`
    return url.toString()
}

/** Open an Undici WebSocket with cancellation cleanup while connecting. */
export async function openOpenAIResponsesWebsocket(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    label: string,
): Promise<UndiciWebSocket> {
    signal.throwIfAborted()
    const ws = new UndiciWebSocket(url, { headers })

    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            ws.removeEventListener("open", handleOpen)
            ws.removeEventListener("error", handleError)
            ws.removeEventListener("close", handleClose)
            signal.removeEventListener("abort", handleAbort)
        }
        const handleOpen = () => {
            cleanup()
            resolve()
        }
        const handleError = () => {
            cleanup()
            const error: ResponsesWebsocketError = new Error(`Failed to open ${label} Responses websocket`)
            error.code = "websocket_error"
            reject(error)
        }
        const handleClose = () => {
            cleanup()
            const error: ResponsesWebsocketError = new Error(`${label} Responses websocket closed before opening`)
            error.code = "websocket_closed"
            reject(error)
        }
        const handleAbort = () => {
            cleanup()
            try {
                ws.close()
            } catch {}
            reject(signal.reason)
        }
        ws.addEventListener("open", handleOpen)
        ws.addEventListener("error", handleError)
        ws.addEventListener("close", handleClose)
        signal.addEventListener("abort", handleAbort, { once: true })
    })

    return ws
}

export function shouldRetryOpenAIResponsesWebsocketWithFullContext(
    error: unknown,
    hadPreviousResponseId: boolean,
    errorMessage: string,
): boolean {
    const errorCode =
        typeof error === "object" && error && "code" in error && typeof (error as { code: unknown }).code === "string"
            ? (error as { code: string }).code
            : undefined

    if (
        hadPreviousResponseId &&
        (errorCode === "previous_response_not_found" ||
            /previous_response_not_found|previous response.*not found/i.test(errorMessage))
    ) {
        return true
    }
    return errorCode === "websocket_closed" || errorCode === "websocket_error"
}

function decodeWebsocketMessageData(data: unknown): string {
    if (typeof data === "string") return data
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data))
    if (ArrayBuffer.isView(data)) {
        return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    }
    return String(data)
}

function defaultWebsocketError(rawError: unknown): ResponsesWebsocketError {
    if (rawError instanceof Error) return rawError as ResponsesWebsocketError
    if (typeof rawError === "object" && rawError !== null) {
        const record = rawError as Record<string, unknown>
        const message = typeof record.message === "string" && record.message ? record.message : JSON.stringify(rawError)
        const error = new Error(message) as ResponsesWebsocketError
        Object.assign(error, record)
        error.message = message
        return error
    }
    return new Error(typeof rawError === "string" && rawError ? rawError : String(rawError))
}

/** Send one `response.create` frame over an open Responses WebSocket and yield its stream events. */
export async function streamOpenAIResponsesWebsocketEvents(options: {
    ws: UndiciWebSocket
    providerId: string
    label: string
    params: OpenAI.Responses.ResponseCreateParamsStreaming
    signal: AbortSignal
    toError?: (rawError: unknown) => ResponsesWebsocketError
    redactText?: (raw: string) => string
}): Promise<{ stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>; sentAtMs: number }> {
    const { ws, providerId, label, params, signal } = options
    const toError = options.toError ?? defaultWebsocketError
    const redactText = options.redactText ?? ((raw: string) => raw)

    const eventQueue: OpenAI.Responses.ResponseStreamEvent[] = []
    let resolver: (() => void) | undefined
    let completed = false
    let failure: ResponsesWebsocketError | undefined

    const wake = () => {
        const next = resolver
        resolver = undefined
        next?.()
    }

    const handleMessage = (evt: UndiciMessageEvent) => {
        try {
            const raw = decodeWebsocketMessageData(evt.data)
            const parsed = JSON.parse(raw)
            if (parsed?.type === "error" && parsed?.error) {
                const error = toError(parsed.error)
                error.responseBody = redactText(raw)
                failure = error
                completed = true
                wake()
                return
            }
            if (parsed?.type === "response.failed") {
                const responseError = parsed.response?.error
                const failedError = toError(responseError ?? parsed.response ?? parsed)
                failedError.responseBody = redactText(raw)
                failure = failedError
                completed = true
                wake()
                return
            }
            if (parsed?.type === "response.incomplete") {
                failure =
                    parsed.response?.incomplete_details?.reason === "max_output_tokens"
                        ? new OutputLimitExceededError("openai_responses", "max_output_tokens")
                        : new Error(`${label} Responses websocket request was incomplete`)
                completed = true
                wake()
                return
            }

            eventQueue.push(parsed as OpenAI.Responses.ResponseStreamEvent)
            if (parsed?.type === "response.completed" || parsed?.type === "response.done") completed = true
            wake()
        } catch (error) {
            const parseError: ResponsesWebsocketError = new Error(
                `Failed to parse websocket event: ${error instanceof Error ? error.message : String(error)}`,
            )
            parseError.code = "websocket_parse_error"
            failure = parseError
            completed = true
            wake()
        }
    }

    const handleError = () => {
        const error: ResponsesWebsocketError = new Error(`${label} Responses websocket emitted an error event`)
        error.code = "websocket_error"
        failure = error
        completed = true
        wake()
    }

    const handleClose = () => {
        if (!completed) {
            const error: ResponsesWebsocketError = new Error(`${label} Responses websocket closed during response stream`)
            error.code = "websocket_closed"
            failure = error
            completed = true
            wake()
        }
    }

    const handleAbort = () => {
        failure = Object.assign(new Error(`${label} request aborted`), { name: "AbortError" })
        completed = true
        wake()
    }

    const cleanup = () => {
        ws.removeEventListener("message", handleMessage)
        ws.removeEventListener("error", handleError)
        ws.removeEventListener("close", handleClose)
        signal.removeEventListener("abort", handleAbort)
    }

    ws.addEventListener("message", handleMessage)
    ws.addEventListener("error", handleError)
    ws.addEventListener("close", handleClose)
    signal.addEventListener("abort", handleAbort, { once: true })

    try {
        const identity = ApiHandler.identifyProviderAttempt(providerId, params)
        let sentAtMs = Number.NaN
        const stream = await ApiHandler.observeProviderStream(
            identity,
            () => {
                signal.throwIfAborted()
                const websocketParams = { ...params } as Record<string, unknown>
                delete websocketParams.stream
                const payload = JSON.stringify({ type: "response.create", ...websocketParams })
                sentAtMs = Date.now()
                ws.send(payload)
                return (async function* () {
                    try {
                        while (!completed || eventQueue.length > 0) {
                            if (eventQueue.length === 0) {
                                await new Promise<void>((resolve) => {
                                    resolver = resolve
                                })
                                continue
                            }

                            const event = eventQueue.shift()
                            if (event) yield event
                        }

                        if (failure) throw failure
                    } finally {
                        cleanup()
                    }
                })()
            },
            { signal },
        )
        return { stream, sentAtMs }
    } catch (error) {
        cleanup()
        throw error
    }
}
