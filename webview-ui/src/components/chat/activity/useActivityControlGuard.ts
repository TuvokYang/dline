import { useCallback, useRef, useState } from "react"

/** Prevent duplicate activity control requests while one RPC is in flight. */
export function useActivityControlGuard(): {
    isPending: (key: string) => boolean
    runControl: (key: string, action: () => Promise<unknown>) => Promise<void>
} {
    const inFlight = useRef(new Set<string>())
    const [pending, setPending] = useState<ReadonlySet<string>>(new Set())

    const runControl = useCallback(async (key: string, action: () => Promise<unknown>): Promise<void> => {
        if (inFlight.current.has(key)) return
        inFlight.current.add(key)
        setPending((current) => new Set(current).add(key))
        try {
            await action()
        } catch (error) {
            console.error("Task activity control request failed", error)
        } finally {
            inFlight.current.delete(key)
            setPending((current) => {
                const next = new Set(current)
                next.delete(key)
                return next
            })
        }
    }, [])

    return {
        isPending: (key) => pending.has(key),
        runControl,
    }
}
