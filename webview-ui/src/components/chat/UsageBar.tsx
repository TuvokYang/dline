import type { AccountUsageData, AccountUsageQuotaData } from "@shared/ExtensionMessage"
import { AccountUsageResetCreditRequest, type AccountUsageResetResult, ProviderUsageRequest } from "@shared/proto/dline/account"
import { protoToAccountUsage } from "@shared/proto-conversions/account-usage-conversion"
import { LoaderIcon, RefreshCwIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AccountServiceClient } from "@/services/grpc-client"
import {
	formatProviderUsageCurrency,
	isReadableUsageQuota,
	ProviderUsageDetails,
	selectEffectiveUsageQuota,
	usageRemainingPercent,
} from "../settings/providers/ProviderUsageDetails"

interface RefreshOverlay {
	readonly source: AccountUsageData
	readonly value: AccountUsageData
}

interface UsageClickMenuPosition {
	readonly left: number
	readonly width: number
	readonly maxHeight: number
	readonly top?: number
	readonly bottom?: number
}

const CLICK_MENU_MARGIN = 8
const CLICK_MENU_GAP = 4
const CLICK_MENU_WIDTH = 300
const CLICK_MENU_MAX_HEIGHT = 360

function calculateUsageClickMenuPosition(
	anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
	viewportWidth: number,
	viewportHeight: number,
): UsageClickMenuPosition {
	const width = Math.min(CLICK_MENU_WIDTH, Math.max(1, viewportWidth - CLICK_MENU_MARGIN * 2))
	const maxLeft = Math.max(CLICK_MENU_MARGIN, viewportWidth - width - CLICK_MENU_MARGIN)
	const centeredLeft = anchor.left + (anchor.right - anchor.left - width) / 2
	const left = Math.min(Math.max(centeredLeft, CLICK_MENU_MARGIN), maxLeft)
	const availableAbove = Math.max(0, anchor.top - CLICK_MENU_GAP - CLICK_MENU_MARGIN)
	const availableBelow = Math.max(0, viewportHeight - anchor.bottom - CLICK_MENU_GAP - CLICK_MENU_MARGIN)
	const placeAbove = availableAbove >= availableBelow
	const maxHeight = Math.min(CLICK_MENU_MAX_HEIGHT, placeAbove ? availableAbove : availableBelow)

	return placeAbove
		? { left, width, maxHeight, bottom: viewportHeight - anchor.top + CLICK_MENU_GAP }
		: { left, width, maxHeight, top: anchor.bottom + CLICK_MENU_GAP }
}

const ignoreResetCredit = async (_creditId: string): Promise<AccountUsageResetResult | undefined> => undefined

/**
 * Choose the one quota this bar can show.
 *
 * The five-hour window is the one a user acts on most often, so it wins while
 * it is the binding constraint. It must not win once another window is
 * exhausted: that window is what actually blocks the next request, and showing
 * plenty of five-hour headroom instead would contradict the blocked state.
 */
function selectChatInputUsageQuota(quotas: readonly AccountUsageQuotaData[]): AccountUsageQuotaData | undefined {
	const mostConstrainedQuota = selectEffectiveUsageQuota(quotas)
	if (mostConstrainedQuota && usageRemainingPercent(mostConstrainedQuota) <= 0) {
		return mostConstrainedQuota
	}
	const activeFiveHourQuota = quotas.find(
		(quota) => quota.type === "5hour" && isReadableUsageQuota(quota) && usageRemainingPercent(quota) < 100,
	)
	return activeFiveHourQuota ?? mostConstrainedQuota
}

