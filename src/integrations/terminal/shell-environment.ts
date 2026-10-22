import { createHash } from "node:crypto"
import { readFile, stat, unlink } from "node:fs/promises"
import path from "node:path"
import { load as parseYaml } from "js-yaml"
import { Logger } from "@/shared/services/Logger"
import { resolveTerminalProfileId } from "@/utils/shell"
import { INTERNAL_COMMAND_EXIT_MARKER_PREFIX } from "./command-completion-marker"

const CONFIG_RELATIVE_PATH = path.join(".agents", "bashrc.yml")
const PLATFORM_NAMES = ["win32", "linux", "darwin"] as const
const POWERSHELL_PROFILES = new Set(["default", "powershell", "powershell-7", "powershell-legacy"])

type EnvironmentMap = Record<string, string | null>

export interface ProfileConfiguration {
    environment: EnvironmentMap
    startupScripts: string[]
    preCommands: string[]
    postCommand?: string
}

export interface PlatformConfiguration {
    environment: EnvironmentMap
    profiles: Record<string, ProfileConfiguration>
}

export interface ShellEnvironmentConfiguration {
    environment: EnvironmentMap
    platforms: Partial<Record<(typeof PLATFORM_NAMES)[number], PlatformConfiguration>>
}

export interface ResolvedShellEnvironment {
    readonly workspaceRoot: string
    readonly configPath: string
    readonly configurationId: string
    readonly environment: Readonly<EnvironmentMap>
    readonly startupScripts: readonly string[]
    readonly preCommands: readonly string[]
    readonly postCommand?: string
}

export interface ShellEnvironmentCommandOptions {
    readonly command: string
    readonly startupScripts?: readonly string[]
    readonly preCommands?: readonly string[]
    readonly postCommand?: string
    readonly profile: string
    readonly diagnosticsPath: string
    /** Exit the spawned shell with the user command status instead of preserving an interactive shell. */
    readonly terminateShell?: boolean
    /** Emit an internal marker so a persistent terminal can report the preserved user-command status. */
    readonly completionMarkerToken?: string
    readonly platform?: NodeJS.Platform
}

interface ShellEnvironmentConfigLoaderOptions {
    readonly workspaceRoots: readonly string[]
    readonly platform?: NodeJS.Platform
    readonly environment?: NodeJS.ProcessEnv
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key))
    if (unknown) throw new Error(`${context} contains unsupported field: ${unknown}`)
}

function parseEnvironment(value: unknown, context: string): EnvironmentMap {
    if (value === undefined) return {}
    if (!isRecord(value)) throw new Error(`${context} must be a mapping`)
    const environment: EnvironmentMap = {}
    for (const [name, entry] of Object.entries(value)) {
        if (entry === null) {
            environment[name] = null
        } else if (["string", "number", "boolean"].includes(typeof entry)) {
            environment[name] = String(entry)
        } else {
            throw new Error(`${context}.${name} must be a scalar or null`)
        }
    }
    return environment
}

function parseStringList(value: unknown, context: string): string[] {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
        throw new Error(`${context} must be a list of non-empty strings`)
    }
    return value as string[]
}

function parseProfile(value: unknown, context: string): ProfileConfiguration {
    if (!isRecord(value)) throw new Error(`${context} must be a mapping`)
    assertKnownKeys(value, ["environment", "startupScripts", "preCommands", "postCommand"], context)
    if (value.postCommand !== undefined && (typeof value.postCommand !== "string" || value.postCommand.trim().length === 0)) {
        throw new Error(`${context}.postCommand must be a non-empty string`)
    }
    return {
        environment: parseEnvironment(value.environment, `${context}.environment`),
        startupScripts: parseStringList(value.startupScripts, `${context}.startupScripts`),
        preCommands: parseStringList(value.preCommands, `${context}.preCommands`),
        postCommand: value.postCommand as string | undefined,
    }
}

