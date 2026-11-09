/**
 * First-run onboarding and the welcome/home surface product copy.
 *
 * Quick-win task titles and descriptions are shown to the user but their
 * `prompt` is model input; the prompts stay in `quickWinTasks.ts` untranslated.
 *
 * Complete rich sentences carry named React slots so translations can reorder
 * links and emphasis without stitching translated sentence fragments together.
 */
export const en = {
    "shell.onboarding.step0.title": "How will you use Dline?",
    "shell.onboarding.step0.description": "Select an option below to get started.",
    "shell.onboarding.byok.title": "Configure your provider",
    "shell.onboarding.account.title": "Almost there!",
    "shell.onboarding.account.description": "Complete login or sign up in your browser. Then come back here to finish up.",
    "shell.onboarding.button.continue": "Continue",
    "shell.onboarding.button.back": "Back",
    "shell.onboarding.changeLater": "You can change this later in settings",
    "shell.onboarding.userType.account.title": "Login / Sign up account",
    "shell.onboarding.userType.account.description": "Use Dline with your account",
    "shell.onboarding.userType.byok.title": "Bring your own API key",
    "shell.onboarding.userType.byok.description": "Use Dline with your provider of choice",

    "shell.welcome.heading": "What can I do for you?",
    "shell.welcome.headingLazy": "I guess I'm here to help",
    "shell.welcome.takeTour": "Take a Tour",
    "shell.welcome.quickWins.heading": "Quick {accent} with Dline",
    "shell.welcome.quickWins.accent": "[Wins]",

    "shell.welcome.quickWin.nextjs.title": "Build a Next.js App",
    "shell.welcome.quickWin.nextjs.description": "Create a beautiful notetaking app with Next.js and Tailwind",
    "shell.welcome.quickWin.cli.title": "Craft a CLI Tool",
    "shell.welcome.quickWin.cli.description": "Develop a powerful terminal CLI to automate a cool task",
    "shell.welcome.quickWin.game.title": "Develop a Game",
    "shell.welcome.quickWin.game.description": "Code a classic Snake game that runs in the browser.",

    "shell.welcome.legacy.intro": "Hi, I'm Dline",
    "shell.welcome.legacy.capability":
        "I can do all kinds of tasks thanks to breakthroughs in {model} agentic coding capabilities and access to tools that let me create & edit files, explore complex projects, use a browser, and execute terminal commands {permission}. I can even use MCP to create new tools and extend my own capabilities.",
    "shell.welcome.legacy.modelLink": "Claude 4.6 Sonnet's",
    "shell.welcome.legacy.permission": "(with your permission, of course)",
    "shell.welcome.legacy.signUp":
        "Sign up for an account to get started for free, or use an API key that provides access to models like Claude Sonnet.",
    "shell.welcome.legacy.getStarted": "Get Started for Free",
    "shell.welcome.legacy.useOwnKey": "Use your own API key",
    "shell.welcome.legacy.letsGo": "Let's go!",

    "shell.whatsNew.title": ({ version }: { version: string }) => `🎉 New in v${version}`,
    "shell.whatsNew.changelog": "See the {link} for every change.",
    "shell.whatsNew.changelogLink": "full changelog",
    "shell.whatsNew.starAria": "Star us on GitHub",
    "shell.whatsNew.star": "Please support Dline by {link}.",
    "shell.whatsNew.starLink": "starring us on GitHub",
} as const
