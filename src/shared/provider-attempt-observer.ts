import { AsyncLocalStorage } from "node:async_hooks"
import { projectUsageThinking } from "@/services/telemetry/remote/contracts/thinking"

export type ProviderAttemptTerminalStatus = "completed" | "failed" | "cancelled" | "aborted"
export type ProviderAttemptThinking = string | number
/**
 * Bounded Usage role of a provider attempt, mirrored by the schema 4 `USAGE_ROLES` contract.
 *
 * `reviewer` is reserved in that contract and no current caller emits it; every
 * subagent run reports `subagent` regardless of its configured name.
 */
export type ProviderTelemetryRole = "task" | "subagent" | "compaction" | "reviewer" | "other"

/** Identity known only after the Provider-specific encoder has formed the real wire request. */
export interface ProviderAttemptIdentity {
    readonly provider: string
    /** Final wire model ID; Usage projects it through the contract model identity projector. */
    readonly modelId: string
    readonly thinking: ProviderAttemptThinking
    /** The Profile's custom-model switch at send time; it selects the `custom:` namespace. */
    readonly customModel?: boolean
}

export interface ProviderAttemptAdapterIdentity {
    readonly provider: string
    /** The serving handler's custom-model switch, frozen into every attempt of this scope. */
    readonly customModel?: boolean
}

export interface ProviderAttemptObserver<THandle = unknown> {
    beginAttempt(identity?: ProviderAttemptIdentity): THandle | Promise<THandle>
    /**
     * `failure` is what ended a `failed` send: the thrown error, or the HTTP
     * status of a refused response. It is read for its failure class only and
     * is never stored or forwarded.
     */
    finishAttempt(handle: THandle, status: ProviderAttemptTerminalStatus, failure?: unknown): void | Promise<void>
}

export interface ProviderAttemptObservationOptions {
    signal?: AbortSignal
    classifyError?: (error: unknown) => ProviderAttemptTerminalStatus | undefined
}

/**
 * Abort reason of a user-requested stop. Usage reports it as `cancelled`; every
 * other abort reason is an owner or process abort and is reported as `aborted`.
 */
export const PROVIDER_USER_CANCEL_REASON = "provider_cancel"

const providerAttemptContext = new AsyncLocalStorage<ProviderAttemptObserver>()
/**
 * Marks a send that an enclosing observation already counts. An SDK call observed
 * at the SDK boundary whose transport is the observed provider fetch is one
 * attempt, not two.
 */
const observedSendContext = new AsyncLocalStorage<true>()
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
    return { provider, modelId: body.model, thinking: projectUsageThinking(body) }
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
    const observer = unobservedSendObserver()
    if (!observer) return send()
    const handle = await observer.beginAttempt(currentAttemptIdentity())
    try {
        const result = await observedSendContext.run(true, send)
        await observer.finishAttempt(handle, signalOutcome(options.signal) ?? "completed")
        return result
    } catch (error) {
        await observer.finishAttempt(handle, classifyError(error, options), error)
        throw error
    }
}

/** Observe one SDK send whose response exposes the actual streamed body separately. */
export async function observeProviderStreamResponse<TResponse, TChunk>(
    send: () => TResponse | PromiseLike<TResponse>,
    selectStream: (response: TResponse) => AsyncIterable<TChunk> | undefined,
    options: ProviderAttemptObservationOptions = {},
): Promise<{ response: TResponse; stream: AsyncIterable<TChunk> | undefined }> {
    const observer = unobservedSendObserver()
    if (!observer) {
        const response = await send()
        return { response, stream: selectStream(response) }
    }
    const handle = await observer.beginAttempt(currentAttemptIdentity())
    try {
        const response = await observedSendContext.run(true, send)
        const stream = selectStream(response)
        if (!stream) {
            await observer.finishAttempt(handle, signalOutcome(options.signal) ?? "completed")
            return { response, stream: undefined }
        }
        return { response, stream: wrapProviderStream(stream, observer, handle, options) }
    } catch (error) {
        await observer.finishAttempt(handle, classifyError(error, options), error)
        throw error
    }
}

/** Observe one SDK send until its returned AsyncIterable reaches a terminal state. */
export async function observeProviderStream<T>(
    send: () => AsyncIterable<T> | PromiseLike<AsyncIterable<T>>,
    options: ProviderAttemptObservationOptions = {},
): Promise<AsyncIterable<T>> {
    const observer = unobservedSendObserver()
    if (!observer) return send()
    const handle = await observer.beginAttempt(currentAttemptIdentity())
    try {
        const stream = await observedSendContext.run(true, send)
        return wrapProviderStream(stream, observer, handle, options)
    } catch (error) {
        await observer.finishAttempt(handle, classifyError(error, options), error)
        throw error
    }
}

