import inputQueue from "./system/inputQueue"

/** Deliberately partial language pack; the registry falls back to English per module/key. */
export const simplifiedChinesePrompts: Record<string, Record<string, string>> = {
    inputQueue,
}
