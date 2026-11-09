export interface QuickWinTask {
    id: string
    /**
     * Message keys for the card title and subtitle. The card resolves them while
     * rendering so a language switch updates the labels in place.
     */
    titleKey: "shell.welcome.quickWin.nextjs.title" | "shell.welcome.quickWin.cli.title" | "shell.welcome.quickWin.game.title"
    descriptionKey:
        | "shell.welcome.quickWin.nextjs.description"
        | "shell.welcome.quickWin.cli.description"
        | "shell.welcome.quickWin.game.description"
    icon?: string
    actionCommand: string
    /**
     * Task text sent to the model when the card is chosen.
     *
     * This is model input, not interface copy: it stays in the language the
     * product ships, and translating it would change what the model is asked.
     */
    prompt: string
    buttonText?: string
}

export const quickWinTasks: QuickWinTask[] = [
    {
        id: "nextjs_notetaking_app",
        titleKey: "shell.welcome.quickWin.nextjs.title",
        descriptionKey: "shell.welcome.quickWin.nextjs.description",
        icon: "WebAppIcon",
        actionCommand: "cline/createNextJsApp",
        prompt: "Make a beautiful Next.js notetaking app, using Tailwind CSS for styling. Set up the basic structure and a simple UI for adding and viewing notes.",
        buttonText: ">",
    },
    {
        id: "terminal_cli_tool",
        titleKey: "shell.welcome.quickWin.cli.title",
        descriptionKey: "shell.welcome.quickWin.cli.description",
        icon: "TerminalIcon",
        actionCommand: "cline/createCliTool",
        prompt: "Make a terminal CLI tool using Node.js that organizes files in a directory by type, size, or date. It should have options to sort files into folders, show file statistics, find duplicates, and clean up empty directories. Include colorful output and progress indicators.",
        buttonText: ">",
    },
    {
        id: "snake_game",
        titleKey: "shell.welcome.quickWin.game.title",
        descriptionKey: "shell.welcome.quickWin.game.description",
        icon: "GameIcon",
        actionCommand: "cline/createSnakeGame",
        prompt: "Make a classic Snake game using HTML, CSS, and JavaScript. The game should be playable in the browser, with keyboard controls for the snake, a scoring system, and a game over state.",
        buttonText: ">",
    },
]
