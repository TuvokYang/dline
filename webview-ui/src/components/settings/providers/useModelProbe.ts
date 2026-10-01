import type { ModelInfo } from "@shared/proto/dline/models"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

export interface ModelProbeOptions {
	/**
	 * Fetches the model IDs the configured endpoint currently exposes.
	 *
	 * The hook always calls the newest function it received, so the callback
	 * does not need a stable identity; `credentialsKey` decides when previously
	 * discovered IDs stop describing the configured endpoint.
	 */
	probe: () => Promise<string[]>
	/**
	 * Identifies the endpoint the probe reads.
	 *
	 * Discovered IDs are dropped when this changes. Deriving it from the
	 * credentials rather than the callback identity keeps a probe issued in the
	 * same render as a credential edit from being discarded as stale.
	 */
	credentialsKey?: string
	/** Skips probing while the endpoint credentials are incomplete. */
	enabled: boolean
	/** Kept in the list so the current selection stays visible before a probe returns. */
	selectedModelId?: string
}

export interface ModelProbeResult {
	/** Discovered IDs plus the current selection, as autocomplete entries. */
	models: Record<string, ModelInfo>
	/** Idempotent while a probe is in flight; safe to bind to a dropdown `onOpen`. */
	refresh: () => void
	loading: boolean
	error?: Error
}

/**
 * Discovers model IDs from a user-configured endpoint.
 *
 * Endpoints reached this way report identities only. Mark discovered entries
 * `userDefined` without borrowing another model's capabilities or prices;
 * complete catalog metadata comes from `useProviderModels` instead.
 */
export function useModelProbe({ probe, credentialsKey, enabled, selectedModelId }: ModelProbeOptions): ModelProbeResult {
	const [discoveredIds, setDiscoveredIds] = useState<string[]>([])
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<Error | undefined>(undefined)
	const requestId = useRef(0)
	const pending = useRef(false)
	// The caller rebuilds the callback whenever the credentials change, so
	// reading it through a ref lets `refresh` stay stable and always issue the
	// request against the newest endpoint.
	const probeRef = useRef(probe)
	probeRef.current = probe
	// Effects run after the render that issued a probe, so an unconditional
	// reset would discard a request started during the very first paint.
	// Tracking the key here limits the reset to a real endpoint change.
	const lastCredentialsKey = useRef(credentialsKey)

	// Different credentials mean previously discovered IDs no longer describe
	// the configured endpoint. Bumping the request id also discards responses
	// still in flight for the old one.
	useEffect(() => {
		if (lastCredentialsKey.current === credentialsKey) {
			return
		}
		lastCredentialsKey.current = credentialsKey
		requestId.current += 1
		pending.current = false
		setDiscoveredIds([])
		setError(undefined)
		setLoading(false)
	}, [credentialsKey])

	const refresh = useCallback(() => {
		if (!enabled || pending.current) {
			return
		}
		pending.current = true
		const currentRequest = ++requestId.current
		setLoading(true)
		probeRef
			.current()
			.then((ids) => {
				if (currentRequest !== requestId.current) {
					return
				}
				setDiscoveredIds([...new Set(ids.filter(Boolean))])
				setError(undefined)
			})
			.catch((cause: unknown) => {
				if (currentRequest !== requestId.current) {
					return
				}
				setError(cause instanceof Error ? cause : new Error(String(cause)))
			})
			.finally(() => {
				if (currentRequest !== requestId.current) {
					return
				}
				pending.current = false
				setLoading(false)
			})
	}, [enabled])

	const models = useMemo<Record<string, ModelInfo>>(() => {
		const ids = new Set(discoveredIds)
		if (selectedModelId) {
			ids.add(selectedModelId)
		}
		return Object.fromEntries(Array.from(ids).map((id) => [id, { id, name: id, userDefined: true }]))
	}, [discoveredIds, selectedModelId])

	return { models, refresh, loading, error }
}
