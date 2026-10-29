import path from "node:path"
import { describe, expect, it } from "vitest"
import { edgeKey, scanImportGraph } from "../__tests__/architecture/import-graph"

const REPO = path.resolve(__dirname, "../../../..")
const TASK_ROOT = path.join(REPO, "src/core/task")
const TASK_INDEX = "src/core/task/index.ts"

describe("ToolResponse import boundary", () => {
    it("keeps ToolResponse consumers on the leaf type instead of the task barrel", () => {
        const violations = scanImportGraph({
            repoRoot: REPO,
            tsconfigPath: path.join(REPO, "tsconfig.json"),
            roots: [TASK_ROOT],
        })
            .filter((edge) => edge.target.kind === "workspace" && edge.target.path === TASK_INDEX)
            .filter((edge) => edge.bindings.some((binding) => binding.imported === "ToolResponse"))
            .map(edgeKey)
        expect(violations).toEqual([])
    })
})
