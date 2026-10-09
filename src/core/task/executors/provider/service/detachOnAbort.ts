/** Close a provider iterator, ignoring the error a failed or abandoned source reports on cleanup. */
export async function closeQuietly(iterator: AsyncIterator<unknown> | undefined): Promise<void> {
	try {
		await iterator?.return?.(undefined)
	} catch {
		// The attempt already ended; its cleanup error carries no new information.
	}
}

type NextOrAbort<T> = { readonly kind: "next"; readonly result: IteratorResult<T> } | { readonly kind: "aborted" }

/** The pending pull's result, or `aborted` as soon as the signal fires. */
function nextOrAbort<T>(pending: Promise<IteratorResult<T>>, signal: AbortSignal): Promise<NextOrAbort<T>> {
	if (signal.aborted) return Promise.resolve({ kind: "aborted" })
	return new Promise((resolve, reject) => {
		let settled = false
		const onAbort = () => {
			if (settled) return
			settled = true
			resolve({ kind: "aborted" })
		}
		signal.addEventListener("abort", onAbort, { once: true })
		pending.then(
			(result) => {
				signal.removeEventListener("abort", onAbort)
				if (settled) return
				settled = true
				resolve({ kind: "next", result })
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort)
				// After an abort won, the rejection is still observed here so it is never unhandled.
				if (settled) return
				settled = true
				reject(error)
			},
		)
	})
}

/** Close the source once the pull that was in flight when the task let go of it settles. */
async function closeAfterPending<T>(iterator: AsyncIterator<T>, pending: Promise<IteratorResult<T>>): Promise<void> {
	try {
		await pending
	} catch {
		// Cancellation owns the outcome; a late source failure is no longer task feedback.
	}
	await closeQuietly(iterator)
}

/**
 * Yield `source` until `signal` aborts, then end at once.
 *
 * Some transports cannot abort a pending read, so a cancelled request would
 * otherwise hold its task until the provider chose to finish the stream. On
 * abort the in-flight pull is abandoned rather than awaited: its late value is
 * discarded and the source is closed in the background once that pull
 * settles, so `next()` and `return()` are never called concurrently.
 */
export async function* detachOnAbort<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
	const iterator = source[Symbol.asyncIterator]()
	let released = false
	/** Let go of the source without waiting for it to wind down. */
	const release = () => {
		released = true
		void closeQuietly(iterator)
	}
	try {
		for (;;) {
			if (signal.aborted) return release()
			const pending = iterator.next()
			const step = await nextOrAbort(pending, signal)
			if (step.kind === "aborted") {
				released = true
				void closeAfterPending(iterator, pending)
				return
			}
			if (step.result.done) {
				released = true
				return
			}
			// A value that settled in the same turn as the abort belongs to the cancelled request.
			if (signal.aborted) return release()
			yield step.result.value
		}
	} finally {
		if (!released) await closeQuietly(iterator)
	}
}
