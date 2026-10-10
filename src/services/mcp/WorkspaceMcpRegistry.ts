import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import chokidar, { type FSWatcher } from "chokidar"
import deepEqual from "fast-deep-equal"
import { load as loadYaml } from "js-yaml"
import { z } from "zod"
import { Logger } from "@/shared/services/Logger"
import { ServerConfigSchema } from "./schemas"
import type { McpServerConfig } from "./types"

const MCP_DESCRIPTOR_DIRECTORY = path.join(".agents", "mcp")
const ENVIRONMENT_REFERENCE_PATTERN = /\$\{env:[A-Za-z_][A-Za-z0-9_]*\}/
const SENSITIVE_FIELD_PATTERN = /(?:^|[_-])(api[_-]?key|authorization|cookie|credential|password|secret|token)(?:$|[_-])/i
const SENSITIVE_ARGUMENT_PATTERN = /(?:^|\s)--?(?:api[-_]?key|authorization|cookie|credential|password|secret|token)(?:=|\s)/i

const DescriptorMetadataSchema = z
    .object({
        name: z.string().trim().min(1),
        description: z.string().trim().min(1).optional(),
    })
    .passthrough()

export interface WorkspaceMcpDescriptor {
    internalName: string
    displayName: string
    description?: string
    source: "workspace"
    workspaceRoot: string
    filePath: string
    config: McpServerConfig
}

export interface ParseWorkspaceMcpDescriptorOptions {
    filePath: string
    workspaceRoot: string
}

type RegistryChangeListener = (descriptors: readonly WorkspaceMcpDescriptor[]) => void | Promise<void>

interface RootRegistration {
    owners: Set<string>
    descriptors: WorkspaceMcpDescriptor[]
    watcher?: FSWatcher
    ready: Promise<void>
    refreshQueue: Promise<void>
}

function normalizeWorkspaceRoot(workspaceRoot: string): string {
    const resolved = path.resolve(workspaceRoot)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

export function createWorkspaceMcpScopeHash(workspaceRoot: string): string {
    return createHash("sha256").update(normalizeWorkspaceRoot(workspaceRoot)).digest("hex").slice(0, 8)
}

function parseDescriptorDocument(content: string, filePath: string): unknown {
    if (path.extname(filePath).toLowerCase() === ".json") {
        return JSON.parse(content)
    }
    return loadYaml(content)
}

function hasEnvironmentReference(value: string): boolean {
    return ENVIRONMENT_REFERENCE_PATTERN.test(value)
}

function assertNoInlineSecrets(value: unknown, fieldPath: string[] = []): void {
    if (Array.isArray(value)) {
        for (const item of value) {
            if (typeof item === "string" && SENSITIVE_ARGUMENT_PATTERN.test(item) && !hasEnvironmentReference(item)) {
                throw new Error(`Sensitive value at '${fieldPath.join(".")}' must use an environment variable reference.`)
            }
            assertNoInlineSecrets(item, fieldPath)
        }
        return
    }
    if (!value || typeof value !== "object") return

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const childPath = [...fieldPath, key]
        if (SENSITIVE_FIELD_PATTERN.test(key)) {
            if (typeof child !== "string" || !hasEnvironmentReference(child)) {
                throw new Error(`Sensitive value at '${childPath.join(".")}' must use an environment variable reference.`)
            }
        }
        assertNoInlineSecrets(child, childPath)
    }
}

function assertNoInlineUrlSecrets(value: unknown): void {
    if (!value || typeof value !== "object") return
    const url = (value as Record<string, unknown>).url
    if (typeof url !== "string") return
    const queryStart = url.indexOf("?")
    if (queryStart < 0) return
    for (const pair of url.slice(queryStart + 1).split("&")) {
        const [rawKey, rawValue = ""] = pair.split("=", 2)
        if (SENSITIVE_FIELD_PATTERN.test(decodeURIComponent(rawKey)) && !hasEnvironmentReference(rawValue)) {
            throw new Error(`Sensitive URL parameter '${rawKey}' must use an environment variable reference.`)
        }
    }
}

function expandWorkspaceFolder(value: unknown, workspaceRoot: string): unknown {
    if (typeof value === "string") {
        if (value === "${workspaceFolder}") return workspaceRoot
        if (/^\$\{workspaceFolder\}[\\/]/.test(value)) {
            return path.normalize(path.join(workspaceRoot, value.slice("${workspaceFolder}".length + 1)))
        }
        return value.replaceAll("${workspaceFolder}", workspaceRoot)
    }
    if (Array.isArray(value)) {
        return value.map((entry) => expandWorkspaceFolder(entry, workspaceRoot))
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
                key,
                expandWorkspaceFolder(entry, workspaceRoot),
            ]),
        )
    }
    return value
}

