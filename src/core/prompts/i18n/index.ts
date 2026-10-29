import type { LanguageKey } from "@shared/Languages"
import { Logger } from "@/shared/services/Logger"
import { RuntimePromptGenerator } from "../generators/RuntimePromptGenerator"
import type { PromptEnv } from "../template/types"
import { englishPrompts, englishTemplateStore } from "./en"
import { simplifiedChinesePrompts } from "./zh-CN"

type PromptModule = Record<string, string>
type LanguagePack = Record<string, PromptModule>

const registry: Record<string, LanguagePack> = {
    en: englishPrompts,
    "zh-CN": simplifiedChinesePrompts,
}
const runtimeGenerator = new RuntimePromptGenerator(englishTemplateStore)

/**
 * Validate that a non-English language pack has all the same modules
 * and keys as the English reference. Returns missing entries.
 */
export function validateLangCompleteness(lang: string): string[] {
    const enPack = registry.en
    const langPack = registry[lang]
    if (!langPack) {
        return [`Language '${lang}' not registered`]
    }

    const missing: string[] = []
    for (const [moduleName, enModule] of Object.entries(enPack)) {
        const langModule = langPack[moduleName]
        if (!langModule) {
            missing.push(`Missing module: ${moduleName}`)
            continue
        }
        for (const key of Object.keys(enModule)) {
            if (!(key in langModule)) {
                missing.push(`Missing key: ${moduleName}.${key}`)
            }
        }
    }
    return missing
}

export function registerPrompts(lang: string, moduleName: string, prompts: PromptModule): void {
    if (!registry[lang]) {
        registry[lang] = {}
    }
    registry[lang][moduleName] = prompts
}

export function getPrompt(module: string, key: string, lang: LanguageKey = "en"): string {
    const effectiveLang = lang

    // Try the requested language first, then fall back to English
    const prompts = registry[effectiveLang]?.[module]
    const enPrompts = registry.en[module] ?? prompts
    const missingKey = `[MISSING: ${module}.${key}]`
    if (!prompts?.[key] && !enPrompts?.[key]) {
        Logger.warn(`[i18n] Missing prompt: ${module}.${key}`)
    }
    return prompts?.[key] ?? enPrompts?.[key] ?? missingKey
}

/** Renders one statically registered English prompt through the immutable runtime environment chain. */
export function renderPrompt(module: string, key: string, env: PromptEnv = {}): string {
    return runtimeGenerator.generate(`${module}.${key}`, env).text
}
