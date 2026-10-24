import { AsyncLocalStorage } from "node:async_hooks"

export type ProviderAttemptTerminalStatus = "completed" | "failed" | "cancelled" | "aborted"
export type ProviderAttemptThinking = string | number
export type ProviderTelemetryRole = "task" | "subagent" | "compaction" | "reviewer" | "other"

/** Map a resolved subagent identity to a bounded role; never expose the free-form name as telemetry. */
export function providerTelemetryRoleForSubagent(name: string): "subagent" | "reviewer" {
    const normalized = name.trim().toLowerCase()
    return /(?:^|[._-])reviewer(?:$|[._-])/.test(normalized) ? "reviewer" : "subagent"
}

/** Identity known only after the Provider-specific encoder has formed the real wire request. */
export interface ProviderAttemptIdentity {
    readonly provider: string
    readonly modelId: string
    readonly thinking: ProviderAttemptThinking
}

export interface ProviderAttemptAdapterIdentity {
    readonly provider: string
}

export interface ProviderAttemptObserver<THandle = unknown> {
    beginAttempt(identity?: ProviderAttemptIdentity): THandle | Promise<THandle>
    finishAttempt(handle: THandle, status: ProviderAttemptTerminalStatus): void | Promise<void>
}

export interface ProviderAttemptObservationOptions {
    signal?: AbortSignal
    classifyError?: (error: unknown) => ProviderAttemptTerminalStatus | undefined
}

const providerAttemptContext = new AsyncLocalStorage<ProviderAttemptObserver>()
const providerAttemptIdentityContext = new AsyncLocalStorage<ProviderAttemptIdentity>()
const providerAttemptAdapterContext = new AsyncLocalStorage<ProviderAttemptAdapterIdentity>()

/** Bind the effective Provider/model/thinking values around the actual SDK or fetch send. */
export function withProviderAttemptIdentity<T>(identity: ProviderAttemptIdentity, operation: () => T): T {
    return providerAttemptIdentityContext.run(identity, operation)
}

/** Preserve one logical Provider request scope across lazy AsyncIterator calls. */
export function bindProviderAttemptScope<T>(
    iterable: AsyncIterable<T>,
    observer: ProviderAttemptObserver,
    adapter?: ProviderAttemptAdapterIdentity,
): AsyncIterable<T> {
    const run = <R>(operation: () => R): R =>
        adapter
            ? providerAttemptAdapterContext.run(adapter, () => providerAttemptContext.run(observer, operation))
            : providerAttemptContext.run(observer, operation)
    return {
        [Symbol.asyncIterator](): AsyncIterator<T> {
            const iterator = iterable[Symbol.asyncIterator]()
            return {
                next: (value?: unknown) => run(() => iterator.next(value as never)),
                return: iterator.return
                    ? (value?: unknown) => run(() => iterator.return?.(value as never) as Promise<IteratorResult<T>>)
                    : undefined,
                throw: iterator.throw
                    ? (error?: unknown) => run(() => iterator.throw?.(error) as Promise<IteratorResult<T>>)
                    : undefined,
            }
        },
    }
}

/** Build identity from a Provider SDK's final encoded request object; incomplete requests stay unidentifiable. */
export function providerAttemptIdentityFromEncodedRequest(provider: string, body: unknown): ProviderAttemptIdentity | undefined {
    if (!provider || !isRecord(body) || typeof body.model !== "string" || body.model.length === 0) return undefined
    const thinking = encodedThinking(body)
    return thinking === undefined ? undefined : { provider, modelId: body.model, thinking }
}

/** Read model and thinking from the final JSON body handed to fetch; unsupported bodies stay unidentifiable. */
export function providerAttemptIdentityFromFetch(init?: RequestInit): ProviderAttemptIdentity | undefined {
    const adapter = providerAttemptAdapterContext.getStore()
    if (!adapter || !init?.body) return undefined
    const text =
        typeof init.body === "string"
            ? init.body
            : ArrayBuffer.isView(init.body)
              ? new TextDecoder().decode(init.body)
              : undefined
    if (!text) return undefined
    let body: unknown
    try {
        body = JSON.parse(text)
    } catch {
        return undefined
    }
    return providerAttemptIdentityFromEncodedRequest(adapter.provider, body)
}

