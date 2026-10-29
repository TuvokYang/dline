import {
    type OpenAiCodexAccount,
    type OpenAiCodexAuthFlow,
    OpenAiCodexAuthStatus,
    type OpenAiCodexAuthStatusResponse,
    OpenAiCodexFlowStatus,
} from "@shared/proto/dline/account"
import { useCallback, useEffect, useRef, useState } from "react"
import { AccountServiceClient } from "@/services/grpc-client"

export type OpenAiCodexOAuthDialogPhase = "closed" | "starting" | "active" | "completing" | "timed-out" | "failed"

/**
 * Consecutive status probe failures tolerated before the UI surfaces an error.
 *
 * The status endpoint is polled on a timer and is also queried immediately on mount, so a single
 * transient failure is expected noise rather than an actionable condition. Only a sustained
 * failure means the user cannot read the credential state.
 */
const STATUS_FAILURE_TOLERANCE = 3

export interface OpenAiCodexOAuthDialogState {
    phase: OpenAiCodexOAuthDialogPhase
    flow?: OpenAiCodexAuthFlow
}

export function isOpenAiCodexAuthenticated(status: OpenAiCodexAuthStatus): boolean {
    return (
        status === OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_AUTHENTICATED ||
        status === OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_REFRESHABLE_EXPIRED
    )
}

