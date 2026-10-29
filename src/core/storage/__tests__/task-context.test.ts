import type { TaskContextCache } from "@core/storage/task-context-types"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import type { ClineTool } from "@shared/tools"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GlobalFileNames, getTaskContext, saveTaskContext } from "../disk"

let testDir: string
let previousDocsDir: string | undefined

beforeEach(async () => {
    previousDocsDir = process.env.DLINE_DOCS_DIR
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-task-context-"))
    process.env.DLINE_DOCS_DIR = testDir
})

afterEach(async () => {
    if (previousDocsDir === undefined) {
        delete process.env.DLINE_DOCS_DIR
    } else {
        process.env.DLINE_DOCS_DIR = previousDocsDir
    }
    await fs.rm(testDir, { recursive: true, force: true })
})

/**
 * Build a complete task context cache fixture.
 *
 * @param taskId Task identifier for the fixture.
 * @returns Task context cache fixture with a frozen prompt.
 */
function buildTool(name: string): ClineTool {
    return {
        type: "function",
        function: {
            name,
            description: `${name} description`,
            strict: false,
            parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
    }
}

function buildContext(taskId: string): TaskContextCache {
    return {
        schemaVersion: 1,
        taskId,
        createdAt: 100,
        updatedAt: 200,
        systemPrompt: {
            frozen: {
                text: "frozen prompt\n\n# Capabilities",
                tools: [buildTool("frozen_tool")],
                capabilitiesHash: "sha256:test",
                createdAt: 100,
                refreshedAt: 200,
                refreshReason: "task_start",
                runtime: {
                    parallelToolsEnabled: true,
                    webToolsEnabled: true,
                    webToolsMode: 0,
                    webSearchRoute: "hosted",
                    webSearchLocalFallbackAvailable: true,
                    serverTools: [ServerTool.WEB_SEARCH],
                    focusChainEnabled: true,
                    subagentsEnabled: true,
                    capabilityToggles: createTaskCapabilityToggles({ mcpServers: { frozen: true } }),
                    browserEnabled: true,
                    browserViewport: { width: 1280, height: 800 },
                },
                promptBuilder: {
                    contractVersion: 2,
                    providerId: "test-provider",
                    modelId: "test-model",
                    profile: "standard",
                    nativeTools: true,
                    apiFormat: ApiFormat.OPENAI_RESPONSES,
                    serverTools: [ServerTool.WEB_SEARCH],
                    webToolsEnabled: true,
                    webSearchRoute: "hosted",
                },
            },
        },
    }
}

describe("task context cache", () => {
    it("returns an empty versioned context when context.json does not exist", async () => {
        const context = await getTaskContext("task-1")

        expect(context.schemaVersion).toBe(1)
        expect(context.taskId).toBe("task-1")
        expect(context.systemPrompt).toBeUndefined()
    })

    it("persists and reads frozen system prompt cache from context.json", async () => {
        const taskId = "task-2"
        const expected = buildContext(taskId)

        await saveTaskContext(taskId, expected)
        const actual = await getTaskContext(taskId)

        expect(actual).toEqual(expected)
        expect(actual.systemPrompt?.frozen?.tools).toEqual(expected.systemPrompt?.frozen?.tools)
        expect(actual.systemPrompt?.frozen?.runtime).toMatchObject({
            parallelToolsEnabled: true,
            webToolsEnabled: true,
            webSearchRoute: "hosted",
            serverTools: [ServerTool.WEB_SEARCH],
            focusChainEnabled: true,
            subagentsEnabled: true,
            capabilityToggles: { mcpServers: { frozen: true } },
            browserEnabled: true,
            browserViewport: { width: 1280, height: 800 },
        })
        expect(actual.systemPrompt?.frozen?.promptBuilder).toMatchObject({
            apiFormat: ApiFormat.OPENAI_RESPONSES,
            serverTools: [ServerTool.WEB_SEARCH],
            webToolsEnabled: true,
            webSearchRoute: "hosted",
        })
        const filePath = path.join(testDir, "tasks", taskId, GlobalFileNames.taskContext)
        expect(await fs.readFile(filePath, "utf8")).toContain("# Capabilities")
    })

    it.each([
        "task_start",
        "manual",
        "post_compaction",
        "capability_change",
        "mode_switch",
    ] as const)("accepts the persisted prompt refresh reason %s", async (refreshReason) => {
        const taskId = `task-refresh-reason-${refreshReason}`
        const context = buildContext(taskId)
        const frozen = context.systemPrompt?.frozen
        if (!frozen) throw new Error("Task context fixture is missing its frozen prompt")
        await saveTaskContext(taskId, {
            ...context,
            systemPrompt: {
                frozen: { ...frozen, refreshReason },
            },
        })

        const actual = await getTaskContext(taskId)

        expect(actual.systemPrompt?.frozen?.refreshReason).toBe(refreshReason)
    })

    it("migrates the legacy native prompt profile at the read boundary", async () => {
        const taskId = "task-legacy-native-profile"
        const filePath = path.join(testDir, "tasks", taskId, GlobalFileNames.taskContext)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        const legacy = buildContext(taskId)
        await fs.writeFile(
            filePath,
            JSON.stringify({
                ...legacy,
                systemPrompt: {
                    frozen: {
                        ...legacy.systemPrompt?.frozen,
                        promptBuilder: { ...legacy.systemPrompt?.frozen?.promptBuilder, profile: "native" },
                    },
                },
            }),
            "utf8",
        )

        const actual = await getTaskContext(taskId)

        expect(actual.systemPrompt?.frozen?.promptBuilder.profile).toBe("standard")
    })

    it.each([
        ["string", "not-an-array"],
        ["empty-object", [{}]],
        ["null-entry", [null]],
        ["malformed-openai-schema", [{ type: "function", function: { name: "read_file", parameters: "invalid" } }]],
        ["malformed-anthropic-schema", [{ name: "read_file", input_schema: "invalid" }]],
    ] as const)("rejects malformed frozen provider tools: %s", async (caseId, tools) => {
        const taskId = `task-malformed-tools-${caseId}`
        const filePath = path.join(testDir, "tasks", taskId, GlobalFileNames.taskContext)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        const malformed = buildContext(taskId)
        await fs.writeFile(
            filePath,
            JSON.stringify({
                ...malformed,
                systemPrompt: { frozen: { ...malformed.systemPrompt?.frozen, tools } },
            }),
            "utf8",
        )

        const actual = await getTaskContext(taskId)

        expect(actual.systemPrompt).toBeUndefined()
    })

    it.each([
        ["tools", (frozen: Record<string, unknown>) => delete frozen.tools],
        ["text", (frozen: Record<string, unknown>) => delete frozen.text],
        ["capabilities-hash", (frozen: Record<string, unknown>) => delete frozen.capabilitiesHash],
        ["created-at", (frozen: Record<string, unknown>) => delete frozen.createdAt],
        ["refreshed-at", (frozen: Record<string, unknown>) => delete frozen.refreshedAt],
        ["refresh-reason", (frozen: Record<string, unknown>) => delete frozen.refreshReason],
        ["prompt-builder", (frozen: Record<string, unknown>) => delete frozen.promptBuilder],
    ] as const)("rejects frozen cache missing required field: %s", async (caseId, removeField) => {
        const taskId = `task-missing-${caseId}`
        const filePath = path.join(testDir, "tasks", taskId, GlobalFileNames.taskContext)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        const malformed = buildContext(taskId)
        const frozen = { ...malformed.systemPrompt?.frozen } as Record<string, unknown>
        removeField(frozen)
        await fs.writeFile(filePath, JSON.stringify({ ...malformed, systemPrompt: { frozen } }), "utf8")

        const actual = await getTaskContext(taskId)

        expect(actual.systemPrompt).toBeUndefined()
    })

    it.each([
        ["empty-text", { text: "" }],
        ["invalid-tools", { tools: undefined }],
        ["empty-capabilities-hash", { capabilitiesHash: "" }],
        ["non-finite-created-at", { createdAt: "NaN" }],
        ["non-finite-refreshed-at", { refreshedAt: null }],
        ["invalid-refresh-reason", { refreshReason: "automatic" }],
        [
            "invalid-provider-id",
            { promptBuilder: { providerId: "", modelId: "test-model", profile: "standard", nativeTools: false } },
        ],
        [
            "invalid-model-id",
            { promptBuilder: { providerId: "test-provider", modelId: "", profile: "standard", nativeTools: false } },
        ],
        [
            "invalid-profile",
            { promptBuilder: { providerId: "test-provider", modelId: "test-model", profile: "compact", nativeTools: false } },
        ],
        [
            "invalid-native-tools",
            { promptBuilder: { providerId: "test-provider", modelId: "test-model", profile: "standard", nativeTools: "yes" } },
        ],
    ] as const)("rejects malformed required frozen value: %s", async (caseId, override) => {
        const taskId = `task-malformed-${caseId}`
        const filePath = path.join(testDir, "tasks", taskId, GlobalFileNames.taskContext)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        const malformed = buildContext(taskId)
        await fs.writeFile(
            filePath,
            JSON.stringify({
                ...malformed,
                systemPrompt: { frozen: { ...malformed.systemPrompt?.frozen, ...override } },
            }),
            "utf8",
        )

        const actual = await getTaskContext(taskId)

        expect(actual.systemPrompt).toBeUndefined()
    })

    it.each([
        ["api-format", { apiFormat: "responses" }],
        ["api-format-unknown", { apiFormat: 999 }],
        ["api-format-unrecognized", { apiFormat: -1 }],
        ["server-tools-container", { serverTools: "web_search" }],
        ["server-tools-entry", { serverTools: [1.5] }],
        ["server-tools-unknown", { serverTools: [999] }],
        ["server-tools-unspecified", { serverTools: [ServerTool.SERVER_TOOL_UNSPECIFIED] }],
        ["web-tools-enabled", { webToolsEnabled: "true" }],
        ["web-search-route", { webSearchRoute: "remote" }],
    ] as const)("rejects malformed optional provider projection: %s", async (caseId, promptBuilderOverride) => {
        const taskId = `task-malformed-projection-${caseId}`
        const filePath = path.join(testDir, "tasks", taskId, GlobalFileNames.taskContext)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        const malformed = buildContext(taskId)
        await fs.writeFile(
            filePath,
            JSON.stringify({
                ...malformed,
                systemPrompt: {
                    frozen: {
                        ...malformed.systemPrompt?.frozen,
                        promptBuilder: {
                            ...malformed.systemPrompt?.frozen?.promptBuilder,
                            ...promptBuilderOverride,
                        },
                    },
                },
            }),
            "utf8",
        )

        const actual = await getTaskContext(taskId)

        expect(actual.systemPrompt).toBeUndefined()
    })

    it.each([
        [
            "missing-toggle-map",
            (runtime: Record<string, unknown>) => delete (runtime.capabilityToggles as Record<string, unknown>).mcpServers,
        ],
        [
            "invalid-parallel-tools",
            (runtime: Record<string, unknown>) => {
                runtime.parallelToolsEnabled = "yes"
            },
        ],
        [
            "invalid-toggle-entry",
            (runtime: Record<string, unknown>) => {
                ;(runtime.capabilityToggles as Record<string, unknown>).mcpServers = { frozen: "yes" }
            },
        ],
        [
            "invalid-server-tool",
            (runtime: Record<string, unknown>) => {
                runtime.serverTools = [999]
            },
        ],
        [
            "invalid-browser-viewport",
            (runtime: Record<string, unknown>) => {
                runtime.browserViewport = { width: -1, height: 800 }
            },
        ],
    ] as const)("rejects malformed frozen runtime: %s", async (caseId, mutateRuntime) => {
        const taskId = `task-malformed-runtime-${caseId}`
        const filePath = path.join(testDir, "tasks", taskId, GlobalFileNames.taskContext)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        const malformed = buildContext(taskId)
        const runtime = structuredClone(malformed.systemPrompt?.frozen?.runtime) as unknown as Record<string, unknown>
        mutateRuntime(runtime)
        await fs.writeFile(
            filePath,
            JSON.stringify({
                ...malformed,
                systemPrompt: { frozen: { ...malformed.systemPrompt?.frozen, runtime } },
            }),
            "utf8",
        )

        const actual = await getTaskContext(taskId)

        expect(actual.systemPrompt).toBeUndefined()
    })

    it.each([
        ["native-tools-true-with-null", null, true],
        ["native-tools-true-with-empty-array", [], true],
        ["native-tools-false-with-array", [buildTool("unexpected_native_tool")], false],
    ] as const)("rejects inconsistent frozen tools metadata: %s", async (caseId, tools, nativeTools) => {
        const taskId = `task-inconsistent-${caseId}`
        const filePath = path.join(testDir, "tasks", taskId, GlobalFileNames.taskContext)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        const malformed = buildContext(taskId)
        await fs.writeFile(
            filePath,
            JSON.stringify({
                ...malformed,
                systemPrompt: {
                    frozen: {
                        ...malformed.systemPrompt?.frozen,
                        tools,
                        promptBuilder: { ...malformed.systemPrompt?.frozen?.promptBuilder, nativeTools },
                    },
                },
            }),
            "utf8",
        )

        const actual = await getTaskContext(taskId)

        expect(actual.systemPrompt).toBeUndefined()
    })

    it("falls back to an empty context when context.json is invalid", async () => {
        const taskId = "task-3"
        const filePath = path.join(testDir, "tasks", taskId, GlobalFileNames.taskContext)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.writeFile(filePath, "{ invalid json", "utf8")

        const context = await getTaskContext(taskId)

        expect(context.schemaVersion).toBe(1)
        expect(context.taskId).toBe(taskId)
        expect(context.systemPrompt).toBeUndefined()
    })
})
