import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { dump as dumpYaml, load as parseYaml } from "js-yaml"
import { HostProvider } from "@/hosts/host-provider"
import { type ProfileConfiguration, parseShellEnvironmentConfiguration } from "@/integrations/terminal/shell-environment"
import {
	ShellEnvironmentProfile,
	ShellEnvironmentProfilePreview,
	ShellEnvironmentProfileRequest,
	ShellEnvironmentVariable,
	UpdateShellEnvironmentProfileRequest,
} from "@/shared/proto/dline/file"
import { arePathsEqual } from "@/utils/path"
import { getAvailableTerminalProfiles, resolveTerminalProfileId } from "@/utils/shell"

const CONFIG_RELATIVE_PATH = path.join(".agents", "bashrc.yml")
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100] as const
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"])

type RenameFile = (sourcePath: string, destinationPath: string) => Promise<void>
type YamlRecord = Record<string, unknown>

export interface RenameShellEnvironmentConfigOptions {
	renameFile?: RenameFile
	sleep?: (delayMs: number) => Promise<void>
}

function isRecord(value: unknown): value is YamlRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function resolveWorkspacePath(requestedPath: string): Promise<string> {
	if (!requestedPath.trim()) throw new Error("workspacePath is required")
	const requested = path.resolve(requestedPath)
	const workspaces = await HostProvider.workspace.getWorkspacePaths({})
	const workspace = workspaces.paths.find((candidate) => arePathsEqual(path.resolve(candidate), requested))
	if (!workspace) throw new Error(`Workspace is not open: ${requestedPath}`)
	return path.resolve(workspace)
}

function validateProfile(profile: string): void {
	const isCanonicalDefault = profile === resolveTerminalProfileId("default")
	const isAvailableProfile = getAvailableTerminalProfiles().some((candidate) => candidate.id === profile)
	if (!isCanonicalDefault && !isAvailableProfile) {
		throw new Error(`Unknown terminal profile: ${profile}`)
	}
}

async function readSource(configPath: string): Promise<string> {
	try {
		return await readFile(configPath, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
		throw error
	}
}

function parseSource(source: string): YamlRecord {
	if (!source) return { version: 1 }
	const parsed = parseYaml(source)
	parseShellEnvironmentConfiguration(parsed)
	if (!isRecord(parsed)) throw new Error("configuration must be a mapping")
	return parsed
}

function readProfile(document: YamlRecord, profile: string, fallbackProfile?: string): ProfileConfiguration {
	const configuration = parseShellEnvironmentConfiguration(document)
	const platform = configuration.platforms[process.platform as "win32" | "linux" | "darwin"]
	return (
		platform?.profiles[profile] ??
		(fallbackProfile ? platform?.profiles[fallbackProfile] : undefined) ?? {
			environment: {},
			startupScripts: [],
			preCommands: [],
		}
	)
}

function toProfileResponse(
	workspacePath: string,
	profile: string,
	sourceContent: string,
	document: YamlRecord,
	fallbackProfile?: string,
): ShellEnvironmentProfile {
	const profileConfiguration = readProfile(document, profile, fallbackProfile)
	return ShellEnvironmentProfile.create({
		workspacePath,
		configPath: path.join(workspacePath, CONFIG_RELATIVE_PATH),
		exists: sourceContent.length > 0,
		profile,
		environment: Object.entries(profileConfiguration.environment).map(([name, value]) =>
			ShellEnvironmentVariable.create({ name, value: value ?? undefined }),
		),
		startupScripts: profileConfiguration.startupScripts,
		preCommands: profileConfiguration.preCommands,
		postCommand: profileConfiguration.postCommand,
		sourceContent,
	})
}

function validateUpdate(request: UpdateShellEnvironmentProfileRequest): void {
	validateProfile(request.profile)
	const names = new Set<string>()
	for (const variable of request.environment) {
		const name = variable.name.trim()
		if (!name || name.includes("=")) throw new Error("Environment variable names must be non-empty and cannot contain =")
		if (names.has(name)) throw new Error(`Duplicate environment variable: ${name}`)
		names.add(name)
	}
	for (const [field, entries] of [
		["startupScripts", request.startupScripts],
		["preCommands", request.preCommands],
	] as const) {
		if (entries.some((entry) => !entry.trim())) throw new Error(`${field} cannot contain empty entries`)
	}
	if (request.postCommand !== undefined && !request.postCommand.trim()) {
		throw new Error("postCommand must be omitted or non-empty")
	}
}

function setProfile(document: YamlRecord, request: UpdateShellEnvironmentProfileRequest): void {
	const platforms = isRecord(document.platforms) ? document.platforms : {}
	document.platforms = platforms
	const platformCandidate = platforms[process.platform]
	const platform: YamlRecord = isRecord(platformCandidate) ? platformCandidate : {}
	platforms[process.platform] = platform
	const profilesCandidate = platform.profiles
	const profiles: YamlRecord = isRecord(profilesCandidate) ? profilesCandidate : {}
	platform.profiles = profiles

	const profile: YamlRecord = {}
	if (request.environment.length > 0) {
		profile.environment = Object.fromEntries(
			request.environment.map((variable) => [variable.name.trim(), variable.value ?? null]),
		)
	}
	if (request.startupScripts.length > 0) profile.startupScripts = [...request.startupScripts]
	if (request.preCommands.length > 0) profile.preCommands = [...request.preCommands]
	if (request.postCommand !== undefined) profile.postCommand = request.postCommand
	profiles[request.profile] = profile
}

async function buildPreview(request: UpdateShellEnvironmentProfileRequest): Promise<{
	workspacePath: string
	configPath: string
	currentContent: string
	proposedContent: string
}> {
	validateUpdate(request)
	const workspacePath = await resolveWorkspacePath(request.workspacePath)
	const configPath = path.join(workspacePath, CONFIG_RELATIVE_PATH)
	const currentContent = await readSource(configPath)
	if (currentContent !== request.expectedSourceContent) {
		throw new Error("bashrc.yml changed on disk; reload it before saving")
	}
	const document = parseSource(currentContent)
	setProfile(document, { ...request, profile: resolveTerminalProfileId(request.profile) })
	const proposedContent = dumpYaml(document, {
		indent: 2,
		lineWidth: 120,
		noCompatMode: true,
		noRefs: true,
		sortKeys: false,
	})
	parseShellEnvironmentConfiguration(parseYaml(proposedContent))
	return { workspacePath, configPath, currentContent, proposedContent }
}

export async function renameShellEnvironmentConfigWithRetry(
	sourcePath: string,
	destinationPath: string,
	options: RenameShellEnvironmentConfigOptions = {},
): Promise<void> {
	const renameFile = options.renameFile ?? rename
	const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)))

	for (let attempt = 0; ; attempt++) {
		try {
			await renameFile(sourcePath, destinationPath)
			return
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (!code || !RETRYABLE_RENAME_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error
			await sleep(RENAME_RETRY_DELAYS_MS[attempt])
		}
	}
}