/** Observe one fetch-style send until its response body reaches a terminal state. */
export async function observeProviderResponse(
    send: () => Promise<Response>,
    options: ProviderAttemptObservationOptions = {},
): Promise<Response> {
    const observer = unobservedSendObserver()
    if (!observer) return send()
    const handle = await observer.beginAttempt(currentAttemptIdentity())
    try {
        const response = await observedSendContext.run(true, send)
        if (!response.body) {
            if (response.ok) await observer.finishAttempt(handle, "completed")
            else await observer.finishAttempt(handle, "failed", refusedResponse(response))
            return response
        }
        return wrapProviderResponse(response, observer, handle, options)
    } catch (error) {
        await observer.finishAttempt(handle, classifyError(error, options), error)
        throw error
    }
}

/** The part of a refused response its failure class is read from. */
function refusedResponse(response: Response): { readonly status: number } {
    return { status: response.status }
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
            const settle = async (status: ProviderAttemptTerminalStatus, failure?: unknown): Promise<void> => {
                if (settled) return
                settled = true
                await observer.finishAttempt(handle, status, failure)
            }
            return {
                async next(value?: unknown): Promise<IteratorResult<T>> {
                    try {
                        const result = await iterator.next(value as never)
                        if (result.done) await settle(signalOutcome(options.signal) ?? "completed")
                        return result
                    } catch (error) {
                        await settle(classifyError(error, options), error)
                        throw error
                    }
                },
                async return(value?: unknown): Promise<IteratorResult<T>> {
                    try {
                        return iterator.return ? await iterator.return(value as never) : { done: true, value: value as T }
                    } finally {
                        await settle(signalOutcome(options.signal) ?? "cancelled")
                    }
                },
                async throw(error?: unknown): Promise<IteratorResult<T>> {
                    try {
                        if (iterator.throw) return await iterator.throw(error)
                        throw error
                    } finally {
                        await settle(classifyError(error, options), error)
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
    const settle = async (status: ProviderAttemptTerminalStatus, failure?: unknown): Promise<void> => {
        if (settled) return
        settled = true
        await observer.finishAttempt(handle, status, failure)
    }
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const result = await reader.read()
                if (result.done) {
                    const settledStatus = cancellationStatus ?? signalOutcome(options.signal)
                    if (settledStatus) await settle(settledStatus)
                    else if (response.ok) await settle("completed")
                    else await settle("failed", refusedResponse(response))
                    controller.close()
                    return
                }
                protocolTerminal.observe(result.value)
                controller.enqueue(result.value)
            } catch (error) {
                await settle(cancellationStatus ?? classifyError(error, options), error)
                controller.error(error)
            }
        },
        async cancel(reason) {
            cancellationStatus = classifyCancellation(reason, options.signal, protocolTerminal.completed())
            try {
                await reader.cancel(reason)
            } finally {
                await settle(cancellationStatus, reason)
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The send identity, carrying the scope's custom-model switch unless the encoder set it. */
function currentAttemptIdentity(): ProviderAttemptIdentity | undefined {
    const identity = providerAttemptIdentityContext.getStore()
    const customModel = providerAttemptAdapterContext.getStore()?.customModel
    if (!identity || customModel === undefined || identity.customModel !== undefined) return identity
    return { ...identity, customModel }
}

/** The observer for a send no enclosing observation counts yet. */
function unobservedSendObserver(): ProviderAttemptObserver | undefined {
    return observedSendContext.getStore() ? undefined : providerAttemptContext.getStore()
}

function signalOutcome(signal?: AbortSignal): ProviderAttemptTerminalStatus | undefined {
    if (!signal?.aborted) return undefined
    return signal.reason === PROVIDER_USER_CANCEL_REASON ? "cancelled" : "aborted"
}

function classifyCancellation(reason: unknown, signal?: AbortSignal, protocolCompleted = false): ProviderAttemptTerminalStatus {
    const fromSignal = signalOutcome(signal)
    if (fromSignal) return fromSignal
    if (reason instanceof DOMException && reason.name === "AbortError") return "aborted"
    if (reason instanceof Error && reason.name === "AbortError") return "aborted"
    if (reason instanceof Error) return "failed"
    return protocolCompleted ? "completed" : "cancelled"
}

function classifyError(error: unknown, options: ProviderAttemptObservationOptions): ProviderAttemptTerminalStatus {
    const classified = options.classifyError?.(error)
    if (classified) return classified
    const fromSignal = signalOutcome(options.signal)
    if (fromSignal) return fromSignal
    if (error instanceof DOMException && error.name === "AbortError") return "aborted"
    if (error instanceof Error && error.name === "AbortError") return "aborted"
    return "failed"
}
