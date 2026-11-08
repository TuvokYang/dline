import type { UiMessageKey } from "@/i18n/messages"

export enum NEW_USER_TYPE {
    ACCOUNT = "account",
    BYOK = "byok",
}

type UserTypeSelection = {
    type: NEW_USER_TYPE
}

/** Footer button identity, action and variant. The label is a message key resolved while rendering. */
type StepButton = {
    action: "next" | "back" | "done"
    variant: "default" | "secondary"
}

/**
 * One onboarding step.
 *
 * The step keeps only stable identities - its title/description message keys
 * and its button actions - so the same configuration drives every language and
 * the footer never needs to parse display text to decide what a button does.
 */
type StepConfig = {
    titleKey: Extract<UiMessageKey, `shell.onboarding.${string}.title`>
    descriptionKey?: Extract<UiMessageKey, `shell.onboarding.${string}.description`>
    buttons: readonly StepButton[]
}

const STEP_ZERO: StepConfig = {
    titleKey: "shell.onboarding.step0.title",
    descriptionKey: "shell.onboarding.step0.description",
    buttons: [{ action: "next", variant: "default" }],
}

const STEP_BYOK: StepConfig = {
    titleKey: "shell.onboarding.byok.title",
    buttons: [
        { action: "done", variant: "default" },
        { action: "back", variant: "secondary" },
    ],
}

const STEP_ACCOUNT_LOGIN: StepConfig = {
    titleKey: "shell.onboarding.account.title",
    descriptionKey: "shell.onboarding.account.description",
    buttons: [{ action: "back", variant: "secondary" }],
}

/**
 * Select the step configuration for the current step number.
 * @param stepNumber Current onboarding step.
 * @returns The step's title/description keys and its footer actions.
 */
export function stepConfigOf(stepNumber: number): StepConfig {
    if (stepNumber === 0) return STEP_ZERO
    if (stepNumber === 2) return STEP_ACCOUNT_LOGIN
    return STEP_BYOK
}

export const USER_TYPE_OPTIONS: UserTypeSelection[] = [{ type: NEW_USER_TYPE.ACCOUNT }, { type: NEW_USER_TYPE.BYOK }]
