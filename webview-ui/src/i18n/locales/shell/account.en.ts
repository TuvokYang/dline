/**
 * Account view, credit balance and billing history wrappers.
 *
 * Organization names, roles coming from the account service, currency figures
 * and timestamps remain data. Only product-owned labels are translated.
 */
export const en = {
    "shell.account.title": "Account",
    "shell.account.personal": "Personal",
    "shell.account.role": "Role",
    "shell.account.roleLocked": "This cannot be changed while your organization has remote configuration enabled.",
    "shell.account.dashboard": "Dashboard",
    "shell.account.logOut": "Log out",
    "shell.account.environment": "Dline Environment",
    "shell.account.optOutRemoteConfig": "Opt out of remote config",

    "shell.account.welcome.description":
        "Sign up for an account to get access to the latest models, billing dashboard to view usage and credits, and more upcoming features.",
    "shell.account.welcome.signUp": "Sign up with Dline",
    "shell.account.welcome.legal": "By continuing, you agree to the {terms} and {privacy}.",
    "shell.account.welcome.terms": "Terms of Service",
    "shell.account.welcome.privacy": "Privacy Policy",

    "shell.account.credits.label": "CURRENT BALANCE",
    "shell.account.credits.lastUpdated": ({ time }: { time: string }) => `Last updated: ${time}`,
    "shell.account.credits.add": "Add Credits",

    "shell.account.history.usageTab": "USAGE HISTORY",
    "shell.account.history.paymentsTab": "PAYMENTS HISTORY",
    "shell.account.history.loading": "Loading...",
    "shell.account.history.date": "Date",
    "shell.account.history.model": "Model",
    "shell.account.history.creditsUsed": "Credits Used",
    "shell.account.history.totalCost": "Total Cost",
    "shell.account.history.credits": "Credits",
    "shell.account.history.webSearch": "Web Search",
    "shell.account.history.webFetch": "Web Fetch",
    "shell.account.history.webFetchLlm": "Web Fetch (LLM)",
    "shell.account.history.emptyUsage": "No usage history",
    "shell.account.history.emptyPayments": "No payment history",

    "shell.account.role.owner": "Owner",
    "shell.account.role.admin": "Admin",
    "shell.account.role.member": "Member",
} as const
