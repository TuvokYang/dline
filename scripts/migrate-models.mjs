/**
 * Migrates flat ModelInfo objects in src/core/api/providers/models/*.ts to layered structure.
 * Run: node --max-old-space-size=512 scripts/migrate-models.mjs
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const modelsDir = path.resolve(__dirname, "..", "src", "core", "api", "providers", "models")
const files = fs.readdirSync(modelsDir).filter((f) => f.endsWith(".ts"))

const CAP_KEYS = new Set([
    "maxTokens",
    "contextWindow",
    "supportsImages",
    "supportsPromptCache",
    "supportsReasoning",
    "supportsGlobalEndpoint",
])
const PRICE_KEYS = new Set(["inputPrice", "outputPrice", "cacheWritesPrice", "cacheReadsPrice", "currency"])
const _TOP_KEYS = new Set([
    "id",
    "name",
    "description",
    "temperature",
    "apiFormat",
    "isR1FormatRequired",
    "systemRole",
    "supportsTools",
    "supportsStreaming",
    "supportsReasoningEffort",
    "reasoningEffortOptions",
    "modelName",
    "surveyId",
    "banner",
    "surveyContent",
])

let totalChanged = 0

for (const file of files) {
    const fp = path.join(modelsDir, file)
    const content = fs.readFileSync(fp, "utf8")

    // Find all model objects: lines like /^\t\t\w+: \{/ followed by fields
    const lines = content.split("\n")
    const outLines = []
    let i = 0
    while (i < lines.length) {
        const line = lines[i]
        // Match start of a model object (e.g., `\t\t"deepseek-v4-pro": {`)
        const modelStartMatch = line.match(/^(\t+)(["\w-]+):\s*\{/)
        if (modelStartMatch) {
            const baseIndent = modelStartMatch[1]
            const modelKey = modelStartMatch[2]
            const fieldIndent = `${baseIndent}\t`
            const closeIndent = `${baseIndent}`

            // Collect fields until closing brace at same indent
            const fields = []
            let j = i + 1
            let depth = 1
            while (j < lines.length && depth > 0) {
                const l = lines[j]
                depth += (l.match(/\{/g) || []).length
                depth -= (l.match(/\}/g) || []).length
                if (depth > 0) fields.push(l)
                j++
            }
            const endIdx = j // line with closing }

            // Parse collected fields
            const capFields = []
            const priceFields = []
            const topFields = []
            let thinkingField = null
            let tiersField = null
            let inThinking = false,
                thinkingLines = []
            let inTiers = false,
                tiersLines = []

            for (const fl of fields) {
                const trimmed = fl.trim().replace(/,\s*$/, "")
                if (trimmed.match(/^thinkingConfig:\s*\{/)) {
                    inThinking = true
                    thinkingLines = [fl]
                    continue
                }
                if (inThinking) {
                    thinkingLines.push(fl)
                    if (fl.includes("}")) {
                        inThinking = false
                        thinkingField = thinkingLines
                    }
                    continue
                }
                if (trimmed.match(/^tiers:\s*\[/)) {
                    inTiers = true
                    tiersLines = [fl]
                    continue
                }
                if (inTiers) {
                    tiersLines.push(fl)
                    if (fl.includes("]")) {
                        inTiers = false
                        tiersField = tiersLines
                    }
                    continue
                }
                const kv = trimmed.match(/^(\w+):\s*(.+)/)
                if (kv) {
                    const key = kv[1],
                        _val = kv[2]
                    if (CAP_KEYS.has(key)) capFields.push(fl)
                    else if (PRICE_KEYS.has(key)) priceFields.push(fl)
                    else topFields.push(fl)
                } else if (trimmed) {
                    topFields.push(fl)
                }
            }

            // Check if any capability or pricing fields exist
            const hasCaps = capFields.length > 0
            const hasPricing = priceFields.length > 0 || tiersField

            if (!hasCaps && !hasPricing) {
                // No change needed, output original lines
                outLines.push(...lines.slice(i, endIdx))
            } else {
                // Rebuild
                outLines.push(`${baseIndent}${modelKey}: {`)

                // Top fields first (id, name, description, etc.)
                for (const f of topFields) outLines.push(f)

                // Capabilities
                if (hasCaps) {
                    outLines.push(`${fieldIndent}capabilities: {`)
                    for (const f of capFields) outLines.push(f)
                    // Add thinking if present
                    if (thinkingField) {
                        for (const tl of thinkingField) outLines.push(tl)
                    }
                    outLines.push(`${fieldIndent}},`)
                }

                // Pricing
                if (hasPricing) {
                    outLines.push(`${fieldIndent}pricing: {`)
                    for (const f of priceFields) outLines.push(f)
                    if (tiersField) {
                        for (const tl of tiersField) outLines.push(tl)
                    }
                    outLines.push(`${fieldIndent}},`)
                }

                outLines.push(`${closeIndent}},`)
            }
            i = endIdx
            totalChanged++
        } else {
            outLines.push(line)
            i++
        }
    }

    if (totalChanged > 0) {
        fs.writeFileSync(fp, outLines.join("\n"), "utf8")
    }
}

console.log(`Migrated ${totalChanged} models across ${files.length} files.`)