function parsePlatform(value: unknown, context: string): PlatformConfiguration {
    if (!isRecord(value)) throw new Error(`${context} must be a mapping`)
    assertKnownKeys(value, ["environment", "profiles"], context)
    if (value.profiles !== undefined && !isRecord(value.profiles)) throw new Error(`${context}.profiles must be a mapping`)
    const profiles: Record<string, ProfileConfiguration> = {}
    for (const [profile, profileValue] of Object.entries(value.profiles ?? {})) {
        profiles[profile] = parseProfile(profileValue, `${context}.profiles.${profile}`)
    }
    return {
        environment: parseEnvironment(value.environment, `${context}.environment`),
        profiles,
    }
}

export function parseShellEnvironmentConfiguration(value: unknown): ShellEnvironmentConfiguration {
    if (!isRecord(value)) throw new Error("configuration must be a mapping")
    assertKnownKeys(value, ["version", "environment", "platforms"], "configuration")
    if (value.version !== 1) throw new Error("configuration.version must be 1")
    if (value.platforms !== undefined && !isRecord(value.platforms)) throw new Error("configuration.platforms must be a mapping")
    const platforms: ShellEnvironmentConfiguration["platforms"] = {}
    for (const [platform, platformValue] of Object.entries(value.platforms ?? {})) {
        if (!PLATFORM_NAMES.includes(platform as (typeof PLATFORM_NAMES)[number])) {
            throw new Error(`configuration.platforms contains unsupported platform: ${platform}`)
        }
        platforms[platform as (typeof PLATFORM_NAMES)[number]] = parsePlatform(
            platformValue,
            `configuration.platforms.${platform}`,
        )
    }
    return {
        environment: parseEnvironment(value.environment, "configuration.environment"),
        platforms,
    }
}

function isPathWithin(root: string, target: string): boolean {
    const relative = path.relative(root, target)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function expandTemplate(value: string, workspaceRoot: string, environment: NodeJS.ProcessEnv): string {
    return value
        .replaceAll("${workspaceFolder}", workspaceRoot)
        .replace(/\$\{env:([^}]+)\}/g, (_match, variable: string) => environment[variable] ?? "")
}

function expandEnvironment(environment: EnvironmentMap, workspaceRoot: string, base: NodeJS.ProcessEnv): EnvironmentMap {
    return Object.fromEntries(
        Object.entries(environment).map(([name, value]) => [
            name,
            value === null ? null : expandTemplate(value, workspaceRoot, base),
        ]),
    )
}

function resolveStartupScript(script: string, workspaceRoot: string, environment: NodeJS.ProcessEnv): string {
    const expanded = expandTemplate(script, workspaceRoot, environment)
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(workspaceRoot, expanded)
}

export class ShellEnvironmentConfigLoader {
    private readonly workspaceRoots: string[]
    private readonly platform: NodeJS.Platform
    private readonly environment: NodeJS.ProcessEnv
    private readonly cache = new Map<string, ResolvedShellEnvironment>()

    constructor(options: ShellEnvironmentConfigLoaderOptions) {
        this.workspaceRoots = [...options.workspaceRoots].map((root) => path.resolve(root)).sort((a, b) => b.length - a.length)
        this.platform = options.platform ?? process.platform
        this.environment = options.environment ?? process.env
    }

    resolveWorkspaceRoot(workdirectory: string): string | undefined {
        const absoluteWorkdirectory = path.resolve(workdirectory)
        return this.workspaceRoots.find((root) => isPathWithin(root, absoluteWorkdirectory))
    }

