import type { AccountUsageData } from "@shared/ExtensionMessage"
import { AccountUsageResetCreditRequest, type AccountUsageResetResult, ProviderUsageRequest } from "@shared/proto/dline/account"
import { protoToAccountUsage } from "@shared/proto-conversions/account-usage-conversion"
import { useCallback, useEffect, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AccountServiceClient } from "@/services/grpc-client"

export const USAGE_POLL_INTERVAL_MS = 60_000

export interface ProviderUsageOptions {
	/**
	 * How often to re-read the snapshot, or `null` to read it only on demand.
	 *
	 * A provider whose usage endpoint is billed against the same subscription
	 * that serves conversations opts out of the timer, matching the handler's
	 * own polling declaration. On demand also means no read on mount: the
	 * Controller already reads such a Profile once when it becomes active, so
	 * the panel shows that published snapshot and reads only on refresh.
	 */
	readonly pollIntervalMs?: number | null
}

export interface ProviderUsageState {
	readonly usage?: AccountUsageData
	readonly loading: boolean
	readonly refreshing: boolean
	readonly resetting: boolean
	readonly error?: string
	readonly resetError?: string
	readonly refresh: () => Promise<AccountUsageData | undefined>
	readonly consumeResetCredit: (creditId: string) => Promise<AccountUsageResetResult | undefined>
}

/**
 * A snapshot this panel read itself, bound to the Controller snapshot that was
 * current when it arrived. Once the Controller publishes a different snapshot
 * for the same Profile, that one is newer and the local read is discarded.
 */
interface LocalUsageRead {
	readonly profileId: string
	readonly publishedAtRead: AccountUsageData | undefined
	readonly value: AccountUsageData
}

/** Profile-scoped client for the shared provider usage capability. */
export function useProviderUsage(profileId: string, enabled: boolean, options: ProviderUsageOptions = {}): ProviderUsageState {
	const pollIntervalMs = options.pollIntervalMs === undefined ? USAGE_POLL_INTERVAL_MS : options.pollIntervalMs
	const readsOnDemand = pollIntervalMs === null
	const { accountUsage } = useExtensionState()
	const publishedUsage = accountUsage?.profileId === profileId ? accountUsage : undefined
	const [localRead, setLocalRead] = useState<LocalUsageRead>()
	const publishedRef = useRef(publishedUsage)
	publishedRef.current = publishedUsage
	const usage =
		localRead && localRead.profileId === profileId && localRead.publishedAtRead === publishedUsage
			? localRead.value
			: publishedUsage
	const setUsage = useCallback((value: AccountUsageData | undefined) => {
		setLocalRead(value?.profileId ? { profileId: value.profileId, publishedAtRead: publishedRef.current, value } : undefined)
	}, [])
	const [loading, setLoading] = useState(false)
	const [refreshing, setRefreshing] = useState(false)
	const [resetting, setResetting] = useState(false)
	const [error, setError] = useState<string>()
	const [resetError, setResetError] = useState<string>()
	const [pollingStopped, setPollingStopped] = useState(false)
	const profileRef = useRef(profileId)
	const usageRef = useRef<AccountUsageData>()
	const requestSequence = useRef(0)
	const mounted = useRef(true)
	profileRef.current = profileId
	usageRef.current = usage

	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
			requestSequence.current += 1
		}
	}, [])

	const refresh = useCallback(async (): Promise<AccountUsageData | undefined> => {
		if (!enabled) return undefined
		const requestProfileId = profileId
		const sequence = ++requestSequence.current
		setError(undefined)
		if (usageRef.current === undefined) setLoading(true)
		else setRefreshing(true)
		try {
			const response = await AccountServiceClient.getProviderUsage(
				ProviderUsageRequest.create({ profileId: requestProfileId }),
			)
			const nextUsage = protoToAccountUsage(response)
			if (!mounted.current || sequence !== requestSequence.current || nextUsage?.profileId !== profileRef.current) {
				return undefined
			}
			setUsage(nextUsage)
			// A read that succeeds proves the credential and the network are
			// working again, so a timer stopped by an earlier failure resumes.
			setPollingStopped(false)
			return nextUsage
		} catch {
			if (mounted.current && sequence === requestSequence.current && profileRef.current === requestProfileId) {
				setError("Provider usage could not be loaded.")
				// A failed read is most often a rejected credential, which a timer
				// cannot resolve. Repeating it would spend the account's own
				// request budget on an outcome that only signing in again fixes,
				// so recovery is left to the explicit refresh.
				setPollingStopped(true)
			}
			return undefined
		} finally {
			if (mounted.current && sequence === requestSequence.current) {
				setLoading(false)
				setRefreshing(false)
			}
		}
	}, [enabled, profileId, setUsage])

	useEffect(() => {
		requestSequence.current += 1
		usageRef.current = undefined
		setUsage(undefined)
		setError(undefined)
		setResetError(undefined)
		setLoading(false)
		setRefreshing(false)
		setPollingStopped(false)
		// Mounting is not a reason to spend a metered read: the panel remounts on
		// every expand and tab switch, which is what kept re-reading usage.
		if (!enabled || readsOnDemand) return
		void refresh()
	}, [enabled, readsOnDemand, refresh])

	useEffect(() => {
		if (!enabled || pollingStopped || pollIntervalMs === null) return
		const interval = window.setInterval(() => void refresh(), pollIntervalMs)
		return () => window.clearInterval(interval)
	}, [enabled, pollingStopped, pollIntervalMs, refresh])

	const consumeResetCredit = useCallback(
		async (creditId: string): Promise<AccountUsageResetResult | undefined> => {
			if (!enabled || resetting) return undefined
			const normalizedCreditId = creditId.trim()
			if (normalizedCreditId.length === 0) return undefined
			const requestProfileId = profileId
			setResetError(undefined)
			setResetting(true)
			try {
				const result = await AccountServiceClient.consumeAccountUsageResetCredit(
					AccountUsageResetCreditRequest.create({
						profileId: requestProfileId,
						creditId: normalizedCreditId,
					}),
				)
				if (!mounted.current || profileRef.current !== result.profileId) return undefined
				const nextUsage = protoToAccountUsage(result.usage)
				if (nextUsage) setUsage(nextUsage)
				return result
			} catch {
				if (mounted.current && profileRef.current === requestProfileId) {
					setResetError("The Provider rate-limit reset could not be completed.")
				}
				return undefined
			} finally {
				if (mounted.current && profileRef.current === requestProfileId) setResetting(false)
			}
		},
		[enabled, profileId, resetting, setUsage],
	)

	return { usage, loading, refreshing, resetting, error, resetError, refresh, consumeResetCredit }
}
