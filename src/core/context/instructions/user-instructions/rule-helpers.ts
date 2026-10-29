import { ensureRulesDirectoryExists, ensureWorkflowsDirectoryExists, GlobalFileNames } from "@core/storage/disk"
import { capabilityResourceId } from "@core/storage/settings/capability-resource-id"
import { type CapabilityScanResult, completeScan, incompleteScan } from "@core/storage/settings/capability-scan-result"
import { type CapabilityKind, clearCapabilityOverrideEverywhere } from "@core/storage/settings/capability-toggle-store"
import { removeGlobalCapability } from "@core/storage/settings/global-capability-settings"
import { ClineRulesToggles } from "@shared/cline-rules"
import { GlobalInstructionsFile } from "@shared/remote-config/schema"
import { fileExistsAtPath, isDirectory, readDirectory } from "@utils/fs"
import fs from "fs/promises"
import * as path from "path"
import { Controller } from "@/core/controller"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { Logger } from "@/shared/services/Logger"
import { parseYamlFrontmatter } from "./frontmatter"
import { evaluateRuleConditionals, RuleEvaluationContext } from "./rule-conditionals"

/**
 * Recursively traverses directory and finds all files, including checking for optional whitelisted file extension
 *
 * Reports whether the directory could be read. An unreadable directory yields
 * the same empty list as an empty one, so callers that act on absence need the
 * flag to tell the two apart.
 */
export async function readDirectoryRecursive(
    directoryPath: string,
    allowedFileExtension: string,
    excludedPaths: string[][] = [],
): Promise<CapabilityScanResult<string>> {
    try {
        const entries = await readDirectory(directoryPath, excludedPaths)
        const results: string[] = []
        for (const entry of entries) {
            if (allowedFileExtension !== "") {
                const fileExtension = path.extname(entry)
                if (fileExtension !== allowedFileExtension) {
                    continue
                }
            }
            results.push(entry)
        }
        return completeScan(results)
    } catch (error) {
        Logger.error(`Error reading directory ${directoryPath}: ${error}`)
        return incompleteScan([])
    }
}

/**
 * Gets the up to date toggles.
 *
 * Prefer {@link scanRuleToggles} where the outcome drives destructive or
 * display decisions: this wrapper drops the completeness flag, so a directory
 * that could not be read is indistinguishable from one that is empty.
 */
export async function synchronizeRuleToggles(
    rulesDirectoryPath: string,
    currentToggles: ClineRulesToggles,
    allowedFileExtension = "",
    excludedPaths: string[][] = [],
): Promise<ClineRulesToggles> {
    return (await scanRuleToggles(rulesDirectoryPath, currentToggles, allowedFileExtension, excludedPaths)).toggles
}

/** One rule-directory scan: the resulting toggles plus whether the scan is trustworthy. */
export interface RuleToggleScan {
    readonly toggles: ClineRulesToggles
    /**
     * True when the outcome reflects the filesystem.
     *
     * A missing path is complete ("nothing here"); a directory that failed to
     * read is not, because its resources are unknown rather than absent.
     */
    readonly complete: boolean
}

