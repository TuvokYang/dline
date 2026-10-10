import { useCallback, useEffect, useRef, useState } from "react"

type DebouncedInputChange<T> = (value: T) => unknown
type FlushPendingInput = () => Promise<void>

const pendingInputFlushers = new Set<FlushPendingInput>()

/** Flush every mounted Settings input before the Settings view is closed. */
export async function flushPendingDebouncedInputs(): Promise<void> {
    const results = await Promise.allSettled([...pendingInputFlushers].map((flush) => flush()))
    const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason)

    if (failures.length === 1) {
        throw failures[0]
    }
    if (failures.length > 1) {
        throw new AggregateError(failures, "Multiple Settings inputs failed to save")
    }
}

/**
 * A custom hook that provides debounced input handling to prevent jumpy text inputs
 * when saving changes directly to backend on every keystroke.
 *
 * @param initialValue - The initial value for the input
 * @param onChange - Callback function to save the value (e.g., to backend)
 * @param debounceMs - Debounce delay in milliseconds (default: 100ms)
 * @returns A tuple of [currentValue, setValue, flush] similar to useState
 */
export function useDebouncedInput<T>(
    initialValue: T,
    onChange: DebouncedInputChange<T>,
    debounceMs = 100,
): [T, (value: T) => void, FlushPendingInput] {
    const [localValue, setLocalValue] = useState(initialValue)
    const prevInitialValueRef = useRef<T>(initialValue)
    const localValueRef = useRef<T>(initialValue)
    const pendingUserChangeRef = useRef(false)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const inFlightRef = useRef<Promise<void> | null>(null)
    const onChangeRef = useRef(onChange)
    onChangeRef.current = onChange

    const savePending = useCallback(async (): Promise<void> => {
        if (!pendingUserChangeRef.current) {
            return
        }

        pendingUserChangeRef.current = false
        const value = localValueRef.current
        const previous = inFlightRef.current ?? Promise.resolve()
        const operation = previous.then(() => onChangeRef.current(value)).then(() => undefined)
        const tracked = operation.catch((error: unknown) => {
            // Keep the value dirty so an explicit Done/flush can retry the failed save.
            pendingUserChangeRef.current = true
            throw error
        })
        inFlightRef.current = tracked
        try {
            await tracked
        } finally {
            if (inFlightRef.current === tracked) {
                inFlightRef.current = null
            }
        }
    }, [])

    const flush = useCallback(async (): Promise<void> => {
        if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
        }

        while (pendingUserChangeRef.current || inFlightRef.current) {
            if (pendingUserChangeRef.current) {
                await savePending()
            } else {
                await inFlightRef.current
            }
        }
    }, [savePending])

    // Sync local state when initialValue changes externally (e.g., when switching tabs).
    useEffect(() => {
        if (Object.is(prevInitialValueRef.current, initialValue)) {
            return
        }

        // An uncommitted draft must survive; anything else adopts the incoming value.
        // The draft is only uncommitted while it differs from both the value it was
        // derived from and the value now arriving, which is how a round-tripped save
        // is told apart from an edit that has not been saved yet.
        const hasUncommittedDraft =
            !Object.is(localValueRef.current, prevInitialValueRef.current) && !Object.is(localValueRef.current, initialValue)

        prevInitialValueRef.current = initialValue
        if (hasUncommittedDraft) {
            return
        }

        localValueRef.current = initialValue
        setLocalValue(initialValue)
    }, [initialValue])

    // Register the flusher so SettingsView can commit every mounted input before Done.
    useEffect(() => {
        pendingInputFlushers.add(flush)
        return () => {
            pendingInputFlushers.delete(flush)
            void flush().catch((error: unknown) => {
                console.error("Failed to flush debounced Settings input on unmount:", error)
            })
        }
    }, [flush])

    const setInputValue = useCallback(
        (value: T) => {
            if (Object.is(localValueRef.current, value)) {
                return
            }

            localValueRef.current = value
            pendingUserChangeRef.current = true
            setLocalValue(value)

            if (timerRef.current) {
                clearTimeout(timerRef.current)
            }
            timerRef.current = setTimeout(() => {
                timerRef.current = null
                void flush().catch((error: unknown) => {
                    console.error("Failed to persist debounced Settings input:", error)
                })
            }, debounceMs)
        },
        [debounceMs, flush],
    )

    return [localValue, setInputValue, flush]
}
