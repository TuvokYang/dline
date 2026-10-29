import { createPromptRegistry } from "../helpers/create-pack"

import { commandPromptModules } from "./commands/index"
import { systemPromptModules } from "./system/index"
import { toolPromptModules } from "./tools/index"
import { variantPromptModules } from "./variants/index"

const englishRegistry = createPromptRegistry(
    ...systemPromptModules,
    ...toolPromptModules,
    ...commandPromptModules,
    ...variantPromptModules,
)

export const englishPromptGroups = englishRegistry.groups
export const englishPrompts = englishRegistry.pack
export const englishTemplateStore = englishRegistry.store