/** Scan one rule directory and report both the toggles and the scan's trustworthiness. */
export async function scanRuleToggles(
    rulesDirectoryPath: string,
    currentToggles: ClineRulesToggles,
    allowedFileExtension = "",
    excludedPaths: string[][] = [],
): Promise<RuleToggleScan> {
    const startedAt = performance.now()
    let discoveredFiles = 0
    let pathKind = "missing"
    let complete = true
    // Create a copy of toggles to modify
    const updatedToggles = { ...currentToggles }

    try {
        const pathExists = await fileExistsAtPath(rulesDirectoryPath)

        if (pathExists) {
            const isDir = await isDirectory(rulesDirectoryPath)

            if (isDir) {
                pathKind = "directory"
                // DIRECTORY CASE
                const scan = await readDirectoryRecursive(rulesDirectoryPath, allowedFileExtension, excludedPaths)
                const filePaths = scan.items
                complete = scan.complete
                discoveredFiles = filePaths.length
                const existingRulePaths = new Set<string>()

                for (const filePath of filePaths) {
                    const ruleFilePath = path.resolve(rulesDirectoryPath, filePath)
                    existingRulePaths.add(ruleFilePath)

                    const pathHasToggle = ruleFilePath in updatedToggles
                    if (!pathHasToggle) {
                        updatedToggles[ruleFilePath] = true
                    }
                }

                // Clean up toggles for non-existent files
                for (const togglePath in updatedToggles) {
                    const pathExists = existingRulePaths.has(togglePath)
                    if (!pathExists) {
                        delete updatedToggles[togglePath]
                    }
                }
            } else {
                pathKind = "file"
                discoveredFiles = 1
                // FILE CASE
                // Add toggle for this file
                const pathHasToggle = rulesDirectoryPath in updatedToggles
                if (!pathHasToggle) {
                    updatedToggles[rulesDirectoryPath] = true
                }

                // Remove toggles for any other paths
                for (const togglePath in updatedToggles) {
                    if (togglePath !== rulesDirectoryPath) {
                        delete updatedToggles[togglePath]
                    }
                }
            }
        } else {
            // PATH DOESN'T EXIST CASE
            // Clear all toggles since the path doesn't exist
            for (const togglePath in updatedToggles) {
                delete updatedToggles[togglePath]
            }
        }
    } catch (error) {
        Logger.error(`Failed to synchronize rule toggles for path: ${rulesDirectoryPath}`, error)
        complete = false
    }

    recordPerfPhase(PerfDomain.Capability, "rule_toggle_scan", performance.now() - startedAt, {
        kind: pathKind,
        files: discoveredFiles,
        toggles: Object.keys(updatedToggles).length,
        extension: allowedFileExtension || "any",
        complete,
    })
    if (Logger.isDebugEnabled()) {
        Logger.debug(
            `[CapabilityPerf] phase=rule_toggle_scan durationMs=${Math.round(performance.now() - startedAt)} kind=${pathKind} files=${discoveredFiles} toggles=${Object.keys(updatedToggles).length} extension=${allowedFileExtension || "any"} complete=${complete}`,
        )
    }
    return { toggles: updatedToggles, complete }
}

/**
 * Synchronizes remote rule toggles with current remote config
 * Removes toggles for rules that no longer exist, adds defaults for new rules
 */
export function synchronizeRemoteRuleToggles(
    remoteRules: GlobalInstructionsFile[],
    currentToggles: ClineRulesToggles,
): ClineRulesToggles {
    const updatedToggles: ClineRulesToggles = {}

    // Create set of current remote rule names
    const existingRuleNames = new Set(remoteRules.map((rule) => rule.name))

    // Keep toggles only for rules that still exist
    for (const [ruleName, enabled] of Object.entries(currentToggles)) {
        if (existingRuleNames.has(ruleName)) {
            updatedToggles[ruleName] = enabled
        }
    }

    // Add default toggles for new rules (default to enabled)
    for (const rule of remoteRules) {
        if (!(rule.name in updatedToggles)) {
            updatedToggles[rule.name] = true
        }
    }

    return updatedToggles
}

/**
 * Certain project rules have more than a single location where rules are allowed to be stored
 */
export function combineRuleToggles(toggles1: ClineRulesToggles, toggles2: ClineRulesToggles): ClineRulesToggles {
    return { ...toggles1, ...toggles2 }
}

/**
 * Read the content of rules files
 */
export const getRuleFilesTotalContent = async (rulesFilePaths: string[], basePath: string, toggles: ClineRulesToggles) => {
    return (await getRuleFilesTotalContentWithMetadata(rulesFilePaths, basePath, toggles)).content
}

export type ActivatedConditionalRule = {
    name: string
    matchedConditions: Record<string, string[]>
}

// Prefixes used to make activated conditional rule identifiers self-explanatory in the UI.
// NOTE: These are display identifiers (not toggle keys).
export const RULE_SOURCE_PREFIX = {
    workspace: "workspace",
    global: "global",
    remote: "remote",
} as const

export type RuleLoadResult = {
    content: string
    activatedConditionalRules: ActivatedConditionalRule[]
}

/**
 * Result type for rule loading functions that return formatted instructions.
 * Used by getGlobalClineRules and getLocalClineRules.
 */
export type RuleLoadResultWithInstructions = {
    instructions?: string
    activatedConditionalRules: ActivatedConditionalRule[]
}

