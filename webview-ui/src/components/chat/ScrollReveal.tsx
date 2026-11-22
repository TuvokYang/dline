import { type FocusEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

const REVEAL_HOLD_MS = 1_000

interface ScrollRevealProps {
    scroller: HTMLElement | null
    scope?: string
    className?: string
    children: ReactNode
}

/** Owns transient floating-control visibility without rerendering the chat list. */
export function ScrollReveal({ scroller, scope, className, children }: ScrollRevealProps) {
    const [active, setActive] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout>>()

    const clearHold = useCallback(() => {
        clearTimeout(timer.current)
        timer.current = undefined
    }, [])

    const hold = useCallback(() => {
        clearHold()
        setActive(true)
        timer.current = setTimeout(() => {
            timer.current = undefined
            setActive(false)
        }, REVEAL_HOLD_MS)
    }, [clearHold])

    useEffect(() => {
        // Visibility belongs to this list and opening, never a previous task's timer.
        void scope
        setActive(false)
        scroller?.addEventListener("scroll", hold, { passive: true })
        return () => {
            scroller?.removeEventListener("scroll", hold)
            clearHold()
        }
    }, [scroller, scope, hold, clearHold])

    const releaseFocus = (event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hold()
    }

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: this non-hit-testing overlay retains its descendant controls during pointer and keyboard use.
        <div
            className={cn("group/floating pointer-events-none", className)}
            data-floating-active={active ? "true" : undefined}
            onBlur={releaseFocus}
            onPointerEnter={clearHold}
            onPointerLeave={hold}>
            {children}
        </div>
    )
}
