import { Logger } from "@/shared/services/Logger"

import { isOutputLimitExceededError } from "./stream/OutputLimitExceededError"

interface RetryOptions {
    maxRetries?: number
    baseDelay?: number
    maxDelay?: number
    retryAllErrors?: boolean
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
    maxRetries: 3,
    baseDelay: 1_000,
    maxDelay: 10_000,
    retryAllErrors: false,
}

function requestDelegatesRetry(args: readonly unknown[]): boolean {
    const options = args[3]
    if (typeof options !== "object" || options === null) return false
    const requestOptions = options as { retryOwner?: unknown; generation?: unknown }
    if (
        requestOptions.retryOwner === "task" ||
        requestOptions.retryOwner === "subagent" ||
        requestOptions.retryOwner === "compaction"
    ) {
        return true
    }
    const generation = requestOptions.generation
    return typeof generation === "object" && generation !== null && (generation as { purpose?: unknown }).purpose === "compaction"
}

interface RetryOwnershipContext {
    getStore(): boolean | undefined
    run<T>(store: boolean, callback: () => T): T
}

let delegatedRetryContextPromise: Promise<RetryOwnershipContext> | undefined

async function getDelegatedRetryContext(): Promise<RetryOwnershipContext> {
    delegatedRetryContextPromise ??= import("node:async_hooks").then(({ AsyncLocalStorage }) => new AsyncLocalStorage<boolean>())
    return delegatedRetryContextPromise
}

function bindRetryOwnership<T>(
    context: RetryOwnershipContext,
    iterable: AsyncIterable<T>,
    callerOwnsRetry: boolean,
): AsyncIterable<T> {
    return {
        [Symbol.asyncIterator](): AsyncIterator<T> {
            const iterator = iterable[Symbol.asyncIterator]()
            return {
                next: (value?: unknown) => context.run(callerOwnsRetry, () => iterator.next(value as never)),
                return: iterator.return
                    ? (value?: unknown) =>
                          context.run(callerOwnsRetry, () => iterator.return?.(value as never) as Promise<IteratorResult<T>>)
                    : undefined,
                throw: iterator.throw
                    ? (error?: unknown) =>
                          context.run(callerOwnsRetry, () => iterator.throw?.(error) as Promise<IteratorResult<T>>)
                    : undefined,
            }
        },
    }
}

export class RetriableError extends Error {
    status = 429
    retryAfter?: number

    constructor(message: string, retryAfter?: number, options?: ErrorOptions) {
        super(message, options)
        this.name = "RetriableError"

        this.retryAfter = retryAfter
    }
}

function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort)
            resolve()
        }, delay)
        const onAbort = () => {
            clearTimeout(timer)
            reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"))
        }
        signal?.addEventListener("abort", onAbort, { once: true })
    })
}

export function withRetry(options: RetryOptions = {}) {
    const { maxRetries, baseDelay, maxDelay, retryAllErrors } = { ...DEFAULT_OPTIONS, ...options }

    return (_target: any, _propertyKey: string, descriptor: PropertyDescriptor) => {
        const originalMethod = descriptor.value

        descriptor.value = async function* (...args: any[]) {
            const retryOwnershipContext = await getDelegatedRetryContext()
            const callerOwnsRetry = retryOwnershipContext.getStore() === true || requestDelegatesRetry(args)
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    const iterable = originalMethod.apply(this, args) as AsyncIterable<unknown>
                    yield* bindRetryOwnership(retryOwnershipContext, iterable, callerOwnsRetry)
                    return
                } catch (error: any) {
                    if (callerOwnsRetry || isOutputLimitExceededError(error)) {
                        throw error
                    }
                    const isRateLimit = error?.status === 429 || error instanceof RetriableError
                    const isLastAttempt = attempt === maxRetries - 1

                    if ((!isRateLimit && !retryAllErrors) || isLastAttempt) {
                        throw error
                    }

                    // Get retry delay from header or calculate exponential backoff
                    // Check various rate limit headers
                    const retryAfter =
                        error.headers?.["retry-after"] ||
                        error.headers?.["x-ratelimit-reset"] ||
                        error.headers?.["ratelimit-reset"] ||
                        error.retryAfter

                    let delay: number
                    if (retryAfter) {
                        // Handle both delta-seconds and Unix timestamp formats
                        const retryValue = Number.parseInt(retryAfter, 10)
                        if (retryValue > Date.now() / 1000) {
                            // Unix timestamp
                            delay = retryValue * 1000 - Date.now()
                        } else {
                            // Delta seconds
                            delay = retryValue * 1000
                        }
                    } else {
                        // Use exponential backoff if no header
                        delay = Math.min(maxDelay, baseDelay * 2 ** attempt)
                    }

                    const handlerInstance = this as any
                    const onRetryAttempt = handlerInstance.ctx?.onRetryAttempt ?? handlerInstance.options?.onRetryAttempt
                    if (onRetryAttempt) {
                        try {
                            await onRetryAttempt(attempt + 1, maxRetries, delay, error)
                        } catch (e) {
                            Logger.error("Error in onRetryAttempt callback:", e)
                        }
                    }

                    const retrySignal = handlerInstance.getRetrySignal?.() as AbortSignal | undefined
                    await waitForRetry(delay, retrySignal)
                }
            }
        }

        return descriptor
    }
}
