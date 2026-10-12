import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { productionFiles, scanImportGraph } from "../../__tests__/architecture/import-graph"
import { TASK_101_FIELDS } from "../../__tests__/architecture/task-field-closure"

const REPO = path.resolve(__dirname, "../../../../..")
const TASK_INDEX = path.join(REPO, "src/core/task/index.ts")
const TASK_INDEX_PATH = "src/core/task/index.ts"
const SOURCE_ROOTS = [path.join(REPO, "src"), path.join(REPO, "webview-ui/src")]
const IMPORT_GRAPH = scanImportGraph({
    repoRoot: REPO,
    tsconfigPath: path.join(REPO, "tsconfig.json"),
    roots: SOURCE_ROOTS,
})

const EXPECTED_TASK_FIELDS = TASK_101_FIELDS

const EXPECTED_TASK_INDEX_CONSUMERS = [] as const

const EXPECTED_TASK_VIEW_FILES = [
    "src/core/controller/index.ts",
    "src/core/controller/task/HistoryDisplaySession.ts",
    "src/core/controller/task/TaskViewMessageAdapter.ts",
    "src/core/controller/task/history-task-readiness.ts",
    "src/core/controller/task/readOnlyTaskView.ts",
    "src/shared/ExtensionMessage.ts",
    "webview-ui/src/components/chat/ChatRow.tsx",
    "webview-ui/src/components/chat/ChatView.tsx",
    "webview-ui/src/components/chat/SubagentStatusRow.tsx",
    "webview-ui/src/components/chat/chat-view/components/layout/MessagesArea.stories.tsx",
    "webview-ui/src/components/chat/chat-view/components/layout/MessagesArea.tsx",
    "webview-ui/src/components/chat/chat-view/utils/messageUtils.ts",
    "webview-ui/src/components/chat/input/TaskRuntimeControls.tsx",
    "webview-ui/src/components/chat/task-header/ModelSwitcher.tsx",
    "webview-ui/src/components/chat/task-header/TaskHeader.tsx",
    "webview-ui/src/config/storybook/chatStoryFixtures.ts",
    "webview-ui/src/context/ExtensionStateContext.tsx",
    "webview-ui/src/hooks/useHistoryTaskOpening.ts",
    "webview-ui/src/hooks/useTaskCapabilityToggles.ts",
    "webview-ui/src/services/task-messages.ts",
    "webview-ui/src/task-interaction/FooterActions.tsx",
    "webview-ui/src/task-interaction/InteractionHost.tsx",
    "webview-ui/src/task-interaction/types.ts",
] as const

function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

function taskIndexConsumers(): string[] {
    return IMPORT_GRAPH.filter((edge) => edge.target.kind === "workspace" && edge.target.path === TASK_INDEX_PATH)
        .map((edge) => edge.importer)
        .filter((file, index, files) => files.indexOf(file) === index)
        .sort()
}

function taskViewFiles(): string[] {
    return productionFiles(SOURCE_ROOTS)
        .filter((file) => /\b(?:TaskViewState|taskViewState)\b/.test(stripComments(readFileSync(file, "utf8"))))
        .map((file) => path.relative(REPO, file).replaceAll("\\", "/"))
        .sort()
}

describe("TASK-101 machine inventories", () => {
    it("confirms the activation-baseline god Task class was dissolved by TASK-107", () => {
        // EXPECTED_TASK_FIELDS remains the frozen TASK-101 record of what the
        // god class owned; the thin index must never grow that class back.
        const source = readFileSync(TASK_INDEX, "utf8")
        expect(source.includes("export class Task")).toBe(false)
        expect(source.split("\n").length).toBeLessThan(1000)
        expect(EXPECTED_TASK_FIELDS).toHaveLength(109)
    })

    it("locks direct, barrel-resolved and dynamic production consumers of task index", () => {
        expect(taskIndexConsumers()).toEqual([...EXPECTED_TASK_INDEX_CONSUMERS].sort())
    })

    it("locks every production TaskViewState type or field consumer", () => {
        expect(taskViewFiles()).toEqual([...EXPECTED_TASK_VIEW_FILES].sort())
    })

    it("keeps every kernel production file below the 1000-line architecture limit", () => {
        const kernelRoot = path.join(REPO, "src/core/task/kernel")
        const oversized = productionFiles([kernelRoot])
            .map((file) => ({
                file: path.relative(REPO, file).replaceAll("\\", "/"),
                lines: readFileSync(file, "utf8").split(/\r?\n/).length,
            }))
            .filter((entry) => entry.lines >= 1000)
        expect(oversized).toEqual([])
    })
})
