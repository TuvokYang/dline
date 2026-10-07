import { AlertCircleIcon, CircleCheckIcon, CircleIcon, LoaderCircleIcon } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import DlineLogo from "@/assets/DlineLogo"
import { Button } from "@/components/ui/button"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { AccountServiceClient, StateServiceClient } from "@/services/grpc-client"
import ApiConfigurationSection from "../settings/sections/ApiConfigurationSection"
import { NEW_USER_TYPE, STEP_CONFIG, USER_TYPE_SELECTIONS } from "./data-steps"

type UserTypeSelectionProps = {
	userType: NEW_USER_TYPE
	onSelectUserType: (type: NEW_USER_TYPE) => void
}

const UserTypeSelectionStep = ({ userType, onSelectUserType }: UserTypeSelectionProps) => (
	<div className="flex flex-col w-full items-center">
		<div className="flex w-full max-w-lg flex-col gap-3 my-2">
			{USER_TYPE_SELECTIONS.map((option) => {
				const isSelected = userType === option.type

				return (
					<Item
						className={cn("cursor-pointer hover:cursor-pointer w-full", {
							"bg-input-background/50 border border-input-foreground/30": isSelected,
						})}
						key={option.type}
						onClick={() => onSelectUserType(option.type)}>
						<ItemMedia className="[&_svg]:stroke-button-background" variant="icon">
							{isSelected ? <CircleCheckIcon className="stroke-1.5" /> : <CircleIcon className="stroke-1" />}
						</ItemMedia>
						<ItemContent className="w-full">
							<ItemTitle>{option.title}</ItemTitle>
							<ItemDescription>{option.description}</ItemDescription>
						</ItemContent>
					</Item>
				)
			})}
		</div>
	</div>
)

const OnboardingView = () => {
	const { hideSettings, hideAccount, setShowWelcome } = useExtensionState()
	const [stepNumber, setStepNumber] = useState(0)
	const [isActionLoading, setIsActionLoading] = useState(false)
	const [userType, setUserType] = useState<NEW_USER_TYPE>(NEW_USER_TYPE.ACCOUNT)

	const onUserTypeClick = useCallback((selectedUserType: NEW_USER_TYPE) => {
		setUserType(selectedUserType)
		StateServiceClient.captureOnboardingProgress({
			step: 0,
			action: selectedUserType === NEW_USER_TYPE.ACCOUNT ? "account_selected" : "byok_user_selected",
		})
	}, [])

	const finishOnboarding = useCallback(
		(step: number) => {
			hideAccount()
			hideSettings()
			StateServiceClient.captureOnboardingProgress({ step, action: "onboarding_completed", completed: true })
		},
		[hideAccount, hideSettings],
	)

	const startAccountLogin = useCallback(async () => {
		setStepNumber(2)
		setIsActionLoading(true)
		await AccountServiceClient.accountLoginClicked({})
			.catch(() => {})
			.finally(() => setIsActionLoading(false))
		finishOnboarding(2)
	}, [finishOnboarding])

	const handleFooterAction = useCallback(
		async (action: "next" | "back" | "done") => {
			switch (action) {
				case "next":
					if (userType === NEW_USER_TYPE.ACCOUNT) {
						await startAccountLogin()
						return
					}
					StateServiceClient.captureOnboardingProgress({ step: 1 })
					setStepNumber(1)
					break
				case "back":
					StateServiceClient.captureOnboardingProgress({ step: 0 })
					setStepNumber(0)
					break
				case "done":
					await StateServiceClient.setWelcomeViewCompleted({ value: true }).catch(() => {})
					setShowWelcome(false)
					finishOnboarding(stepNumber)
					break
			}
		},
		[finishOnboarding, setShowWelcome, startAccountLogin, stepNumber, userType],
	)

	const stepDisplayInfo = useMemo(() => {
		if (stepNumber === 0 || stepNumber === 2) {
			return STEP_CONFIG[stepNumber]
		}
		return STEP_CONFIG[NEW_USER_TYPE.BYOK]
	}, [stepNumber])

	return (
		<div className="fixed inset-0 p-0 flex flex-col w-full">
			<div className="h-full px-5 xs:mx-10 overflow-auto flex flex-col gap-4 items-center justify-center">
				<DlineLogo className="size-16 flex-shrink-0" color="white" />
				<h2 className="text-lg font-semibold p-0 flex-shrink-0">{stepDisplayInfo.title}</h2>
				{stepNumber === 2 && (
					<div className="flex w-full max-w-lg flex-col gap-6 my-4 items-center">
						{isActionLoading && <LoaderCircleIcon className="animate-spin" />}
					</div>
				)}
				{stepDisplayInfo.description && (
					<p className="text-foreground text-sm text-center m-0 p-0 flex-shrink-0">{stepDisplayInfo.description}</p>
				)}

				<div
					className={cn("flex-1 w-full flex overflow-y-auto min-h-0", stepNumber === 1 ? "max-w-4xl" : "max-w-lg")}
					data-testid="onboarding-step-content">
					{stepNumber === 0 && <UserTypeSelectionStep onSelectUserType={onUserTypeClick} userType={userType} />}
					{stepNumber === 1 && (
						<div className="w-full">
							<ApiConfigurationSection />
						</div>
					)}
				</div>

				<footer className="flex w-full max-w-lg flex-col gap-3 my-2 px-2 overflow-hidden flex-shrink-0">
					{stepDisplayInfo.buttons.map((btn) => (
						<Button
							className={`w-full rounded-xs ${isActionLoading ? "animate-pulse" : ""}`}
							disabled={isActionLoading}
							key={btn.text}
							onClick={() => handleFooterAction(btn.action)}
							variant={btn.variant}>
							{btn.text}
						</Button>
					))}

					{stepNumber !== 2 && (
						<div className="items-center justify-center flex text-sm text-foreground gap-2 mb-3 text-pretty">
							<AlertCircleIcon className="shrink-0 size-2" /> You can change this later in settings
						</div>
					)}
				</footer>
			</div>
		</div>
	)
}

export default OnboardingView