/** Observe one non-streaming SDK send until its promise settles. */
export async function observeProviderCall<T>(
    send: () => T | PromiseLike<T>,
    options: ProviderAttemptObservationOptions = {},
): Promise<T> {
    const observer = providerAttemptContext.getStore()
    if (!observer) return send()
    const handle = await observer.beginAttempt(providerAttemptIdentityContext.getStore())
    try {
        const result = await send()
        await observer.finishAttempt(handle, options.signal?.aborted ? "aborted" : "completed")
        return result
    } catch (error) {
        await observer.finishAttempt(handle, classifyError(error, options))
        throw error
    }
}

/** Observe one SDK send whose response exposes the actual streamed body separately. */
export async function observeProviderStreamResponse<TResponse, TChunk>(
    send: () => TResponse | PromiseLike<TResponse>,
    selectStream: (response: TResponse) => AsyncIterable<TChunk> | undefined,
    options: ProviderAttemptObservationOptions = {},
): Promise<{ response: TResponse; stream: AsyncIterable<TChunk> | undefined }> {
    const observer = providerAttemptContext.getStore()
    if (!observer) {
        const response = await send()
        return { response, stream: selectStream(response) }
    }
    const handle = await observer.beginAttempt(providerAttemptIdentityContext.getStore())
    try {
        const response = await send()
        const stream = selectStream(response)
        if (!stream) {
            await observer.finishAttempt(handle, options.signal?.aborted ? "aborted" : "completed")
            return { response, stream: undefined }
        }
        return { response, stream: wrapProviderStream(stream, observer, handle, options) }
    } catch (error) {
        await observer.finishAttempt(handle, classifyError(error, options))
        throw error
    }
}

/** Observe one SDK send until its returned AsyncIterable reaches a terminal state. */
export async function observeProviderStream<T>(
    send: () => AsyncIterable<T> | PromiseLike<AsyncIterable<T>>,
    options: ProviderAttemptObservationOptions = {},
): Promise<AsyncIterable<T>> {
    const observer = providerAttemptContext.getStore()
    if (!observer) return send()
    const handle = await observer.beginAttempt(providerAttemptIdentityContext.getStore())
    try {
        const stream = await send()
        return wrapProviderStream(stream, observer, handle, options)
    } catch (error) {
        await observer.finishAttempt(handle, classifyError(error, options))
        throw error
    }
}

/** Observe one fetch-style send until its response body reaches a terminal state. */
export async function observeProviderResponse(
    send: () => Promise<Response>,
    options: ProviderAttemptObservationOptions = {},
): Promise<Response> {
    const observer = providerAttemptContext.getStore()
    if (!observer) return send()
    const handle = await observer.beginAttempt(providerAttemptIdentityContext.getStore())
    try {
        const response = await send()
        if (!response.body) {
            await observer.finishAttempt(handle, response.ok ? "completed" : "failed")
            return response
        }
        return wrapProviderResponse(response, observer, handle, options)
    } catch (error) {
        await observer.finishAttempt(handle, classifyError(error, options))
        throw error
    }
}

function wrapProviderStream<T>(
    iterable: AsyncIterable<T>,
    observer: ProviderAttemptObserver,
    handle: unknown,
    options: ProviderAttemptObservationOptions,
): AsyncIterable<T> {
    return {
        [Symbol.asyncIterator](): AsyncIterator<T> {
            const iterator = iterable[Symbol.asyncIterator]()
            let settled = false
            const settle = async (status: ProviderAttemptTerminalStatus): Promise<void> => {
                if (settled) return
                settled = true
                await observer.finishAttempt(handle, status)
            }
            return {
                async next(value?: unknown): Promise<IteratorResult<T>> {
                    try {
                        const result = await iterator.next(value as never)
                        if (result.done) await settle(options.signal?.aborted ? "aborted" : "completed")
                        return result
                    } catch (error) {
                        await settle(classifyError(error, options))
                        throw error
                    }
                },
                async return(value?: unknown): Promise<IteratorResult<T>> {
                    try {
                        return iterator.return ? await iterator.return(value as never) : { done: true, value: value as T }
                    } finally {
                        await settle(options.signal?.aborted ? "aborted" : "cancelled")
                    }
                },
                async throw(error?: unknown): Promise<IteratorResult<T>> {
                    try {
                        if (iterator.throw) return await iterator.throw(error)
                        throw error
                    } finally {
                        await settle(classifyError(error, options))
                    }
                },
            }
        },
    }
}

