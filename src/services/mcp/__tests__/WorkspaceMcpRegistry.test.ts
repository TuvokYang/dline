import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseWorkspaceMcpDescriptor, WorkspaceMcpRegistry } from "../WorkspaceMcpRegistry"

const registries: WorkspaceMcpRegistry[] = []
const temporaryDirectories: string[] = []

async function createWorkspace(name: string, createDescriptorDirectory = true): Promise<string> {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "dline-workspace-mcp-"))
    temporaryDirectories.push(parent)
    const workspace = path.join(parent, name)
    await fs.mkdir(createDescriptorDirectory ? path.join(workspace, ".agents", "mcp") : workspace, { recursive: true })
    return workspace
}

async function writeDescriptor(workspace: string, fileName: string, content: string): Promise<string> {
    const filePath = path.join(workspace, ".agents", "mcp", fileName)
    await fs.writeFile(filePath, content, "utf8")
    return filePath
}

afterEach(async () => {
    await Promise.all(registries.splice(0).map((registry) => registry.dispose()))
    await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("parseWorkspaceMcpDescriptor", () => {
    it("keeps environment references private while expanding workspace paths", async () => {
        const workspace = await createWorkspace("alpha")
        const filePath = path.join(workspace, ".agents", "mcp", "docs.yml")
        const descriptor = parseWorkspaceMcpDescriptor(
            [
                "name: local-docs",
                "description: Workspace documentation server",
                "type: stdio",
                "command: node",
                "args:",
                "  - ${workspaceFolder}/tools/mcp-server.js",
                "cwd: ${workspaceFolder}",
                "env:",
                "  API_TOKEN: ${env:LOCAL_DOCS_API_TOKEN}",
                "autoApprove:",
                "  - search",
                "timeout: 60",
            ].join("\n"),
            { filePath, workspaceRoot: workspace },
        )

        expect(descriptor.displayName).toBe("local-docs")
        expect(descriptor.internalName).toMatch(/^local-docs@[a-f0-9]{8}$/)
        expect(descriptor.source).toBe("workspace")
        expect(descriptor.description).toBe("Workspace documentation server")
        expect(descriptor.config).toMatchObject({
            type: "stdio",
            command: "node",
            args: [path.join(workspace, "tools", "mcp-server.js")],
            cwd: workspace,
            env: { API_TOKEN: "${env:LOCAL_DOCS_API_TOKEN}" },
            autoApprove: [],
            timeout: 60,
        })
    })

    it("parses JSON descriptors with the same contract", async () => {
        const workspace = await createWorkspace("json")
        const filePath = path.join(workspace, ".agents", "mcp", "remote.json")
        const descriptor = parseWorkspaceMcpDescriptor(
            JSON.stringify({
                name: "remote-docs",
                type: "streamableHttp",
                url: "https://example.test/mcp",
                headers: { Authorization: "Bearer ${env:REMOTE_DOCS_TOKEN}" },
            }),
            { filePath, workspaceRoot: workspace },
        )

        expect(descriptor.config).toMatchObject({
            type: "streamableHttp",
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer ${env:REMOTE_DOCS_TOKEN}" },
            autoApprove: [],
        })
    })

    it.each([
        {
            label: "environment value",
            content: ["name: unsafe", "type: stdio", "command: node", "env:", "  API_TOKEN: literal-secret"].join("\n"),
        },
        {
            label: "authorization header",
            content: [
                "name: unsafe",
                "type: streamableHttp",
                "url: https://example.test/mcp",
                "headers:",
                "  Authorization: Bearer literal-secret",
            ].join("\n"),
        },
    ])("rejects a literal secret in a sensitive $label", async ({ content }) => {
        const workspace = await createWorkspace("unsafe")
        const filePath = path.join(workspace, ".agents", "mcp", "unsafe.yml")
        expect(() => parseWorkspaceMcpDescriptor(content, { filePath, workspaceRoot: workspace })).toThrow(
            /environment variable reference/i,
        )
    })
})

describe("WorkspaceMcpRegistry", () => {
    it("notifies only when a shared workspace root enters or leaves the effective registry", async () => {
        const workspace = await createWorkspace("shared")
        await writeDescriptor(workspace, "docs.yml", ["name: docs", "type: stdio", "command: node"].join("\n"))
        const notifications: string[][] = []
        const registry = new WorkspaceMcpRegistry((descriptors) => {
            notifications.push(descriptors.map((descriptor) => descriptor.internalName))
        })
        registries.push(registry)

        await registry.registerOwner("panel-1", [workspace])
        expect(notifications).toHaveLength(1)
        expect(notifications[0]).toHaveLength(1)

        await registry.registerOwner("panel-2", [workspace])
        expect(notifications).toHaveLength(1)

        await registry.unregisterOwner("panel-1")
        expect(notifications).toHaveLength(1)

        await registry.unregisterOwner("panel-2")
        expect(notifications).toHaveLength(2)
        expect(notifications[1]).toEqual([])
    })

    it("shares one workspace descriptor across owners without leaking other workspaces", async () => {
        const alpha = await createWorkspace("alpha")
        const beta = await createWorkspace("beta")
        await writeDescriptor(alpha, "docs.yml", ["name: docs", "type: stdio", "command: node"].join("\n"))
        await writeDescriptor(beta, "docs.yml", ["name: docs", "type: stdio", "command: node"].join("\n"))

        const registry = new WorkspaceMcpRegistry()
        registries.push(registry)
        await registry.registerOwner("alpha-panel-1", [alpha])
        await registry.registerOwner("alpha-panel-2", [alpha])
        await registry.registerOwner("beta-panel", [beta])

        const alphaName = registry.getDescriptorsForOwner("alpha-panel-1")[0]?.internalName
        const alphaSecondName = registry.getDescriptorsForOwner("alpha-panel-2")[0]?.internalName
        const betaName = registry.getDescriptorsForOwner("beta-panel")[0]?.internalName

        expect(alphaName).toBeDefined()
        expect(alphaSecondName).toBe(alphaName)
        expect(betaName).toBeDefined()
        expect(betaName).not.toBe(alphaName)
        expect(registry.getAllDescriptors()).toHaveLength(2)

        await registry.unregisterOwner("alpha-panel-1")
        expect(registry.getAllDescriptors().map((descriptor) => descriptor.internalName)).toContain(alphaName)
        await registry.unregisterOwner("alpha-panel-2")
        expect(registry.getAllDescriptors().map((descriptor) => descriptor.internalName)).not.toContain(alphaName)
        expect(registry.getDescriptorsForOwner("beta-panel")[0]?.internalName).toBe(betaName)
    })

    it("refreshes descriptor additions and removals for an existing owner", async () => {
        const workspace = await createWorkspace("refresh")
        const registry = new WorkspaceMcpRegistry()
        registries.push(registry)
        await registry.registerOwner("panel", [workspace])
        expect(registry.getDescriptorsForOwner("panel")).toEqual([])

        const descriptorPath = await writeDescriptor(
            workspace,
            "docs.yml",
            ["name: docs", "type: stdio", "command: node"].join("\n"),
        )
        await registry.refreshOwner("panel")
        expect(registry.getDescriptorsForOwner("panel")).toHaveLength(1)

        await fs.rm(descriptorPath)
        await registry.refreshOwner("panel")
        expect(registry.getDescriptorsForOwner("panel")).toEqual([])
    })

    it("watches descriptors created after the descriptor directory", async () => {
        const workspace = await createWorkspace("late-directory", false)
        const registry = new WorkspaceMcpRegistry()
        registries.push(registry)
        await registry.registerOwner("panel", [workspace])
        expect(registry.getDescriptorsForOwner("panel")).toEqual([])

        await fs.mkdir(path.join(workspace, ".agents", "mcp"), { recursive: true })
        const descriptorPath = await writeDescriptor(
            workspace,
            "docs.yml",
            ["name: docs", "type: stdio", "command: node"].join("\n"),
        )
        await expect.poll(() => registry.getDescriptorsForOwner("panel"), { timeout: 10_000 }).toHaveLength(1)

        await fs.rm(descriptorPath)
        await expect.poll(() => registry.getDescriptorsForOwner("panel"), { timeout: 10_000 }).toEqual([])
    })
})
