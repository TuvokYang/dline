import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { edgeKey, isUnder, productionFiles, scanImportGraph } from "../../__tests__/architecture/import-graph"

const REPO = path.resolve(__dirname, "../../../../..")
const ROOT = path.join(REPO, "src/core/task/kernel")
const EDGES = scanImportGraph({
    repoRoot: REPO,
    tsconfigPath: path.join(REPO, "tsconfig.json"),
    roots: [ROOT],
})

describe("task kernel import graph", () => {
    it("contains no production dependency outside the kernel package", () => {
        const violations = EDGES.filter((edge) => edge.target.kind !== "workspace" || !isUnder(edge.target.absolute, ROOT)).map(
            edgeKey,
        )
        expect(violations).toEqual([])
    })

    it("contains no async, clock, random or IO primitive", () => {
        const forbidden =
            /\b(?:Promise|Date|Math\.random|setTimeout|setInterval)\b|\b(?:fetch|readFile|writeFile|exec|spawn)\s*\(/
        const violations = productionFiles([ROOT])
            .filter((file) => forbidden.test(readFileSync(file, "utf8")))
            .map((file) => path.relative(ROOT, file))
        expect(violations).toEqual([])
    })
})
