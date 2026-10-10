import { memo, useEffect, useRef, useState } from "react"
import { WithCopyButton } from "./CopyButton"
import { renderLatexToNode } from "./latex-engine"

interface LatexBlockProps {
    /** Raw TeX source taken verbatim from the fenced code block. */
    code: string
}

/**
 * Outcome of typesetting one specific TeX source.
 *
 * The source is part of the state so a result is never shown next to a
 * different source: while a new formula is being typeset the previous SVG and
 * the previous failure are both discarded.
 */
type RenderOutcome = { source: string; failed: boolean }

/**
 * Renders a fenced `latex` / `math` / `tex` code block as typeset math.
 *
 * Rendering is asynchronous (MathJax v4 is promise-based end to end). When the
 * source cannot be typeset the original TeX is shown instead of an empty block,
 * and the copy button stays available in both states so the user can always
 * retrieve the raw source.
 */
const LatexBlock = memo(({ code }: LatexBlockProps) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const [outcome, setOutcome] = useState<RenderOutcome | undefined>(undefined)

    useEffect(() => {
        const container = containerRef.current
        if (!container) {
            return
        }

        let cancelled = false
        // Drop the previous formula immediately so a stale SVG is never shown
        // alongside the new source or its copy button.
        container.replaceChildren()
        setOutcome(undefined)

        const render = async () => {
            try {
                const node = await renderLatexToNode(code, container.clientWidth)
                if (cancelled) {
                    return
                }
                container.replaceChildren(node)
                setOutcome({ source: code, failed: false })
            } catch (error) {
                if (cancelled) {
                    return
                }
                console.debug("Failed to typeset LaTeX block:", error)
                container.replaceChildren()
                setOutcome({ source: code, failed: true })
            }
        }

        void render()

        return () => {
            cancelled = true
        }
    }, [code])

    const failed = outcome?.source === code && outcome.failed

    return (
        <WithCopyButton ariaLabel="Copy LaTeX source" position="top-right" textToCopy={code}>
            {failed ? (
                <pre className="latex-block-error" data-testid="latex-block-error">
                    {code}
                </pre>
            ) : null}
            <div
                aria-label={code}
                className="latex-block"
                data-testid="latex-block"
                hidden={failed}
                ref={containerRef}
                role="math"
            />
        </WithCopyButton>
    )
})

LatexBlock.displayName = "LatexBlock"

export default LatexBlock
