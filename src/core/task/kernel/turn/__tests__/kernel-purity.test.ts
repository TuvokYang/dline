import path from "node:path"
import { describe, expect, it } from "vitest"
import { edgeKey, isUnder, productionFiles, scanImportGraph } from "../../../__tests__/architecture/import-graph"

const REPO = path.resolve(__dirname, "../../../../../..")
const KERNEL_DIR = path.join(REPO, "src/core/task/kernel")
const TURN_DIR = path.join(KERNEL_DIR, "turn")
const EDGES = scanImportGraph({
    repoRoot: REPO,
    tsconfigPath: path.join(REPO, "tsconfig.json"),
    roots: [TURN_DIR],
})

describe("kernel purity", () => {
    it("finds the kernel modules", () => {
        expect(productionFiles([TURN_DIR]).length).toBeGreaterThanOrEqual(3)
    })

    it("imports only modules inside the kernel package", () => {
        const violations = EDGES.filter(
            (edge) => edge.target.kind !== "workspace" || !isUnder(edge.target.absolute, KERNEL_DIR),
        ).map(edgeKey)
        expect(violations).toEqual([])
    })

    it("exercises the kernel without constructing a Task", async () => {
        const { resolveToolLanes } = await import("../tool-lanes")
        const { decideAdmission } = await import("../pool-admission")
        const { resolveApprovalKind } = await import("../approval-kind")
        const { DEFAULT_AUTO_APPROVAL_SETTINGS } = await import("@shared/AutoApprovalSettings")
        const { DlineDefaultTool } = await import("@shared/tools")

        const lanes = resolveToolLanes(DlineDefaultTool.FILE_EDIT, { canonicalWritePaths: ["/repo/a.ts"] })
        const admission = decideAdmission({
            pending: [{ dlineTid: "a", index: 0, lanes, isTurnEnding: false }],
            running: [],
            limit: 2,
        })
        const approval = resolveApprovalKind({
            toolName: DlineDefaultTool.FILE_EDIT,
            settings: DEFAULT_AUTO_APPROVAL_SETTINGS,
        })

        expect(admission.admit).toHaveLength(1)
        expect(approval.scope).toBe("edit_workspace")
    })
})
