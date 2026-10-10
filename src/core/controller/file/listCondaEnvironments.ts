import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { StringArray } from "@shared/proto/dline/common"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."

const execFileAsync = promisify(execFile)

interface CondaEnvironmentList {
    envs?: unknown
    envs_details?: unknown
    root_prefix?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

/** Convert `conda info --envs --json` output into stable display names. */
export function parseCondaEnvironmentNames(stdout: string): string[] {
    const parsed: unknown = JSON.parse(stdout)
    if (!isRecord(parsed)) return []
    const environments = (parsed as CondaEnvironmentList).envs
    if (!Array.isArray(environments)) return []
    const environmentDetails = (parsed as CondaEnvironmentList).envs_details
    const rootPrefix = (parsed as CondaEnvironmentList).root_prefix
    const normalizedRootPrefix =
        typeof rootPrefix === "string"
            ? rootPrefix
                  .replace(/[\\/]+$/, "")
                  .replaceAll("\\", "/")
                  .toLowerCase()
            : undefined

    const entries = environments
        .filter((environment): environment is string => typeof environment === "string" && environment.trim().length > 0)
        .map((environment) => {
            const details = isRecord(environmentDetails) ? environmentDetails[environment] : undefined
            const normalized = environment.replace(/[\\/]+$/, "")
            const separator = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"))
            const fallbackName =
                normalized.replaceAll("\\", "/").toLowerCase() === normalizedRootPrefix
                    ? "base"
                    : separator >= 0
                      ? normalized.slice(separator + 1)
                      : normalized
            const name =
                isRecord(details) && typeof details.name === "string" && details.name.trim() ? details.name.trim() : fallbackName
            return {
                active: isRecord(details) && details.active === true,
                base: name === "base" || (isRecord(details) && details.base === true),
                name,
            }
        })
        .sort((left, right) => {
            if (left.active !== right.active) return left.active ? -1 : 1
            if (left.base !== right.base) return left.base ? -1 : 1
            return left.name.localeCompare(right.name)
        })

    return [...new Set(entries.map((entry) => entry.name))]
}

export async function listCondaEnvironments(_controller: Controller): Promise<StringArray> {
    try {
        const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "conda"
        const args = process.platform === "win32" ? ["/d", "/s", "/c", "conda info --envs --json"] : ["info", "--envs", "--json"]
        const { stdout } = await execFileAsync(command, args, {
            env: process.env,
            maxBuffer: 1024 * 1024,
            timeout: 10_000,
            windowsHide: true,
        })
        return StringArray.create({ values: parseCondaEnvironmentNames(stdout) })
    } catch (error) {
        Logger.error("Failed to list Conda environments:", error)
        return StringArray.create({ values: [] })
    }
}
