import { useCallback, useSyncExternalStore } from "react"
import type { SemanticComposerEngine } from "./engine"
import type { ComposerState } from "./model"

/**
 * Subscribe a React component to the engine's draft.
 *
 * Kept apart from the editor view so state consumers such as menus and the
 * draft owner depend on the engine contract, not on the contenteditable view.
 */
export function useComposerState(engine: SemanticComposerEngine): ComposerState {
    return useSyncExternalStore(
        useCallback(
            (onChange: () => void) => {
                const subscription = engine.subscribe(onChange)
                return () => subscription.dispose()
            },
            [engine],
        ),
        () => engine.getState(),
    )
}
