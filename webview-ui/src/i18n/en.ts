import { en as capabilities } from "./locales/capabilities/en"
import { en as chatInput } from "./locales/chatInput/en"
import { en as chatRows } from "./locales/chatRows/en"
import { en as settings } from "./locales/settings/en"
import { en as shell } from "./locales/shell/en"

/** English is the key and named-argument baseline for product-owned UI text. */
export const en = {
    ...capabilities,
    ...chatInput,
    ...chatRows,
    ...settings,
    ...shell,
    "runtime.history.openFailed": ({ task }: { task: string }) => `Could not open task '${task}'.`,
    "runtime.hydration.unknown": "Unknown state subscription failure",
    "runtime.hydration.closed": "State subscription closed before any state arrived",
    "runtime.menu.position": ({ label, position, count }: { label: string; position: number; count: number }) =>
        `${label}, ${position} of ${count}`,
    "runtime.mentions.workingChanges": "Working changes",
    "runtime.mentions.uncommitted": "Current uncommitted changes",
    "runtime.mentions.commits": "Git Commits",
    "runtime.mentions.history": "Search repository history",
    "runtime.mentions.commit": ({ hash }: { hash: string }) => `Commit ${hash}`,
    "runtime.mentions.commitHash": "Git commit hash",
    "runtime.slash.newtask": "Create a new task with context from the current task",
    "runtime.slash.explainChanges": "Explain code changes between git refs (PRs, commits, branches, etc.)",
    "runtime.slash.deepPlanning": "Create a comprehensive implementation plan before coding",
    "runtime.slash.compact": "Condenses your current context window",
    "runtime.slash.newrule": "Create a new Cline rule based on your conversation",
    "runtime.slash.reportbug": "Create a Github issue with Cline",
    "runtime.slash.away": "Continue this task while you are away",
    "runtime.slash.mcpPrompt": ({ server }: { server: string }) => `MCP prompt from ${server}`,
    "runtime.validation.noProfile": ({ mode }: { mode: string }) => `No enabled profile found for ${mode} mode.`,
    "runtime.validation.apiKey": "You must provide a valid API key or choose a different provider.",
    "settings.title": "Settings",
    "settings.done": "Done",
    "settings.apiConfiguration.name": "API Configuration",
    "settings.apiConfiguration.tooltip": "API Configuration",
    "settings.apiConfiguration.heading": "API Configuration",
    "settings.features.name": "Features",
    "settings.features.tooltip": "Feature Settings",
    "settings.features.heading": "Feature Settings",
    "settings.browser.name": "Browser",
    "settings.browser.tooltip": "Browser Settings",
    "settings.browser.heading": "Browser Settings",
    "settings.terminal.name": "Terminal",
    "settings.terminal.tooltip": "Terminal Settings",
    "settings.terminal.heading": "Terminal Settings",
    "settings.general.name": "General",
    "settings.general.tooltip": "General Settings",
    "settings.general.heading": "General Settings",
    "settings.remoteConfig.name": "Remote Config",
    "settings.remoteConfig.tooltip": "Remotely configured fields",
    "settings.remoteConfig.heading": "Remote Config",
    "settings.about.name": "About",
    "settings.about.tooltip": "About Dline",
    "settings.about.heading": "About",
    "settings.debug.name": "Debug",
    "settings.debug.tooltip": "Debug Tools",
    "settings.debug.heading": "Debug",
    "settings.general.uiLanguage.label": "Interface language",
    "settings.general.uiLanguage.description": "Controls the Dline interface, not the model's response language.",
    "settings.general.uiLanguage.coverage": "Messages, code, tool output and external content keep their original language.",
    "settings.general.uiLanguage.auto": "Auto",
    "settings.general.uiLanguage.followHost": ({ language }: { language: string }) =>
        `Auto uses the VS Code display language (${language}).`,
    "settings.general.uiLanguage.saving": "Saving interface language…",
    "settings.general.uiLanguage.saveError": "Couldn't confirm the interface language update. Please try again.",
    "settings.general.uiLanguage.retry": "Retry",
    "settings.general.preferredLanguage.label": "Model response language",
    "settings.general.preferredLanguage.description":
        "Choose the language for model replies. Auto follows the language you use in your messages.",
    "settings.general.preferredLanguage.auto": "Auto",
    "settings.general.preferredLanguage.option.en": "English",
    "settings.general.preferredLanguage.option.ar": "Arabic",
    "settings.general.preferredLanguage.option.pt-BR": "Portuguese (Brazil)",
    "settings.general.preferredLanguage.option.cs": "Czech",
    "settings.general.preferredLanguage.option.fr": "French",
    "settings.general.preferredLanguage.option.de": "German",
    "settings.general.preferredLanguage.option.hi": "Hindi",
    "settings.general.preferredLanguage.option.hu": "Hungarian",
    "settings.general.preferredLanguage.option.it": "Italian",
    "settings.general.preferredLanguage.option.ja": "Japanese",
    "settings.general.preferredLanguage.option.ko": "Korean",
    "settings.general.preferredLanguage.option.pl": "Polish",
    "settings.general.preferredLanguage.option.pt-PT": "Portuguese (Portugal)",
    "settings.general.preferredLanguage.option.ru": "Russian",
    "settings.general.preferredLanguage.option.zh-CN": "Simplified Chinese",
    "settings.general.preferredLanguage.option.es": "Spanish",
    "settings.general.preferredLanguage.option.zh-TW": "Traditional Chinese",
    "settings.general.preferredLanguage.option.tr": "Turkish",
    "settings.general.chatInputSendShortcut.label": "Send messages with",
    "settings.general.chatInputSendShortcut.enter": "Enter",
    "settings.general.chatInputSendShortcut.ctrlEnter": "Ctrl + Enter",
    "settings.general.chatInputSendShortcut.shiftEnter": "Shift + Enter",
    "settings.general.aggressiveRendering.label": "Chat folding",
    "settings.general.aggressiveRendering.none": "No folding",
    "settings.general.aggressiveRendering.round": "Per request",
    "settings.general.aggressiveRendering.message_segment": "Per message segment",
    "settings.general.aggressiveRendering.user_turn": "Per user turn",
    "settings.general.aggressiveRendering.description":
        "Folded blocks show a summary and expand on click. Work that is still running stays visible; failed edits, commands and subagents join the block, and its summary states how many errors it holds.",
} as const

export type UiMessageKey = keyof typeof en
/** Mixed static/dynamic key unions must be narrowed before they can be translated. */
export type UiMessageArgs<K extends UiMessageKey> = (typeof en)[K] extends string
    ? []
    : (typeof en)[K] extends (...args: infer Args) => string
      ? Args
      : never

/** Widen literal strings while preserving every baseline function's named parameters. */
export type UiMessages = {
    readonly [K in UiMessageKey]: (typeof en)[K] extends (...args: infer Args) => string ? (...args: Args) => string : string
}