    async resolve(workdirectory: string, profile: string): Promise<ResolvedShellEnvironment | undefined> {
        const workspaceRoot = this.resolveWorkspaceRoot(workdirectory)
        if (!workspaceRoot) return undefined

        const configPath = path.join(workspaceRoot, CONFIG_RELATIVE_PATH)
        let fileStat
        try {
            fileStat = await stat(configPath)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
            throw error
        }

        try {
            const cacheKey = `${configPath}:${fileStat.mtimeMs}:${fileStat.size}:${profile}:${this.platform}`
            const cached = this.cache.get(cacheKey)
            if (cached) return cached
            const raw = await readFile(configPath, "utf8")
            const configuration = parseShellEnvironmentConfiguration(parseYaml(raw))
            const platform = configuration.platforms[this.platform as (typeof PLATFORM_NAMES)[number]]
            const resolvedProfile = resolveTerminalProfileId(profile, this.platform)
            const profileConfiguration = platform?.profiles[resolvedProfile] ?? platform?.profiles[profile]
            const environment = expandEnvironment(
                {
                    ...configuration.environment,
                    ...platform?.environment,
                    ...profileConfiguration?.environment,
                },
                workspaceRoot,
                this.environment,
            )
            const startupScripts = (profileConfiguration?.startupScripts ?? []).map((script) =>
                resolveStartupScript(script, workspaceRoot, this.environment),
            )
            const preCommands = (profileConfiguration?.preCommands ?? []).map((command) =>
                expandTemplate(command, workspaceRoot, this.environment),
            )
            const postCommand = profileConfiguration?.postCommand
                ? expandTemplate(profileConfiguration.postCommand, workspaceRoot, this.environment)
                : undefined
            const configurationId = createHash("sha256")
                .update(
                    JSON.stringify({
                        configPath,
                        environment,
                        startupScripts,
                        preCommands,
                        postCommand,
                        profile: resolvedProfile,
                    }),
                )
                .digest("hex")
                .slice(0, 16)
            const resolved = { workspaceRoot, configPath, configurationId, environment, startupScripts, preCommands, postCommand }
            if (this.cache.size >= 32) this.cache.clear()
            this.cache.set(cacheKey, resolved)
            return resolved
        } catch (error) {
            throw new Error(`Invalid ${CONFIG_RELATIVE_PATH} at ${configPath}: ${error instanceof Error ? error.message : error}`)
        }
    }
}

function quotePowerShell(value: string): string {
    return `'${value.replaceAll("'", "''")}'`
}

function quotePosix(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`
}

function quoteCmdPath(value: string): string {
    return `"${value.replaceAll('"', '""')}"`
}

function appendPowerShellDiagnostic(diagnosticsPath: string, message: string): string {
    return `Add-Content -LiteralPath ${quotePowerShell(diagnosticsPath)} -Value ${quotePowerShell(message)} -ErrorAction SilentlyContinue`
}

function appendPosixDiagnostic(diagnosticsPath: string, message: string): string {
    return `printf '%s\\n' ${quotePosix(message)} >> ${quotePosix(diagnosticsPath)}`
}

function appendCmdDiagnostic(diagnosticsPath: string, message: string): string {
    return `echo ${message.replaceAll(/[&|<>^%]/g, "_")}>>${quoteCmdPath(diagnosticsPath)}`
}

function buildPowerShellStartupScript(script: string, diagnosticsPath: string, index: number): string {
    const extension = path.extname(script).toLowerCase()
    const failure = appendPowerShellDiagnostic(diagnosticsPath, `startupScripts[${index}] failed: ${script}`)
    if (extension === ".ps1") {
        return `try { . ${quotePowerShell(script)} *> $null; if (-not $?) { throw 'script failed' } } catch { ${failure} }`
    }
    if (extension === ".bat" || extension === ".cmd") {
        const invocation = `call "${script.replaceAll('"', '""')}" >nul 2>&1 && set`
        return `try { $__dline_env = & $env:ComSpec /d /s /c ${quotePowerShell(invocation)}; if ($LASTEXITCODE -ne 0) { throw 'script failed' }; foreach ($__dline_line in $__dline_env) { $__dline_pair = $__dline_line -split '=', 2; if ($__dline_pair.Length -eq 2 -and $__dline_pair[0]) { Set-Item -LiteralPath "Env:$($__dline_pair[0])" -Value $__dline_pair[1] } } } catch { ${failure} }`
    }
    return failure
}

