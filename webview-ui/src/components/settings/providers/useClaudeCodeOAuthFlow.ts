import {
	type ClaudeCodeAuthFlow,
	ClaudeCodeAuthFlowRequest,
	ClaudeCodeAuthStatus,
	type ClaudeCodeAuthStatusResponse,
	ClaudeCodePastedValueRequest,
	ClaudeCodeProfileRequest,
} from "@shared/proto/dline/account"
import { useCallback, useEffect, useRef, useState } from "react"
import { AccountServiceClient } from "@/services/grpc-client"

export type ClaudeCodeOAuthDialogPhase = "idle" | "starting" | "active" | "completing" | "timed-out" | "failed"

export interface ClaudeCodeOAuthFlowState {
	phase: ClaudeCodeOAuthDialogPhase
	dialogOpen: boolean
	flow?: ClaudeCodeAuthFlow
	status: ClaudeCodeAuthStatus
	account?: ClaudeCodeAuthStatusResponse["account"]
	busy: boolean
	error?: string
	signIn: () => Promise<void>
	complete: (pastedValue: string) => Promise<void>
	cancel: () => Promise<void>
	signOut: () => Promise<void>
	markTimedOut: () => void
}

function describeError(error: unknown): string {
	return error instanceof Error && error.message ? error.message : "Something went wrong. Try again."
}

/**
 * Owns the Claude Code sign-in lifecycle for one Profile.
 *
 * The loopback callback can complete a flow without any further user action, so
 * the dialog also polls status while it is open rather than waiting only for a
 * pasted value.
 */
export function useClaudeCodeOAuthFlow(profileId: string): ClaudeCodeOAuthFlowState {
	const [phase, setPhase] = useState<ClaudeCodeOAuthDialogPhase>("idle")
	const [flow, setFlow] = useState<ClaudeCodeAuthFlow>()
	const [status, setStatus] = useState<ClaudeCodeAuthStatus>(ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_UNSPECIFIED)
	const [account, setAccount] = useState<ClaudeCodeAuthStatusResponse["account"]>()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()
	const mounted = useRef(true)

	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])

	const refreshStatus = useCallback(async () => {
		if (!profileId) return undefined
		try {
			const response = await AccountServiceClient.getClaudeCodeAuthStatus(ClaudeCodeProfileRequest.create({ profileId }))
			if (!mounted.current) return response
			setStatus(response.status)
			setAccount(response.account)
			return response
		} catch {
			// A status read failure must not replace a real sign-in error.
			return undefined
		}
	}, [profileId])

	useEffect(() => {
		void refreshStatus()
	}, [refreshStatus])

	// While a flow is open the loopback server may complete it silently, so the
	// dialog observes the authenticated transition instead of assuming a paste.
	useEffect(() => {
		if (phase !== "active") return
		const timer = setInterval(async () => {
			const response = await refreshStatus()
			if (!response || !mounted.current) return
			if (response.status === ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_AUTHENTICATED) {
				setPhase("idle")
				setFlow(undefined)
			}
		}, 2_000)
		return () => clearInterval(timer)
	}, [phase, refreshStatus])

	const signIn = useCallback(async () => {
		setBusy(true)
		setError(undefined)
		setPhase("starting")
		try {
			const started = await AccountServiceClient.startClaudeCodeSignIn(ClaudeCodeProfileRequest.create({ profileId }))
			if (!mounted.current) return
			setFlow(started)
			setPhase("active")
		} catch (caught) {
			if (!mounted.current) return
			setError(describeError(caught))
			setPhase("failed")
		} finally {
			if (mounted.current) setBusy(false)
		}
	}, [profileId])

	const complete = useCallback(
		async (pastedValue: string) => {
			if (!flow) return
			setBusy(true)
			setError(undefined)
			setPhase("completing")
			try {
				const response = await AccountServiceClient.completeClaudeCodeSignIn(
					ClaudeCodePastedValueRequest.create({ profileId, flowId: flow.flowId, pastedValue }),
				)
				if (!mounted.current) return
				setStatus(response.status)
				setAccount(response.account)
				setFlow(undefined)
				setPhase("idle")
			} catch (caught) {
				if (!mounted.current) return
				setError(describeError(caught))
				setPhase("active")
			} finally {
				if (mounted.current) setBusy(false)
			}
		},
		[flow, profileId],
	)

	const cancel = useCallback(async () => {
		setBusy(true)
		try {
			await AccountServiceClient.cancelClaudeCodeSignIn(
				ClaudeCodeAuthFlowRequest.create({ profileId, flowId: flow?.flowId ?? "" }),
			)
		} catch {
			// Cancelling an already-ended flow is not an error worth surfacing.
		} finally {
			if (mounted.current) {
				setFlow(undefined)
				setPhase("idle")
				setError(undefined)
				setBusy(false)
			}
			await refreshStatus()
		}
	}, [flow, profileId, refreshStatus])

	const signOut = useCallback(async () => {
		setBusy(true)
		setError(undefined)
		try {
			await AccountServiceClient.signOutClaudeCodeProfile(ClaudeCodeProfileRequest.create({ profileId }))
			if (!mounted.current) return
			setAccount(undefined)
			setStatus(ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_MISSING)
		} catch (caught) {
			if (mounted.current) setError(describeError(caught))
		} finally {
			if (mounted.current) setBusy(false)
		}
	}, [profileId])

	const markTimedOut = useCallback(() => setPhase("timed-out"), [])

	return {
		phase,
		dialogOpen: phase !== "idle",
		flow,
		status,
		account,
		busy,
		error,
		signIn,
		complete,
		cancel,
		signOut,
		markTimedOut,
	}
}