function wrapProviderResponse(
    response: Response,
    observer: ProviderAttemptObserver,
    handle: unknown,
    options: ProviderAttemptObservationOptions,
): Response {
    const reader = response.body?.getReader()
    if (!reader) return response
    let settled = false
    let cancellationStatus: ProviderAttemptTerminalStatus | undefined
    const protocolTerminal = createSseDoneDetector(response.headers.get("content-type"))
    const settle = async (status: ProviderAttemptTerminalStatus): Promise<void> => {
        if (settled) return
        settled = true
        await observer.finishAttempt(handle, status)
    }
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const result = await reader.read()
                if (result.done) {
                    await settle(
                        cancellationStatus ?? (options.signal?.aborted ? "aborted" : response.ok ? "completed" : "failed"),
                    )
                    controller.close()
                    return
                }
                protocolTerminal.observe(result.value)
                controller.enqueue(result.value)
            } catch (error) {
                await settle(cancellationStatus ?? classifyError(error, options))
                controller.error(error)
            }
        },
        async cancel(reason) {
            cancellationStatus = classifyCancellation(reason, options.signal, protocolTerminal.completed())
            try {
                await reader.cancel(reason)
            } finally {
                await settle(cancellationStatus)
            }
        },
    })
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    for (const property of ["url", "redirected", "type"] as const) {
        Object.defineProperty(wrapped, property, { configurable: true, value: response[property] })
    }
    return wrapped
}

function createSseDoneDetector(contentType: string | null): { observe(chunk: Uint8Array): void; completed(): boolean } {
    if (!contentType?.toLowerCase().includes("text/event-stream")) {
        return { observe: () => undefined, completed: () => false }
    }
    const decoder = new TextDecoder()
    let buffer = ""
    let done = false
    return {
        observe(chunk) {
            if (done) return
            buffer += decoder.decode(chunk, { stream: true })
            buffer = buffer.replaceAll("\r\n", "\n")
            let boundary = buffer.indexOf("\n\n")
            while (boundary >= 0) {
                const event = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                const data = event
                    .split("\n")
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart())
                    .join("\n")
                if (data === "[DONE]") {
                    done = true
                    return
                }
                boundary = buffer.indexOf("\n\n")
            }
        },
        completed: () => done,
    }
}

function encodedThinking(body: Record<string, unknown>): ProviderAttemptThinking | undefined {
    if (typeof body.reasoning_effort === "string") return `level:${body.reasoning_effort}`
    if (typeof body.thinking === "number" || typeof body.thinking === "string") return body.thinking
    const config = isRecord(body.config) ? body.config : undefined
    const nestedThinking = config && isRecord(config.thinkingConfig) ? config.thinkingConfig : undefined
    for (const value of [body.thinking, body.reasoning, nestedThinking]) {
        if (!isRecord(value)) continue
        for (const key of ["budget_tokens", "max_tokens", "thinkingBudget"]) {
            if (typeof value[key] === "number") return value[key] as number
        }
        for (const key of ["effort", "thinkingLevel"]) {
            if (typeof value[key] === "string") return `level:${value[key]}`
        }
        if (typeof value.type === "string") return `state:${value.type}`
        if (typeof value.includeThoughts === "boolean") return value.includeThoughts ? "state:enabled" : "state:disabled"
    }
    return "state:disabled"
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function classifyCancellation(reason: unknown, signal?: AbortSignal, protocolCompleted = false): ProviderAttemptTerminalStatus {
    if (signal?.aborted) return "aborted"
    if (reason instanceof DOMException && reason.name === "AbortError") return "aborted"
    if (reason instanceof Error && reason.name === "AbortError") return "aborted"
    if (reason instanceof Error) return "failed"
    return protocolCompleted ? "completed" : "cancelled"
}

function classifyError(error: unknown, options: ProviderAttemptObservationOptions): ProviderAttemptTerminalStatus {
    const classified = options.classifyError?.(error)
    if (classified) return classified
    if (options.signal?.aborted) return "aborted"
    if (error instanceof DOMException && error.name === "AbortError") return "aborted"
    if (error instanceof Error && error.name === "AbortError") return "aborted"
    return "failed"
}
