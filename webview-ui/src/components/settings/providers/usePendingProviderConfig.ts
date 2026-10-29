import { useRef } from "react"

interface PublishedConfig<T> {
    readonly profileId: string
    readonly value: T
}

/**
 * Keeps provider-config edits from overwriting each other while the profile
 * round-trips through the backend.
 *
 * Provider components derive their config from the `profile` prop and publish
 * changes as a whole replacement object, for example
 * `onUpdate({ openai: { ...config, pricing } })`. Settings inputs are debounced
 * and each field commits on its own timer, so a second field can commit long
 * before the prop carries the first one. Rebuilding from the prop during that
 * window silently drops the earlier edit.
 *
 * `latest()` returns the config an update should be built from: the most
 * recently published value while the prop still lags behind it, otherwise the
 * prop. The recorded value is released once the prop reflects every field it
 * carried, or when the edited profile changes, so reloads and profile switches
 * still win.
 *
 * @param profileId Identifies the profile the config belongs to.
 * @param config Provider config derived from the current `profile` prop.
 * @returns The config to render, a `latest` reader, and a `publish` recorder.
 */
export function usePendingProviderConfig<T extends object>(
    profileId: string,
    config: T,
): { config: T; latest: () => T; publish: (next: T) => void } {
    const publishedRef = useRef<PublishedConfig<T> | null>(null)
    const published = publishedRef.current

    if (published && (published.profileId !== profileId || hasCaughtUp(published.value, config))) {
        publishedRef.current = null
    }

    // Keep the prop reachable from callbacks created in earlier renders.
    const configRef = useRef(config)
    configRef.current = config
    const profileIdRef = useRef(profileId)
    profileIdRef.current = profileId

    const latest = (): T => publishedRef.current?.value ?? configRef.current

    const publish = (next: T): void => {
        publishedRef.current = { profileId: profileIdRef.current, value: next }
    }

    // Rendering follows the prop so the editor never detaches from real state.
    return { config, latest, publish }
}

/**
 * Report whether the incoming prop already carries every value that was
 * published, which means the round trip finished.
 */
function hasCaughtUp<T extends object>(publishedValue: T, incoming: T): boolean {
    return Object.entries(publishedValue).every(([key, value]) => deepEquals(value, (incoming as Record<string, unknown>)[key]))
}

function deepEquals(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) {
        return true
    }
    if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
        return false
    }
    if (Array.isArray(left) !== Array.isArray(right)) {
        return false
    }

    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) {
        return false
    }
    return leftKeys.every(
        (key) =>
            Object.hasOwn(right, key) &&
            deepEquals((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
}