export function parseWorkspaceMcpDescriptor(
    content: string,
    options: ParseWorkspaceMcpDescriptorOptions,
): WorkspaceMcpDescriptor {
    const parsedDocument = DescriptorMetadataSchema.parse(parseDescriptorDocument(content, options.filePath))
    const { name, description, ...rawConfig } = parsedDocument
    assertNoInlineSecrets(rawConfig)
    assertNoInlineUrlSecrets(rawConfig)

    const workspaceRoot = path.resolve(options.workspaceRoot)
    const expandedWorkspaceConfig = expandWorkspaceFolder(rawConfig, workspaceRoot) as Record<string, unknown>
    const config = ServerConfigSchema.parse({
        ...expandedWorkspaceConfig,
        ...(expandedWorkspaceConfig.type === "stdio" && expandedWorkspaceConfig.cwd === undefined ? { cwd: workspaceRoot } : {}),
        // Workspace descriptors never grant approval. Approval remains task/user controlled.
        autoApprove: [],
    })

    return {
        internalName: `${name}@${createWorkspaceMcpScopeHash(workspaceRoot)}`,
        displayName: name,
        description,
        source: "workspace",
        workspaceRoot,
        filePath: path.resolve(options.filePath),
        config,
    }
}

function isDescriptorFile(filePath: string): boolean {
    return /\.(?:ya?ml|json)$/i.test(filePath)
}

function isWithinDirectory(parentDirectory: string, candidatePath: string): boolean {
    const relativePath = path.relative(parentDirectory, candidatePath)
    return (
        relativePath === "" ||
        (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))
    )
}

function shouldIgnoreWorkspacePath(workspaceRoot: string, candidatePath: string, isFile: boolean): boolean {
    const resolvedPath = path.resolve(candidatePath)
    const agentsDirectory = path.join(workspaceRoot, ".agents")
    const descriptorDirectory = path.join(agentsDirectory, "mcp")
    if (resolvedPath === workspaceRoot || resolvedPath === agentsDirectory) return false
    if (!isWithinDirectory(descriptorDirectory, resolvedPath)) return true
    return isFile && !isDescriptorFile(resolvedPath)
}

async function readDescriptorFiles(directoryPath: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(directoryPath, { withFileTypes: true })
        const nestedFiles = await Promise.all(
            entries.map(async (entry) => {
                const entryPath = path.join(directoryPath, entry.name)
                if (entry.isDirectory()) return readDescriptorFiles(entryPath)
                return entry.isFile() && isDescriptorFile(entryPath) ? [entryPath] : []
            }),
        )
        return nestedFiles.flat().sort((left, right) => left.localeCompare(right))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
        throw error
    }
}

async function scanWorkspaceRoot(workspaceRoot: string): Promise<WorkspaceMcpDescriptor[]> {
    const descriptorDirectory = path.join(workspaceRoot, MCP_DESCRIPTOR_DIRECTORY)
    const descriptors = new Map<string, WorkspaceMcpDescriptor>()
    for (const filePath of await readDescriptorFiles(descriptorDirectory)) {
        try {
            const descriptor = parseWorkspaceMcpDescriptor(await fs.readFile(filePath, "utf8"), {
                filePath,
                workspaceRoot,
            })
            if (descriptors.has(descriptor.internalName)) {
                Logger.warn(`[WorkspaceMcpRegistry] Ignoring duplicate descriptor '${descriptor.displayName}' at ${filePath}.`)
                continue
            }
            descriptors.set(descriptor.internalName, descriptor)
        } catch (error) {
            Logger.error(`[WorkspaceMcpRegistry] Failed to load descriptor '${filePath}':`, error)
        }
    }
    return [...descriptors.values()]
}

export class WorkspaceMcpRegistry {
    private readonly owners = new Map<string, Set<string>>()
    private readonly roots = new Map<string, RootRegistration>()
    private disposed = false

    constructor(private readonly onDidChange?: RegistryChangeListener) {}

    async registerOwner(ownerId: string, workspaceRoots: readonly string[]): Promise<void> {
        if (this.disposed) throw new Error("Workspace MCP registry is disposed.")
        const nextRoots = new Set(workspaceRoots.map((root) => path.resolve(root)))
        const previousRoots = this.owners.get(ownerId) ?? new Set<string>()
        let descriptorsChanged = false

        for (const workspaceRoot of previousRoots) {
            if (!nextRoots.has(workspaceRoot))
                descriptorsChanged = (await this.releaseRoot(ownerId, workspaceRoot)) || descriptorsChanged
        }
        for (const workspaceRoot of nextRoots) {
            if (!previousRoots.has(workspaceRoot))
                descriptorsChanged = (await this.acquireRoot(ownerId, workspaceRoot)) || descriptorsChanged
        }
        this.owners.set(ownerId, nextRoots)
        if (descriptorsChanged) await this.notifyChange()
    }