export function useOpenAiCodexOAuthFlow(profileId: string) {
    const [status, setStatus] = useState(OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_UNSPECIFIED)
    const [account, setAccount] = useState<OpenAiCodexAccount>()
    const [dialog, setDialog] = useState<OpenAiCodexOAuthDialogState>({ phase: "closed" })
    const [statusError, setStatusError] = useState<string>()
    const [actionError, setActionError] = useState<string>()
    const [busy, setBusy] = useState(false)
    const statusFailureCountRef = useRef(0)
    const flowRef = useRef<OpenAiCodexAuthFlow>()
    const ignoredFlowIdsRef = useRef(new Set<string>())
    const mountedRef = useRef(false)
    const profileIdRef = useRef(profileId)
    const lifecycleEpochRef = useRef(0)
    const statusSequenceRef = useRef(0)
    profileIdRef.current = profileId

    const invalidatePendingResponses = useCallback(() => {
        statusSequenceRef.current += 1
        lifecycleEpochRef.current += 1
        return lifecycleEpochRef.current
    }, [])

    const isCurrent = useCallback(
        (targetProfileId: string, epoch: number) =>
            mountedRef.current && profileIdRef.current === targetProfileId && lifecycleEpochRef.current === epoch,
        [],
    )

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            invalidatePendingResponses()
            const flow = flowRef.current
            flowRef.current = undefined
            if (flow) {
                void AccountServiceClient.cancelOpenAiCodexSignIn({ profileId: flow.profileId, flowId: flow.flowId }).catch(
                    () => undefined,
                )
            }
        }
    }, [invalidatePendingResponses, profileId])

    const setClosed = useCallback(() => {
        flowRef.current = undefined
        setDialog({ phase: "closed" })
        setActionError(undefined)
    }, [])

    const applyStatus = useCallback(
        (response: OpenAiCodexAuthStatusResponse) => {
            if (response.profileId !== profileId) return
            statusFailureCountRef.current = 0
            setStatus(response.status)
            setAccount(response.account)
            setStatusError(undefined)
            const currentFlow = flowRef.current
            const outcome = response.lastFlowOutcome
            if (currentFlow && outcome?.flowId === currentFlow.flowId) {
                if (outcome.status === OpenAiCodexFlowStatus.OPEN_AI_CODEX_FLOW_STATUS_TIMED_OUT) {
                    setActionError("Sign-in timed out. Try again.")
                    setDialog({ phase: "timed-out", flow: currentFlow })
                    return
                }
                if (outcome.status === OpenAiCodexFlowStatus.OPEN_AI_CODEX_FLOW_STATUS_FAILED) {
                    flowRef.current = undefined
                    setActionError("Sign-in failed. Try again.")
                    setDialog({ phase: "failed" })
                    return
                }
                if (outcome.status === OpenAiCodexFlowStatus.OPEN_AI_CODEX_FLOW_STATUS_CANCELLED) {
                    setClosed()
                    return
                }
            }
            const activeFlow = response.activeFlow
            if (activeFlow?.profileId === profileId && activeFlow.flowId && !ignoredFlowIdsRef.current.has(activeFlow.flowId)) {
                flowRef.current = activeFlow
                setDialog((current) =>
                    current.phase === "completing" && current.flow?.flowId === activeFlow.flowId
                        ? current
                        : { phase: "active", flow: activeFlow },
                )
                return
            }
            if (isOpenAiCodexAuthenticated(response.status)) setClosed()
        },
        [profileId, setClosed],
    )

    const refreshStatus = useCallback(async () => {
        const targetProfileId = profileId
        const epoch = lifecycleEpochRef.current
        const sequence = ++statusSequenceRef.current
        try {
            const response = await AccountServiceClient.getOpenAiCodexAuthStatus({ profileId: targetProfileId })
            if (isCurrent(targetProfileId, epoch) && statusSequenceRef.current === sequence) applyStatus(response)
        } catch {
            if (!isCurrent(targetProfileId, epoch) || statusSequenceRef.current !== sequence) return
            statusFailureCountRef.current += 1
            if (statusFailureCountRef.current >= STATUS_FAILURE_TOLERANCE) {
                setStatusError("Cannot read the sign-in status.")
            }
        }
    }, [applyStatus, isCurrent, profileId])

    useEffect(() => {
        ignoredFlowIdsRef.current.clear()
        statusFailureCountRef.current = 0
        setBusy(false)
        setStatus(OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_UNSPECIFIED)
        setAccount(undefined)
        setClosed()
        setStatusError(undefined)
        void refreshStatus()
    }, [refreshStatus, setClosed])

    useEffect(() => {
        const active = dialog.phase === "active" || dialog.phase === "completing"
        const timer = setInterval(() => void refreshStatus(), active ? 1_000 : 5_000)
        return () => clearInterval(timer)
    }, [dialog.phase, refreshStatus])

    const start = useCallback(async () => {
        const targetProfileId = profileId
        const epoch = invalidatePendingResponses()
        ignoredFlowIdsRef.current.clear()
        flowRef.current = undefined
        setBusy(true)
        setActionError(undefined)
        setDialog({ phase: "starting" })
        try {
            const flow = await AccountServiceClient.startOpenAiCodexSignIn({ profileId: targetProfileId })
            if (!isCurrent(targetProfileId, epoch)) {
                if (flow.profileId && flow.flowId) {
                    void AccountServiceClient.cancelOpenAiCodexSignIn({ profileId: flow.profileId, flowId: flow.flowId }).catch(
                        () => undefined,
                    )
                }
                return
            }
            if (flow.profileId !== targetProfileId || !flow.flowId || !flow.authorizationUrl) {
                throw new Error("Unexpected OpenAI Codex OAUTH response.")
            }
            flowRef.current = flow
            setDialog({ phase: "active", flow })
        } catch {
            if (!isCurrent(targetProfileId, epoch)) return
            flowRef.current = undefined
            setActionError("Cannot start the ChatGPT sign-in. Try again.")
            setDialog({ phase: "failed" })
        } finally {
            if (isCurrent(targetProfileId, epoch)) setBusy(false)
        }
    }, [invalidatePendingResponses, isCurrent, profileId])

    const complete = useCallback(
        async (callbackUri: string) => {
            const flow = flowRef.current
            if (!flow || Date.now() >= flow.expiresAtMs) {
                setDialog({ phase: "timed-out", flow })
                setActionError("Sign-in timed out. Try again.")
                return
            }
            const targetProfileId = flow.profileId
            const epoch = invalidatePendingResponses()
            setBusy(true)
            setActionError(undefined)
            setDialog({ phase: "completing", flow })
            try {
                const response = await AccountServiceClient.completeOpenAiCodexCallbackUri({
                    profileId: targetProfileId,
                    flowId: flow.flowId,
                    callbackUri,
                })
                if (isCurrent(targetProfileId, epoch)) applyStatus(response)
            } catch {
                if (!isCurrent(targetProfileId, epoch)) return
                if (Date.now() >= flow.expiresAtMs) {
                    setDialog({ phase: "timed-out", flow })
                    setActionError("Sign-in timed out. Try again.")
                } else {
                    setDialog({ phase: "active", flow })
                    setActionError("Cannot finish the sign-in. Check the full callback URL and try again.")
                }
            } finally {
                if (isCurrent(targetProfileId, epoch)) setBusy(false)
            }
        },
        [applyStatus, invalidatePendingResponses, isCurrent],
    )

    const importCredential = useCallback(
        async (oauthJson: string) => {
            const targetProfileId = profileId
            const epoch = invalidatePendingResponses()
            setBusy(true)
            setActionError(undefined)
            try {
                const response = await AccountServiceClient.importOpenAiCodexCredentialJson({
                    profileId: targetProfileId,
                    oauthJson,
                })
                if (isCurrent(targetProfileId, epoch)) applyStatus(response)
            } catch {
                if (isCurrent(targetProfileId, epoch)) {
                    setActionError("Cannot import the credential. Check the JSON and try again.")
                }
            } finally {
                if (isCurrent(targetProfileId, epoch)) setBusy(false)
            }
        },
        [applyStatus, invalidatePendingResponses, isCurrent, profileId],
    )

    const cancel = useCallback(async () => {
        const flow = flowRef.current
        if (flow) ignoredFlowIdsRef.current.add(flow.flowId)
        const targetProfileId = flow?.profileId ?? profileId
        const epoch = invalidatePendingResponses()
        setClosed()
        if (!flow) return
        try {
            await AccountServiceClient.cancelOpenAiCodexSignIn({ profileId: targetProfileId, flowId: flow.flowId })
            if (isCurrent(targetProfileId, epoch)) await refreshStatus()
        } catch {
            if (!isCurrent(targetProfileId, epoch)) return
            ignoredFlowIdsRef.current.delete(flow.flowId)
            setActionError("Cannot cancel the sign-in. Try again.")
            await refreshStatus()
        }
    }, [invalidatePendingResponses, isCurrent, profileId, refreshStatus, setClosed])

    const signOut = useCallback(async () => {
        const targetProfileId = profileId
        const epoch = invalidatePendingResponses()
        setBusy(true)
        setActionError(undefined)
        try {
            await AccountServiceClient.signOutOpenAiCodexProfile({ profileId: targetProfileId })
            if (!isCurrent(targetProfileId, epoch)) return
            setClosed()
            setStatus(OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_MISSING)
            setAccount(undefined)
        } catch {
            if (isCurrent(targetProfileId, epoch)) setActionError("Cannot sign out of this profile. Try again.")
        } finally {
            if (isCurrent(targetProfileId, epoch)) setBusy(false)
        }
    }, [invalidatePendingResponses, isCurrent, profileId, setClosed])

    const markTimedOut = useCallback(() => {
        const flow = flowRef.current
        if (!flow) return
        invalidatePendingResponses()
        setActionError("Sign-in timed out. Try again.")
        setDialog({ phase: "timed-out", flow })
    }, [invalidatePendingResponses])

    return {
        status,
        account,
        dialog,
        statusError,
        actionError,
        busy,
        start,
        complete,
        importCredential,
        cancel,
        signOut,
        markTimedOut,
    }
}
