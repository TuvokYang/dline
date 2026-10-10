/**
 * Tests for find_references / rename failure reporting (BUGFIX-032):
 * - workspace-relative paths are resolved to absolute before reaching the LSP
 * - each LanguageFailureKind maps to its own actionable message
 * - only a host without LSP integration reports "LSP not available"
 */
import { strict as assert } from "node:assert"
import * as path from "node:path"
import type { ToolUse } from "@core/assistant-message"
import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import { LanguageFailureKind } from "@/shared/proto/dline/host/language"
import type { TaskConfig } from "../../types/TaskConfig"
import { FindReferencesHandler } from "../FindReferencesHandler"
import { RenameSymbolHandler } from "../RenameSymbolHandler"

const CWD = path.resolve("e:\\workspace\\project")

/** Record the `say("tool", ...)` payloads a handler emits. */
interface SayRecorder {
    payloads: Array<Record<string, unknown>>
}

function createMockConfig(recorder: SayRecorder): TaskConfig {
    return {
        blockState: { rejectActiveBlock: () => {}, reset: () => {}, hasAnyRejection: () => false },
        taskId: "test-task",
        ulid: "test-ulid",
        cwd: CWD,
        mode: "act" as any,
        strictPlanModeEnabled: false,
        yoloModeToggled: false,
        doubleCheckCompletionEnabled: false,
        vscodeTerminalExecutionMode: "vscodeTerminal",
        enableParallelToolCalling: false,
        isSubagentExecution: false,
        isMultiRootEnabled: false,
        taskState: {} as any,
        messageState: {} as any,
        api: {} as any,
        services: { taskFileTracker: { trackModification: () => {} } } as any,
        autoApprovalSettings: {} as any,
        autoApprover: {} as any,
        browserSettings: {} as any,
        focusChainSettings: {} as any,
        interactions: {} as any,
        callbacks: {
            say: async (_type: string, text?: string) => {
                if (text) {
                    recorder.payloads.push(JSON.parse(text))
                }
            },
        } as any,
        coordinator: {} as any,
        identityFactory: {
            /** Return a stable function identity for this fixture. */
            nextFunctionId: () => "dline_function_language_test",
            /** Return a stable trace identity for this fixture. */
            nextTraceId: () => "dline_tid_language_test",
        },
        capabilityToggles: createTaskCapabilityToggles({}),
    } as TaskConfig
}

function findReferencesBlock(filePath: string): ToolUse {
    return { params: { file_path: filePath, line: 10, character: 5 }, ts: 1 } as unknown as ToolUse
}

function renameBlock(filePath: string): ToolUse {
    return {
        params: { file_path: filePath, line: 10, character: 5, new_name: "newName" },
        ts: 1,
    } as unknown as ToolUse
}

/** A findReferences response carrying the given failure. */
function findReferencesFailure(failureKind: LanguageFailureKind, hasLspSupport = true, errorMessage = "boom") {
    return { references: [], hasLspSupport, errorMessage, failureKind }
}

/** A renameSymbol response carrying the given failure. */
function renameFailure(failureKind: LanguageFailureKind, hasLspSupport = true, errorMessage = "boom") {
    return { success: false, filesChanged: 0, totalChanges: 0, hasLspSupport, errorMessage, preview: [], failureKind }
}