function buildPosixStartupScript(script: string, diagnosticsPath: string, index: number): string {
    const extension = path.extname(script).toLowerCase()
    const failure = appendPosixDiagnostic(diagnosticsPath, `startupScripts[${index}] failed: ${script}`)
    if ([".bashrc", ".bash", ".sh"].includes(extension)) {
        return `. ${quotePosix(script)} >/dev/null 2>&1 || ${failure}`
    }
    return failure
}

function buildCmdStartupScript(script: string, diagnosticsPath: string, index: number): string {
    const extension = path.extname(script).toLowerCase()
    const failure = appendCmdDiagnostic(diagnosticsPath, `startupScripts[${index}] failed`)
    if (extension === ".bat" || extension === ".cmd") {
        return `call ${quoteCmdPath(script)} >nul 2>&1 || ${failure}`
    }
    return failure
}

function shellKind(profile: string, platform: NodeJS.Platform): "powershell" | "cmd" | "posix" {
    if (platform !== "win32") return "posix"
    if (profile === "cmd") return "cmd"
    if (POWERSHELL_PROFILES.has(profile)) return "powershell"
    return profile.includes("bash") || profile === "wsl-bash" ? "posix" : "powershell"
}

export function buildTerminalInitializationCommand(
    startupScripts: readonly string[],
    profile: string,
    diagnosticsPath: string,
    platform: NodeJS.Platform = process.platform,
): string | undefined {
    if (startupScripts.length === 0) return undefined
    const kind = shellKind(profile, platform)
    if (kind === "powershell") {
        return startupScripts.map((script, index) => buildPowerShellStartupScript(script, diagnosticsPath, index)).join("; ")
    }
    if (kind === "cmd") {
        return startupScripts.map((script, index) => buildCmdStartupScript(script, diagnosticsPath, index)).join(" & ")
    }
    return startupScripts.map((script, index) => buildPosixStartupScript(script, diagnosticsPath, index)).join("; ")
}

function buildPowerShellCommand(options: ShellEnvironmentCommandOptions): string {
    const startup = (options.startupScripts ?? []).map((script, index) =>
        buildPowerShellStartupScript(script, options.diagnosticsPath, index),
    )
    const pre = (options.preCommands ?? []).map((entry, index) => {
        const failure = appendPowerShellDiagnostic(options.diagnosticsPath, `preCommands[${index}] failed`)
        return `try { Invoke-Expression ${quotePowerShell(entry)} *> $null; if (-not $?) { throw 'command failed' } } catch { ${failure} }`
    })
    const post = options.postCommand
        ? `try { Invoke-Expression ${quotePowerShell(options.postCommand)} *> $null; if (-not $?) { throw 'command failed' } } catch { ${appendPowerShellDiagnostic(options.diagnosticsPath, "postCommand failed")} }`
        : undefined
    const restoreExitCode = options.terminateShell ? "exit $__dline_exit_code" : '& $env:ComSpec /d /c "exit $__dline_exit_code"'
    const completionMarker = options.completionMarkerToken
        ? `Write-Output "${INTERNAL_COMMAND_EXIT_MARKER_PREFIX}${options.completionMarkerToken}:$__dline_exit_code"`
        : undefined
    return `${[...startup, ...pre].join("; ")}${startup.length + pre.length > 0 ? "; " : ""}$global:LASTEXITCODE = 0; & { ${options.command} }; $__dline_succeeded = $?; $__dline_exit_code = $LASTEXITCODE; if ($__dline_succeeded -and $__dline_exit_code -eq 0) { $__dline_exit_code = 0 } elseif ($__dline_exit_code -eq 0) { $__dline_exit_code = 1 }; ${post ? `${post}; ` : ""}${completionMarker ? `${completionMarker}; ` : ""}${restoreExitCode}`
}