export const getRuleFilesTotalContentWithMetadata = async (
    rulesFilePaths: string[],
    basePath: string,
    toggles: ClineRulesToggles,
    opts?: { evaluationContext?: RuleEvaluationContext; ruleNamePrefix?: keyof typeof RULE_SOURCE_PREFIX },
): Promise<RuleLoadResult> => {
    const evaluationContext = opts?.evaluationContext ?? {}
    const prefix = RULE_SOURCE_PREFIX[opts?.ruleNamePrefix ?? "global"]

    type RuleLoadPart = {
        contentPart: string | null
        activatedRule: ActivatedConditionalRule | null
    }

    const parts = await Promise.all(
        rulesFilePaths.map(async (filePath) => {
            const ruleFilePath = path.resolve(basePath, filePath)
            const ruleFilePathRelative = path.relative(basePath, ruleFilePath)

            if (ruleFilePath in toggles && toggles[ruleFilePath] === false) {
                return { contentPart: null, activatedRule: null }
            }

            const raw = (await fs.readFile(ruleFilePath, "utf8")).trim()
            if (!raw) {
                return { contentPart: null, activatedRule: null }
            }
            const { data, body, hadFrontmatter, parseError } = parseYamlFrontmatter(raw)
            // YAML parse errors are treated as fail-open.
            // NOTE: We intentionally preserve the raw frontmatter fence/content here so the LLM can still
            // see the author's intended scoping (e.g., `paths:`) and reason about it, even if it cannot be
            // evaluated reliably due to invalid YAML.
            if (hadFrontmatter && parseError) {
                return { contentPart: `${ruleFilePathRelative}\n${raw}`, activatedRule: null }
            }

            const { passed, matchedConditions } = evaluateRuleConditionals(data, evaluationContext)
            if (!passed) {
                return { contentPart: null, activatedRule: null }
            }
            const activatedRule =
                hadFrontmatter && Object.keys(matchedConditions).length > 0
                    ? { name: `${prefix}:${ruleFilePathRelative}`, matchedConditions }
                    : null

            return { contentPart: `${ruleFilePathRelative}\n${body.trim()}`, activatedRule }
        }),
    )

    return {
        content: parts
            .map((p) => p.contentPart)
            .filter(Boolean)
            .join("\n\n"),
        activatedConditionalRules: parts
            .map((p) => p.activatedRule)
            .filter((rule): rule is ActivatedConditionalRule => rule !== null),
    }
}

export function getRemoteRulesTotalContentWithMetadata(
    remoteRules: GlobalInstructionsFile[],
    remoteToggles: ClineRulesToggles,
    opts?: { evaluationContext?: RuleEvaluationContext },
): RuleLoadResult {
    const activatedConditionalRules: ActivatedConditionalRule[] = []
    const evaluationContext = opts?.evaluationContext ?? {}
    let combinedContent = ""

    for (const rule of remoteRules) {
        const isEnabled = rule.alwaysEnabled || remoteToggles[rule.name] !== false
        if (!isEnabled) continue

        const raw = (rule.contents || "").trim()
        if (!raw) continue

        const { data, body, hadFrontmatter, parseError } = parseYamlFrontmatter(raw)
        if (hadFrontmatter && parseError) {
            // Fail open: include entire raw contents
            if (combinedContent) combinedContent += "\n\n"
            combinedContent += `${rule.name}\n${raw}`
            continue
        }

        const { passed, matchedConditions } = evaluateRuleConditionals(data, evaluationContext)
        if (!passed) continue

        if (hadFrontmatter && Object.keys(matchedConditions).length > 0) {
            activatedConditionalRules.push({ name: `${RULE_SOURCE_PREFIX.remote}:${rule.name}`, matchedConditions })
        }

        if (combinedContent) combinedContent += "\n\n"
        combinedContent += `${rule.name}\n${body.trim()}`
    }

    return { content: combinedContent, activatedConditionalRules }
}

/**
 * Handles converting any directory into a file (specifically used for .clinerules and .clinerules/workflows)
 * The old .clinerules file or .clinerules/workflows file will be renamed to a default filename
 * Doesn't do anything if the dir already exists or doesn't exist
 * Returns whether there are any uncaught errors
 */