    async unregisterOwner(ownerId: string): Promise<void> {
        const workspaceRoots = this.owners.get(ownerId)
        if (!workspaceRoots) return
        let descriptorsChanged = false
        for (const workspaceRoot of workspaceRoots) {
            descriptorsChanged = (await this.releaseRoot(ownerId, workspaceRoot)) || descriptorsChanged
        }
        this.owners.delete(ownerId)
        if (descriptorsChanged) await this.notifyChange()
    }

    async refreshOwner(ownerId: string): Promise<void> {
        const workspaceRoots = this.owners.get(ownerId)
        if (!workspaceRoots) return
        for (const workspaceRoot of workspaceRoots) {
            await this.refreshRoot(workspaceRoot)
        }
    }

    getDescriptorsForOwner(ownerId: string): WorkspaceMcpDescriptor[] {
        const workspaceRoots = this.owners.get(ownerId)
        if (!workspaceRoots) return []
        return [...workspaceRoots]
            .flatMap((workspaceRoot) => this.roots.get(workspaceRoot)?.descriptors ?? [])
            .sort((left, right) => left.internalName.localeCompare(right.internalName))
    }

    getAllDescriptors(): WorkspaceMcpDescriptor[] {
        return [...this.roots.values()]
            .flatMap((registration) => registration.descriptors)
            .sort((left, right) => left.internalName.localeCompare(right.internalName))
    }

    async dispose(): Promise<void> {
        if (this.disposed) return
        this.disposed = true
        await Promise.all([...this.roots.values()].map((registration) => registration.watcher?.close()))
        this.roots.clear()
        this.owners.clear()
    }

    private async acquireRoot(ownerId: string, workspaceRoot: string): Promise<boolean> {
        const existing = this.roots.get(workspaceRoot)
        if (existing) {
            existing.owners.add(ownerId)
            await existing.ready
            return false
        }

        const registration: RootRegistration = {
            owners: new Set([ownerId]),
            descriptors: [],
            ready: Promise.resolve(),
            refreshQueue: Promise.resolve(),
        }
        this.roots.set(workspaceRoot, registration)
        registration.watcher = this.watchRoot(workspaceRoot)
        registration.ready = (async () => {
            await new Promise<void>((resolve) => registration.watcher?.once("ready", resolve))
            registration.descriptors = await scanWorkspaceRoot(workspaceRoot)
        })()
        await registration.ready
        return registration.descriptors.length > 0
    }

    private async releaseRoot(ownerId: string, workspaceRoot: string): Promise<boolean> {
        const registration = this.roots.get(workspaceRoot)
        if (!registration) return false
        registration.owners.delete(ownerId)
        if (registration.owners.size > 0) return false
        this.roots.delete(workspaceRoot)
        await registration.watcher?.close()
        return registration.descriptors.length > 0
    }

    private watchRoot(workspaceRoot: string): FSWatcher {
        const descriptorDirectory = path.join(workspaceRoot, MCP_DESCRIPTOR_DIRECTORY)
        const watcher = chokidar.watch(workspaceRoot, {
            persistent: true,
            ignoreInitial: true,
            ignored: (candidatePath, stats) => shouldIgnoreWorkspacePath(workspaceRoot, candidatePath, stats?.isFile() === true),
            awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
        })
        const refresh = (filePath: string) => {
            if (isDescriptorFile(filePath)) void this.refreshRoot(workspaceRoot)
        }
        watcher
            .on("add", refresh)
            .on("change", refresh)
            .on("unlink", refresh)
            .on("unlinkDir", () => void this.refreshRoot(workspaceRoot))
            .on("error", (error) => {
                Logger.error(`[WorkspaceMcpRegistry] Failed to watch '${descriptorDirectory}':`, error)
            })
        return watcher
    }

    private async refreshRoot(workspaceRoot: string): Promise<void> {
        const registration = this.roots.get(workspaceRoot)
        if (!registration) return
        registration.refreshQueue = registration.refreshQueue.then(async () => {
            const descriptors = await scanWorkspaceRoot(workspaceRoot)
            if (deepEqual(registration.descriptors, descriptors)) return
            registration.descriptors = descriptors
            await this.notifyChange()
        })
        await registration.refreshQueue
    }

    private async notifyChange(): Promise<void> {
        void Promise.resolve()
            .then(() => this.onDidChange?.(this.getAllDescriptors()))
            .catch((error) => {
                Logger.error("[WorkspaceMcpRegistry] Failed to apply descriptor changes:", error)
            })
    }
}