describe("language tool failure reporting", () => {
    let findReferences: ReturnType<typeof vi.fn>
    let renameSymbol: ReturnType<typeof vi.fn>
    let recorder: SayRecorder
    let originalLanguage: PropertyDescriptor | undefined

    beforeEach(() => {
        findReferences = vi.fn()
        renameSymbol = vi.fn()
        recorder = { payloads: [] }
        // HostProvider.language is a static getter reaching into a live host bridge,
        // so replace the descriptor rather than spying on the instance.
        originalLanguage = Object.getOwnPropertyDescriptor(HostProvider, "language")
        Object.defineProperty(HostProvider, "language", {
            configurable: true,
            get: () => ({ findReferences, renameSymbol }),
        })
    })

    afterEach(() => {
        if (originalLanguage) {
            Object.defineProperty(HostProvider, "language", originalLanguage)
        }
    })

    describe("path resolution", () => {
        it("resolves a workspace-relative path to absolute before calling the LSP", async () => {
            findReferences.mockResolvedValue(findReferencesFailure(LanguageFailureKind.LANGUAGE_FAILURE_KIND_NONE, true, ""))

            await new FindReferencesHandler().execute(createMockConfig(recorder), findReferencesBlock("src/app.ts"))

            assert.equal(findReferences.mock.calls.length, 1)
            assert.equal(findReferences.mock.calls[0][0].filePath, path.resolve(CWD, "src/app.ts"))
        })

        it("passes an already absolute path through unchanged", async () => {
            findReferences.mockResolvedValue(findReferencesFailure(LanguageFailureKind.LANGUAGE_FAILURE_KIND_NONE, true, ""))
            const absolute = path.resolve(CWD, "src/app.ts")

            await new FindReferencesHandler().execute(createMockConfig(recorder), findReferencesBlock(absolute))

            assert.equal(findReferences.mock.calls[0][0].filePath, absolute)
        })

        it("resolves the rename path to absolute before calling the LSP", async () => {
            renameSymbol.mockResolvedValue(renameFailure(LanguageFailureKind.LANGUAGE_FAILURE_KIND_NONE, true, ""))

            await new RenameSymbolHandler().execute(createMockConfig(recorder), renameBlock("src/app.ts"))

            assert.equal(renameSymbol.mock.calls.length, 1)
            assert.equal(renameSymbol.mock.calls[0][0].filePath, path.resolve(CWD, "src/app.ts"))
        })
    })

    describe("find_references failure kinds", () => {
        it("reports an invalid path with the offending path, not an LSP error", async () => {
            findReferences.mockResolvedValue(
                findReferencesFailure(LanguageFailureKind.LANGUAGE_FAILURE_KIND_INVALID_PATH, true, "File not found"),
            )

            const result = await new FindReferencesHandler().execute(
                createMockConfig(recorder),
                findReferencesBlock("missing/file.ts"),
            )

            assert.match(String(result), /missing[/\\]file\.ts/)
            assert.doesNotMatch(String(result), /LSP not available/)
        })

        it("reports an out-of-workspace file as an indexing limit, not an LSP error", async () => {
            findReferences.mockResolvedValue(
                findReferencesFailure(LanguageFailureKind.LANGUAGE_FAILURE_KIND_OUTSIDE_WORKSPACE, true, "outside"),
            )

            const result = await new FindReferencesHandler().execute(
                createMockConfig(recorder),
                findReferencesBlock("src/app.ts"),
            )

            assert.match(String(result), /outside the workspace/)
            assert.doesNotMatch(String(result), /LSP not available/)
        })

        it("reports a missing language server without claiming the host lacks LSP", async () => {
            findReferences.mockResolvedValue(
                findReferencesFailure(LanguageFailureKind.LANGUAGE_FAILURE_KIND_NO_LANGUAGE_SUPPORT, true, ""),
            )

            const result = await new FindReferencesHandler().execute(
                createMockConfig(recorder),
                findReferencesBlock("src/app.ts"),
            )

            assert.match(String(result), /no language server/)
            assert.doesNotMatch(String(result), /LSP not available/)
        })

        it("surfaces the provider error message verbatim", async () => {
            findReferences.mockResolvedValue(
                findReferencesFailure(LanguageFailureKind.LANGUAGE_FAILURE_KIND_PROVIDER_ERROR, true, "provider exploded"),
            )

            const result = await new FindReferencesHandler().execute(
                createMockConfig(recorder),
                findReferencesBlock("src/app.ts"),
            )

            assert.match(String(result), /provider exploded/)
            assert.doesNotMatch(String(result), /LSP not available/)
        })

        it("reports LSP unavailable only when the host has no LSP integration", async () => {
            findReferences.mockResolvedValue(
                findReferencesFailure(LanguageFailureKind.LANGUAGE_FAILURE_KIND_NO_LSP_HOST, false, "command not found"),
            )

            const result = await new FindReferencesHandler().execute(
                createMockConfig(recorder),
                findReferencesBlock("src/app.ts"),
            )

            assert.match(String(result), /LSP not available/)
        })

        it("falls back to hasLspSupport when a host omits failure_kind", async () => {
            findReferences.mockResolvedValue({ references: [], hasLspSupport: false, errorMessage: "" } as any)

            const result = await new FindReferencesHandler().execute(
                createMockConfig(recorder),
                findReferencesBlock("src/app.ts"),
            )

            assert.match(String(result), /LSP not available/)
        })
    })

    describe("rename failure kinds", () => {
        it("reports an invalid path with the offending path, not an LSP error", async () => {
            renameSymbol.mockResolvedValue(
                renameFailure(LanguageFailureKind.LANGUAGE_FAILURE_KIND_INVALID_PATH, true, "File not found"),
            )

            const result = await new RenameSymbolHandler().execute(createMockConfig(recorder), renameBlock("missing/file.ts"))

            assert.match(String(result), /missing[/\\]file\.ts/)
            assert.doesNotMatch(String(result), /LSP not available/)
        })

        it("reports a missing language server without claiming the host lacks LSP", async () => {
            renameSymbol.mockResolvedValue(renameFailure(LanguageFailureKind.LANGUAGE_FAILURE_KIND_NO_LANGUAGE_SUPPORT, true, ""))

            const result = await new RenameSymbolHandler().execute(createMockConfig(recorder), renameBlock("src/app.ts"))

            assert.match(String(result), /no language server/)
            assert.doesNotMatch(String(result), /LSP not available/)
        })

        it("reports LSP unavailable only when the host has no LSP integration", async () => {
            renameSymbol.mockResolvedValue(
                renameFailure(LanguageFailureKind.LANGUAGE_FAILURE_KIND_NO_LSP_HOST, false, "command not found"),
            )

            const result = await new RenameSymbolHandler().execute(createMockConfig(recorder), renameBlock("src/app.ts"))

            assert.match(String(result), /LSP not available/)
        })
    })

    describe("successful lookup", () => {
        it("keeps the tool payload shape and reports references relative to cwd", async () => {
            findReferences.mockResolvedValue({
                references: [
                    {
                        filePath: path.resolve(CWD, "src/app.ts"),
                        startLine: 10,
                        startCharacter: 5,
                        endLine: 10,
                        endCharacter: 12,
                        contextLine: "const value = target()",
                    },
                ],
                hasLspSupport: true,
                errorMessage: "",
                failureKind: LanguageFailureKind.LANGUAGE_FAILURE_KIND_NONE,
            })
            const config = createMockConfig(recorder)

            const result = await new FindReferencesHandler().execute(config, findReferencesBlock("src/app.ts"))

            assert.match(String(result), /src[/\\]app\.ts/)
            const payload = recorder.payloads.at(-1)
            assert.equal(payload?.tool, "findReferences")
            assert.equal(payload?.count, 1)
            assert.equal(payload?.files, 1)
            assert.ok(Array.isArray(payload?.references))
        })

        it("names the symbol at the reference column, not the first word of the line", async () => {
            findReferences.mockResolvedValue({
                references: [
                    {
                        filePath: path.resolve(CWD, "src/app.ts"),
                        // "export class ToolExecutor {" — ToolExecutor starts at 1-based column 14.
                        startLine: 45,
                        startCharacter: 14,
                        endLine: 45,
                        endCharacter: 26,
                        contextLine: "export class ToolExecutor {",
                    },
                ],
                hasLspSupport: true,
                errorMessage: "",
                failureKind: LanguageFailureKind.LANGUAGE_FAILURE_KIND_NONE,
            })

            await new FindReferencesHandler().execute(createMockConfig(recorder), findReferencesBlock("src/app.ts"))

            assert.equal(recorder.payloads.at(-1)?.symbolName, "ToolExecutor")
        })
    })
})