export async function ensureLocalClineDirExists(clinerulePath: string, defaultRuleFilename: string): Promise<boolean> {
    try {
        const exists = await fileExistsAtPath(clinerulePath)

        if (exists && !(await isDirectory(clinerulePath))) {
            // logic to convert .clinerules file into directory, and rename the rules file to {defaultRuleFilename}
            const content = await fs.readFile(clinerulePath, "utf8")
            const tempPath = `${clinerulePath}.bak`
            await fs.rename(clinerulePath, tempPath) // create backup
            try {
                await fs.mkdir(clinerulePath, { recursive: true })
                await fs.writeFile(path.join(clinerulePath, defaultRuleFilename), content, "utf8")
                await fs.unlink(tempPath).catch(() => {}) // delete backup

                return false // conversion successful with no errors
            } catch (_conversionError) {
                // attempt to restore backup on conversion failure
                try {
                    await fs.rm(clinerulePath, { recursive: true, force: true }).catch(() => {})
                    await fs.rename(tempPath, clinerulePath) // restore backup
                } catch (_restoreError) {}
                return true // in either case here we consider this an error
            }
        }
        // exists and is a dir or doesn't exist, either of these cases we dont need to handle here
        return false
    } catch (_error) {
        return true
    }
}

/**
 * Create a rule file or workflow file
 */
export const createRuleFile = async (isGlobal: boolean, filename: string, cwd: string, type: string) => {
    try {
        let filePath: string
        if (isGlobal) {
            if (type === "workflow") {
                const globalWorkflowsFilePath = await ensureWorkflowsDirectoryExists()
                filePath = path.join(globalWorkflowsFilePath, filename)
            } else {
                const globalClineRulesFilePath = await ensureRulesDirectoryExists()
                filePath = path.join(globalClineRulesFilePath, filename)
            }
        } else {
            // Create only the directory the new file belongs to; workflows and
            // rules live in sibling roots under .agents/.
            const localDirectory =
                type === "workflow"
                    ? path.resolve(cwd, GlobalFileNames.agentsWorkflowsDir)
                    : path.resolve(cwd, GlobalFileNames.agentsRulesDir)
            await fs.mkdir(localDirectory, { recursive: true })
            filePath = path.join(localDirectory, filename)
        }

        const fileExists = await fileExistsAtPath(filePath)

        if (fileExists) {
            return { filePath, fileExists }
        }

        await fs.writeFile(filePath, "", "utf8")

        return { filePath, fileExists: false }
    } catch (_error) {
        return { filePath: null, fileExists: false }
    }
}

/** Maps the caller's rule family to the capability kind that stores its toggles. */
const LOCAL_RULE_CAPABILITY_KIND: Readonly<Record<string, CapabilityKind>> = {
    workflow: "workflows",
    cursor: "cursorRules",
    windsurf: "windsurfRules",
    agents: "agentsRules",
}

/**
 * Delete a rule file or workflow file
 */
export async function deleteRuleFile(
    controller: Controller,
    rulePath: string,
    isGlobal: boolean,
    type: string,
): Promise<{ success: boolean; message: string }> {
    try {
        // Check if file exists
        const fileExists = await fileExistsAtPath(rulePath)
        if (!fileExists) {
            return {
                success: false,
                message: `File does not exist: ${rulePath}`,
            }
        }

        // Delete the file from disk
        await fs.rm(rulePath, { force: true })

        // Get the filename for messages
        const fileName = path.basename(rulePath)

        // Update the appropriate toggles
        if (isGlobal) {
            await removeGlobalCapability(
                controller.stateManager,
                type === "workflow" ? "globalWorkflowToggles" : "globalClineRulesToggles",
                rulePath,
            )
        } else {
            // The file is gone, so its override in every scope is now an orphan.
            // Dropping all of them keeps a later file with the same path from
            // inheriting a preference the user set for a different file.
            await clearCapabilityOverrideEverywhere(
                controller.stateManager,
                LOCAL_RULE_CAPABILITY_KIND[type] ?? "rules",
                capabilityResourceId(rulePath),
            )
        }

        return {
            success: true,
            message: `File "${fileName}" deleted successfully`,
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        Logger.error(`Error deleting file: ${errorMessage}`, error)
        return {
            success: false,
            message: `Failed to delete file.`,
        }
    }
}
