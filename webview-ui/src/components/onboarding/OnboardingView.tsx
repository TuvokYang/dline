import { isFeatureSettingActive } from "@shared/DlineFeatureSettings"
import { AlertCircleIcon, CircleCheckIcon, CircleIcon, LoaderCircleIcon } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import DlineLogo from "@/assets/DlineLogo"
import { Button } from "@/components/ui/button"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { useExtensionState } from "@/context/ExtensionStateContext"
import type { UiMessageKey } from "@/i18n/messages"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { cn } from "@/lib/utils"
import { AccountServiceClient, StateServiceClient } from "@/services/grpc-client"
import ApiConfigurationSection from "../settings/sections/ApiConfigurationSection"
import { NEW_USER_TYPE, stepConfigOf, USER_TYPE_OPTIONS } from "./data-steps"

type UserTypeSelectionProps = {
    options: typeof USER_TYPE_OPTIONS
    userType: NEW_USER_TYPE
    onSelectUserType: (type: NEW_USER_TYPE) => void
}

const UserTypeSelectionStep = ({ options, userType, onSelectUserType }: UserTypeSelectionProps) => {
    const { t } = useUiTranslation()

    return (
        <div className="flex flex-col w-full items-center">
            <div className="flex w-full max-w-lg flex-col gap-3 my-2">
                {options.map((option) => {
                    const isSelected = userType === option.type
                    const copy = USER_TYPE_COPY[option.type]

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
                                <ItemTitle>{t(copy.titleKey)}</ItemTitle>
                                <ItemDescription>{t(copy.descriptionKey)}</ItemDescription>
                            </ItemContent>
                        </Item>
                    )
                })}
            </div>
        </div>
    )
}

/** User types keep a stable identity and their own copy keys, so selection never depends on display text. */
const USER_TYPE_COPY: Readonly<
    Record<
        NEW_USER_TYPE,
        {
            titleKey: Extract<UiMessageKey, `shell.onboarding.userType.${string}.title`>
            descriptionKey: Extract<UiMessageKey, `shell.onboarding.userType.${string}.description`>
        }
    >
> = {
    [NEW_USER_TYPE.ACCOUNT]: {
        titleKey: "shell.onboarding.userType.account.title",
        descriptionKey: "shell.onboarding.userType.account.description",
    },
    [NEW_USER_TYPE.BYOK]: {
        titleKey: "shell.onboarding.userType.byok.title",
        descriptionKey: "shell.onboarding.userType.byok.description",
    },
}

/** Footer button identities; the label is resolved while rendering. */
type FooterAction = "next" | "back" | "done"

const FOOTER_LABEL_KEYS: Readonly<Record<FooterAction, Extract<UiMessageKey, `shell.onboarding.button.${string}`>>> = {
    next: "shell.onboarding.button.continue",
    back: "shell.onboarding.button.back",
    done: "shell.onboarding.button.continue",
}

const OnboardingView = () => {
    const { t } = useUiTranslation()
    const { hideSettings, hideAccount, setShowWelcome, accountEnabled } = useExtensionState()
    const [stepNumber, setStepNumber] = useState(0)
    const [isActionLoading, setIsActionLoading] = useState(false)
    const [selectedUserType, setUserType] = useState<NEW_USER_TYPE>(NEW_USER_TYPE.ACCOUNT)
    // Without the account feature, bringing an API key is the only way in.
    const accountActive = isFeatureSettingActive(accountEnabled)
    const userType = accountActive ? selectedUserType : NEW_USER_TYPE.BYOK
    const userTypeOptions = useMemo(
        () => (accountActive ? USER_TYPE_OPTIONS : USER_TYPE_OPTIONS.filter((option) => option.type !== NEW_USER_TYPE.ACCOUNT)),
        [accountActive],
    )

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
        async (action: FooterAction) => {
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

    const stepConfig = stepConfigOf(stepNumber)
    const stepTitle = t(stepConfig.titleKey)
    const stepDescription = stepConfig.descriptionKey === undefined ? undefined : t(stepConfig.descriptionKey)

    return (
        <div className="fixed inset-0 p-0 flex flex-col w-full">
            <div className="h-full px-5 xs:mx-10 overflow-auto flex flex-col gap-4 items-center justify-center">
                <DlineLogo className="size-16 flex-shrink-0" color="white" />
                <h2 className="text-lg font-semibold p-0 flex-shrink-0">{stepTitle}</h2>
                {stepNumber === 2 && (
                    <div className="flex w-full max-w-lg flex-col gap-6 my-4 items-center">
                        {isActionLoading && <LoaderCircleIcon className="animate-spin" />}
                    </div>
                )}
                {stepDescription && (
                    <p className="text-foreground text-sm text-center m-0 p-0 flex-shrink-0">{stepDescription}</p>
                )}

                <div
                    className={cn("flex-1 w-full flex overflow-y-auto min-h-0", stepNumber === 1 ? "max-w-4xl" : "max-w-lg")}
                    data-testid="onboarding-step-content">
                    {stepNumber === 0 && (
                        <UserTypeSelectionStep onSelectUserType={onUserTypeClick} options={userTypeOptions} userType={userType} />
                    )}
                    {stepNumber === 1 && (
                        <div className="w-full">
                            <ApiConfigurationSection />
                        </div>
                    )}
                </div>

                <footer className="flex w-full max-w-lg flex-col gap-3 my-2 px-2 overflow-hidden flex-shrink-0">
                    {stepConfig.buttons.map((btn) => (
                        <Button
                            className={`w-full rounded-xs ${isActionLoading ? "animate-pulse" : ""}`}
                            disabled={isActionLoading}
                            key={btn.action}
                            onClick={() => handleFooterAction(btn.action)}
                            variant={btn.variant}>
                            {t(FOOTER_LABEL_KEYS[btn.action])}
                        </Button>
                    ))}

                    {stepNumber !== 2 && (
                        <div className="items-center justify-center flex text-sm text-foreground gap-2 mb-3 text-pretty">
                            <AlertCircleIcon className="shrink-0 size-2" /> {t("shell.onboarding.changeLater")}
                        </div>
                    )}
                </footer>
            </div>
        </div>
    )
}

export default OnboardingView