/** Existing account usage surface, enhanced by provider-owned capability data. */
export const UsageBar = () => {
	const { accountUsage } = useExtensionState()
	const [open, setOpen] = useState(false)
	const [tooltipOpen, setTooltipOpen] = useState(false)
	const [menuPosition, setMenuPosition] = useState<UsageClickMenuPosition>()
	const [refreshing, setRefreshing] = useState(false)
	const [refreshError, setRefreshError] = useState<string>()
	const [refreshOverlay, setRefreshOverlay] = useState<RefreshOverlay>()
	const [resetting, setResetting] = useState(false)
	const [resetError, setResetError] = useState<string>()
	const refreshSequence = useRef(0)
	const accountUsageRef = useRef(accountUsage)
	const containerRef = useRef<HTMLDivElement>(null)
	const menuRef = useRef<HTMLDivElement>(null)
	accountUsageRef.current = accountUsage

	useEffect(() => {
		refreshSequence.current += 1
		setOpen(false)
		setTooltipOpen(false)
		setMenuPosition(undefined)
		setRefreshOverlay(undefined)
		setRefreshError(undefined)
		setResetError(undefined)
		setRefreshing(false)
		setResetting(false)
	}, [accountUsage?.profileId])

	useEffect(() => {
		if (!open) return
		const updateMenuPosition = (): void => {
			const anchor = containerRef.current?.getBoundingClientRect()
			if (!anchor) return
			setMenuPosition(calculateUsageClickMenuPosition(anchor, window.innerWidth, window.innerHeight))
		}
		const handlePointerDown = (event: PointerEvent): void => {
			const target = event.target
			const isResetConfirmation = target instanceof Element && target.closest('[aria-modal="true"]') !== null
			if (
				target instanceof Node &&
				!isResetConfirmation &&
				!containerRef.current?.contains(target) &&
				!menuRef.current?.contains(target)
			) {
				setOpen(false)
			}
		}
		const handleKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpen(false)
		}
		updateMenuPosition()
		document.addEventListener("pointerdown", handlePointerDown)
		document.addEventListener("keydown", handleKeyDown)
		window.addEventListener("resize", updateMenuPosition)
		window.addEventListener("scroll", updateMenuPosition, true)
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown)
			document.removeEventListener("keydown", handleKeyDown)
			window.removeEventListener("resize", updateMenuPosition)
			window.removeEventListener("scroll", updateMenuPosition, true)
		}
	}, [open])

	const usage = refreshOverlay && refreshOverlay.source === accountUsage ? refreshOverlay.value : accountUsage
	if (!usage) return null
	// A quota without a usable bound or reading says nothing about the account,
	// so it is dropped rather than rendered as a number the user would act on.
	const quotas = usage.quotas?.filter(isReadableUsageQuota) ?? []
	const effectiveQuota = selectChatInputUsageQuota(quotas)
	const summary = effectiveQuota
		? `${effectiveQuota.type === "5hour" ? "5h:" : effectiveQuota.type === "weekly" ? "7d:" : `${effectiveQuota.label}:`} ${usageRemainingPercent(effectiveQuota).toFixed(0)}%`
		: !usage.planType && usage.remainingBalance !== undefined
			? formatProviderUsageCurrency(usage.currency, usage.remainingBalance)
			: undefined
	if (!summary) return null

	const refresh = async () => {
		if (!usage.profileId || refreshing) return
		const requestProfileId = usage.profileId
		const sourceUsage = accountUsage
		if (!sourceUsage || sourceUsage.profileId !== requestProfileId) return
		const sequence = ++refreshSequence.current
		setRefreshError(undefined)
		setRefreshing(true)
		try {
			const response = await AccountServiceClient.getProviderUsage(
				ProviderUsageRequest.create({ profileId: requestProfileId }),
			)
			const nextUsage = protoToAccountUsage(response)
			if (
				sequence !== refreshSequence.current ||
				accountUsageRef.current !== sourceUsage ||
				nextUsage?.profileId !== requestProfileId
			) {
				return
			}
			setRefreshOverlay({ source: sourceUsage, value: nextUsage })
		} catch {
			if (sequence === refreshSequence.current && accountUsageRef.current === sourceUsage) {
				setRefreshError("Provider usage could not be refreshed.")
			}
		} finally {
			if (sequence === refreshSequence.current) setRefreshing(false)
		}
	}

	const handleDetailsClick = (): void => {
		setTooltipOpen(false)
		if (open) {
			setOpen(false)
			return
		}
		const anchor = containerRef.current?.getBoundingClientRect()
		if (!anchor) return
		setMenuPosition(calculateUsageClickMenuPosition(anchor, window.innerWidth, window.innerHeight))
		setOpen(true)
	}

	const handleTooltipOpenChange = (nextOpen: boolean) => {
		setTooltipOpen(!open && nextOpen)
	}

	const consumeResetCredit = async (creditId: string): Promise<AccountUsageResetResult | undefined> => {
		if (!usage.profileId || resetting) return undefined
		setResetError(undefined)
		setResetting(true)
		try {
			return await AccountServiceClient.consumeAccountUsageResetCredit(
				AccountUsageResetCreditRequest.create({ profileId: usage.profileId, creditId }),
			)
		} catch {
			setResetError("The Provider rate-limit reset could not be completed.")
			return undefined
		} finally {
			setResetting(false)
		}
	}

	return (
		<div className="relative inline-flex h-[18.5px] shrink-0 items-center" ref={containerRef}>
			<Tooltip onOpenChange={handleTooltipOpenChange} open={!open && tooltipOpen}>
				{!open && tooltipOpen ? (
					<TooltipContent
						align="end"
						arrowStyle={{
							background: "var(--vscode-dropdown-background, var(--vscode-menu-background))",
							borderColor: "var(--vscode-dropdown-border, var(--vscode-menu-border))",
							fill: "var(--vscode-dropdown-background, var(--vscode-menu-background))",
						}}
						className="w-72 overflow-visible border-dropdown-border bg-menu text-foreground"
						contentClassName="block w-full p-0"
						contentTag="div"
						data-usage-surface="preview"
						side="top"
						sideOffset={4}
						style={{
							background: "var(--vscode-dropdown-background, var(--vscode-menu-background))",
							borderColor: "var(--vscode-dropdown-border, var(--vscode-menu-border))",
							color: "var(--vscode-foreground, var(--vscode-menu-foreground))",
						}}>
						<div className="w-full p-3">
							<ProviderUsageDetails
								consumeResetCredit={ignoreResetCredit}
								resetCreditsDisplay="summary"
								resetting={false}
								showResetActions={false}
								usage={usage}
							/>
						</div>
					</TooltipContent>
				) : null}
				<TooltipTrigger asChild>
					<button
						aria-expanded={open}
						aria-haspopup="dialog"
						aria-label="Provider usage"
						className="chat-input-control-outline inline-flex h-[18.5px] shrink-0 cursor-pointer items-center rounded-sm border-0 bg-toolbar-hover px-1 py-0 text-xs font-medium leading-[18px] text-foreground shadow-none max-[420px]:hidden"
						data-chat-input-slot="provider-usage"
						onClick={handleDetailsClick}
						onPointerDownCapture={() => setTooltipOpen(false)}
						type="button">
						{summary}
					</button>
				</TooltipTrigger>
			</Tooltip>
			{open && menuPosition
				? createPortal(
						<div
							aria-label="Provider usage details"
							className="fixed z-[2000] flex flex-col overflow-hidden rounded border border-editor-group-border bg-menu text-menu-foreground shadow-lg"
							data-slot="click-menu-content"
							data-usage-surface="details"
							ref={menuRef}
							role="dialog"
							style={{
								bottom: menuPosition.bottom,
								left: menuPosition.left,
								maxHeight: menuPosition.maxHeight,
								top: menuPosition.top,
								width: menuPosition.width,
							}}>
							<div
								className="flex shrink-0 items-center justify-between gap-2 border-b border-editor-group-border px-3 py-2"
								data-usage-header>
								<span className="font-medium">Usage</span>
								<button
									aria-label="Refresh Provider usage"
									className="flex size-6 items-center justify-center rounded-xs border-0 bg-transparent text-description hover:bg-toolbar-hover hover:text-foreground disabled:opacity-50"
									disabled={!usage.profileId || refreshing}
									onClick={() => void refresh()}
									type="button">
									{refreshing ? (
										<LoaderIcon className="size-3.5 animate-spin" />
									) : (
										<RefreshCwIcon className="size-3.5" />
									)}
								</button>
							</div>
							<div className="min-h-0 overflow-y-auto p-3">
								{refreshError ? (
									<div className="mb-2 text-error" role="alert">
										{refreshError}
									</div>
								) : null}
								<ProviderUsageDetails
									consumeResetCredit={consumeResetCredit}
									resetError={resetError}
									resetting={resetting}
									usage={usage}
								/>
							</div>
						</div>,
						document.body,
					)
				: null}
		</div>
	)
}
