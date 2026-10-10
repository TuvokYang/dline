import type { Frame } from "@playwright/test"

type FooterStabilityState = {
    stop: () => void
    events: string[]
}

type SettingControlStabilityState = {
    stop: () => void
    samples: Array<string | null>
}

/** Start sampling footer action node identity so transient unmounts are observable in E2E. */
export async function startFooterActionStabilityObserver(
    frame: Frame,
    labels: readonly string[],
    selector = "vscode-button[aria-label]",
): Promise<void> {
    await frame.evaluate(
        ({ expectedLabels, targetSelector }) => {
            const root = globalThis as typeof globalThis & { __dlineFooterStabilityState?: FooterStabilityState }
            root.__dlineFooterStabilityState?.stop()
            const events: string[] = []
            const seen = new Set<string>()
            const previous = new Map<string, HTMLElement | null>()
            const read = (label: string): HTMLElement | null => {
                for (const element of document.querySelectorAll<HTMLElement>(targetSelector)) {
                    const accessibleName = element.getAttribute("aria-label") ?? element.textContent?.replace(/\s+/g, " ").trim()
                    if (accessibleName === label) return element
                }
                return null
            }
            for (const label of expectedLabels) previous.set(label, read(label))

            const timer = window.setInterval(() => {
                for (const label of expectedLabels) {
                    const before = previous.get(label) ?? null
                    const current = read(label)
                    if (current && !seen.has(label)) {
                        seen.add(label)
                    }
                    if (before && !current) events.push(`${label}:removed`)
                    if (before && current && before !== current) events.push(`${label}:replaced`)
                    previous.set(label, current)
                }
            }, 5)

            const stop = () => window.clearInterval(timer)
            root.__dlineFooterStabilityState = { stop, events }
        },
        { expectedLabels: [...labels], targetSelector: selector },
    )
}

/** Stop a footer observer and return any action unmount/replacement events. */
export async function stopFooterActionStabilityObserver(frame: Frame): Promise<string[]> {
    return frame.evaluate(() => {
        const root = globalThis as typeof globalThis & { __dlineFooterStabilityState?: FooterStabilityState }
        const state = root.__dlineFooterStabilityState
        if (!state) return []
        state.stop()
        delete root.__dlineFooterStabilityState
        return [...state.events]
    })
}

/** Return rendered virtual message rows that have neither readable content nor an intentional visual control. */
export async function readBlankMessageRows(frame: Frame): Promise<string[]> {
    return frame.locator("[data-message-ts]").evaluateAll((rows) =>
        rows
            .filter((row) => {
                const element = row as HTMLElement
                if (element.innerText.trim()) return false
                return !element.querySelector(
                    "button, input, textarea, img, video, canvas, svg, [role='progressbar'], [data-testid]",
                )
            })
            .map((row) => row.getAttribute("data-message-ts") ?? "missing-ts"),
    )
}

/** Sample a controlled settings input/checkbox and expose value reversion during persistence. */
export async function startSettingControlStabilityObserver(
    frame: Frame,
    query: { selector?: string; label?: string },
    kind: "value" | "checked",
): Promise<void> {
    await frame.evaluate(
        ({ query, kind }) => {
            const root = globalThis as typeof globalThis & {
                __dlineSettingControlStabilityState?: SettingControlStabilityState
            }
            root.__dlineSettingControlStabilityState?.stop()
            const find = (): HTMLInputElement | HTMLElement | null => {
                if (query.selector) {
                    const direct = document.querySelector<HTMLElement>(query.selector)
                    if (direct) return direct
                    // FAST text fields expose their native input through shadow DOM, while
                    // Playwright's locator API transparently pierces it.
                    const inputSuffix = query.selector.match(/^(.*)\s+input$/)
                    if (inputSuffix) {
                        const host = document.querySelector<HTMLElement>(inputSuffix[1])
                        return host?.shadowRoot?.querySelector<HTMLElement>("input") ?? null
                    }
                    return null
                }
                return (
                    [...document.querySelectorAll<HTMLElement>("vscode-checkbox")].find((element) =>
                        element.textContent?.includes(query.label ?? ""),
                    ) ?? null
                )
            }
            const read = (): string | null => {
                const element = find() as (HTMLInputElement & { checked?: boolean }) | null
                if (!element) return null
                return kind === "checked" ? String(Boolean(element.checked)) : (element as HTMLInputElement).value
            }
            const samples: Array<string | null> = [read()]
            const timer = window.setInterval(() => samples.push(read()), 5)
            const stop = () => window.clearInterval(timer)
            root.__dlineSettingControlStabilityState = { stop, samples }
        },
        { query, kind },
    )
}

/** Stop a settings control observer and return its sampled values. */
export async function stopSettingControlStabilityObserver(frame: Frame): Promise<Array<string | null>> {
    return frame.evaluate(() => {
        const root = globalThis as typeof globalThis & {
            __dlineSettingControlStabilityState?: SettingControlStabilityState
        }
        const state = root.__dlineSettingControlStabilityState
        if (!state) return []
        state.stop()
        delete root.__dlineSettingControlStabilityState
        return [...state.samples]
    })
}