function buildPosixCommand(options: ShellEnvironmentCommandOptions): string {
    const startup = (options.startupScripts ?? []).map((script, index) =>
        buildPosixStartupScript(script, options.diagnosticsPath, index),
    )
    const pre = (options.preCommands ?? []).map(
        (entry, index) =>
            `{ ${entry}; } >/dev/null 2>&1 || ${appendPosixDiagnostic(options.diagnosticsPath, `preCommands[${index}] failed`)}`,
    )
    const post = options.postCommand
        ? `{ ${options.postCommand}; } >/dev/null 2>&1 || ${appendPosixDiagnostic(options.diagnosticsPath, "postCommand failed")}`
        : undefined
    const prefix = [...startup, ...pre]
    const completionMarker = options.completionMarkerToken
        ? `printf '${INTERNAL_COMMAND_EXIT_MARKER_PREFIX}${options.completionMarkerToken}:%s\\n' "$__dline_exit"`
        : undefined
    return `( ${prefix.join("; ")}${prefix.length > 0 ? "; " : ""}${options.command}; __dline_exit=$?; ${post ? `${post}; ` : ""}${completionMarker ? `${completionMarker}; ` : ""}exit $__dline_exit )`
}

function buildCmdCommand(options: ShellEnvironmentCommandOptions): string {
    const startup = (options.startupScripts ?? []).map((script, index) =>
        buildCmdStartupScript(script, options.diagnosticsPath, index),
    )
    const pre = (options.preCommands ?? []).map(
        (entry, index) =>
            `(${entry}) >nul 2>&1 || ${appendCmdDiagnostic(options.diagnosticsPath, `preCommands[${index}] failed`)}`,
    )
    const post = options.postCommand
        ? `(${options.postCommand}) >nul 2>&1 || ${appendCmdDiagnostic(options.diagnosticsPath, "postCommand failed")}`
        : undefined
    const commands = [
        "setlocal EnableExtensions EnableDelayedExpansion",
        ...startup,
        ...pre,
        `(${options.command})`,
        'set "__dline_exit=!errorlevel!"',
    ]
    if (post) commands.push(post)
    if (options.completionMarkerToken) {
        commands.push(`echo ${INTERNAL_COMMAND_EXIT_MARKER_PREFIX}${options.completionMarkerToken}:!__dline_exit!`)
    }
    commands.push("exit /b !__dline_exit!")
    return commands.join(" & ")
}

export function buildShellEnvironmentCommand(options: ShellEnvironmentCommandOptions): string {
    const hasConfiguration =
        (options.startupScripts?.length ?? 0) > 0 || (options.preCommands?.length ?? 0) > 0 || options.postCommand !== undefined
    if (!hasConfiguration && !options.completionMarkerToken) return options.command
    const platform = options.platform ?? process.platform
    const kind = shellKind(options.profile, platform)
    if (kind === "powershell") return buildPowerShellCommand(options)
    if (kind === "cmd") return buildCmdCommand(options)
    return buildPosixCommand(options)
}

export async function consumeShellEnvironmentDiagnostics(diagnosticsPath: string): Promise<string[]> {
    let lines: string[] = []
    try {
        const diagnostics = await readFile(diagnosticsPath, "utf8")
        lines = diagnostics
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter(Boolean)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            Logger.error(`[ShellEnvironment] Failed to read diagnostics: ${diagnosticsPath}`, error)
        }
    } finally {
        await unlink(diagnosticsPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") {
                Logger.error(`[ShellEnvironment] Failed to remove diagnostics: ${diagnosticsPath}`, error)
            }
        })
    }
    return lines
}

export async function logShellEnvironmentDiagnostics(diagnosticsPath: string): Promise<void> {
    for (const line of await consumeShellEnvironmentDiagnostics(diagnosticsPath)) {
        Logger.error(`[ShellEnvironment] ${line}`)
    }
}