async function atomicWrite(configPath: string, content: string): Promise<void> {
	await mkdir(path.dirname(configPath), { recursive: true })
	const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`
	try {
		await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" })
		await renameShellEnvironmentConfigWithRetry(temporaryPath, configPath)
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined)
		throw error
	}
}

export async function getShellEnvironmentProfile(request: ShellEnvironmentProfileRequest): Promise<ShellEnvironmentProfile> {
	validateProfile(request.profile)
	const workspacePath = await resolveWorkspacePath(request.workspacePath)
	const sourceContent = await readSource(path.join(workspacePath, CONFIG_RELATIVE_PATH))
	return toProfileResponse(
		workspacePath,
		resolveTerminalProfileId(request.profile),
		sourceContent,
		parseSource(sourceContent),
		request.profile,
	)
}

export async function previewShellEnvironmentProfile(
	request: UpdateShellEnvironmentProfileRequest,
): Promise<ShellEnvironmentProfilePreview> {
	const preview = await buildPreview(request)
	return ShellEnvironmentProfilePreview.create({
		currentContent: preview.currentContent,
		proposedContent: preview.proposedContent,
		changed: preview.currentContent !== preview.proposedContent,
	})
}

export async function updateShellEnvironmentProfile(
	request: UpdateShellEnvironmentProfileRequest,
): Promise<ShellEnvironmentProfile> {
	if (!request.confirmed) throw new Error("Shell environment changes must be previewed and confirmed before saving")
	const preview = await buildPreview(request)
	if (preview.currentContent !== preview.proposedContent) {
		await atomicWrite(preview.configPath, preview.proposedContent)
	}
	return toProfileResponse(
		preview.workspacePath,
		resolveTerminalProfileId(request.profile),
		preview.proposedContent,
		parseSource(preview.proposedContent),
	)
}

export async function ensureShellEnvironmentConfig(workspacePath: string): Promise<string> {
	const resolvedWorkspacePath = await resolveWorkspacePath(workspacePath)
	const configPath = path.join(resolvedWorkspacePath, CONFIG_RELATIVE_PATH)
	if (!(await readSource(configPath))) await atomicWrite(configPath, "version: 1\n")
	return configPath
}
