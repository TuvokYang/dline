/**
 * @typedef {{
 *   on: (event: "SIGINT" | "SIGTERM", listener: () => void) => unknown,
 *   off: (event: "SIGINT" | "SIGTERM", listener: () => void) => unknown,
 *   exit: (code: number) => unknown,
 * }} SignalProcess
 */

/**
 * A synchronous LIFO cleanup stack for temporary packaging state.
 *
 * Signal handlers cannot await asynchronous cleanup before terminating the
 * process, so every registered callback must finish synchronously.
 */
export class SynchronousCleanupStack {
    /** @type {Array<() => void>} */
    #cleanups = []
    #cleaned = false

    /**
     * Register cleanup before applying the corresponding temporary mutation.
     * @param {() => void} cleanup
     */
    defer(cleanup) {
        if (this.#cleaned) {
            throw new Error("Cannot register cleanup after the cleanup stack has run.")
        }
        this.#cleanups.push(cleanup)
    }

    /** Run every registered callback once, in reverse registration order. */
    cleanup() {
        if (this.#cleaned) {
            return
        }
        this.#cleaned = true

        /** @type {unknown[]} */
        const errors = []
        for (let index = this.#cleanups.length - 1; index >= 0; index -= 1) {
            try {
                this.#cleanups[index]()
            } catch (error) {
                errors.push(error)
            }
        }
        this.#cleanups = []

        if (errors.length === 1) {
            throw errors[0]
        }
        if (errors.length > 1) {
            throw new AggregateError(errors, "Multiple packaging cleanup operations failed.")
        }
    }
}

/**
 * Run work with one cleanup stack shared by normal, error, SIGINT, and SIGTERM exits.
 *
 * @template T
 * @param {(cleanups: SynchronousCleanupStack) => T | Promise<T>} work
 * @param {{
 *   processRef?: SignalProcess,
 *   onSignalCleanupError?: (error: unknown, signal: "SIGINT" | "SIGTERM") => void,
 * }} [options]
 * @returns {Promise<T>}
 */
export async function withSignalSafeCleanup(work, options = {}) {
    const processRef = options.processRef ?? process
    const cleanups = new SynchronousCleanupStack()
    let signalHandled = false

    /** @param {"SIGINT" | "SIGTERM"} signal @param {number} exitCode */
    const createSignalHandler = (signal, exitCode) => () => {
        if (signalHandled) {
            return
        }
        signalHandled = true
        try {
            cleanups.cleanup()
        } catch (error) {
            if (options.onSignalCleanupError) {
                options.onSignalCleanupError(error, signal)
            } else {
                console.error(`packaging cleanup failed during ${signal}:`, error)
            }
        }
        processRef.exit(exitCode)
    }

    const onSigint = createSignalHandler("SIGINT", 130)
    const onSigterm = createSignalHandler("SIGTERM", 143)
    processRef.on("SIGINT", onSigint)
    processRef.on("SIGTERM", onSigterm)

    try {
        return await work(cleanups)
    } finally {
        processRef.off("SIGINT", onSigint)
        processRef.off("SIGTERM", onSigterm)
        cleanups.cleanup()
    }
}
