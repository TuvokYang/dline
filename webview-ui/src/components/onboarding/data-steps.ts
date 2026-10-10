export enum NEW_USER_TYPE {
    ACCOUNT = "account",
    BYOK = "byok",
}

type UserTypeSelection = {
    title: string
    description: string
    type: NEW_USER_TYPE
}

export const STEP_CONFIG = {
    0: {
        title: "How will you use Dline?",
        description: "Select an option below to get started.",
        buttons: [{ text: "Continue", action: "next", variant: "default" }],
    },
    [NEW_USER_TYPE.BYOK]: {
        title: "Configure your provider",
        description: undefined,
        buttons: [
            { text: "Continue", action: "done", variant: "default" },
            { text: "Back", action: "back", variant: "secondary" },
        ],
    },
    2: {
        title: "Almost there!",
        description: "Complete login or sign up in your browser. Then come back here to finish up.",
        buttons: [{ text: "Back", action: "back", variant: "secondary" }],
    },
} as const

export const USER_TYPE_SELECTIONS: UserTypeSelection[] = [
    { title: "Login / Sign up account", description: "Use Dline with your account", type: NEW_USER_TYPE.ACCOUNT },
    { title: "Bring your own API key", description: "Use Dline with your provider of choice", type: NEW_USER_TYPE.BYOK },
]
