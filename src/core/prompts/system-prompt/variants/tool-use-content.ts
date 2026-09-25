import { getPrompt } from "../../i18n"
import type { SystemSectionContentConfig } from "./section-content-config"

const LITE_TOOLS_NATIVE = getPrompt("variants.lite", "toolsNative")
const LITE_TOOLS_XML = getPrompt("variants.lite", "toolsXml")
const STANDARD_TOOL_USE_PREFIX = getPrompt("variants.standard", "toolUsePrefix")
const STANDARD_TOOL_USE_SUFFIX = getPrompt("variants.standard", "toolUseSuffix")
const PARALLEL_TOOL_USE = getPrompt("variants.standard", "parallelToolUse")

export function createStandardToolUse(config: SystemSectionContentConfig): string {
	return `${STANDARD_TOOL_USE_PREFIX}${config.parallelTools ? PARALLEL_TOOL_USE : ""}${STANDARD_TOOL_USE_SUFFIX}`
}

export function createLiteToolUse(config: SystemSectionContentConfig): string {
	return config.transport === "native" ? LITE_TOOLS_NATIVE : LITE_TOOLS_XML
}
