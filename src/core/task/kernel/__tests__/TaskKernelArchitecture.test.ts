import { readFileSync } from "node:fs"
import path from "node:path"
import { Project } from "ts-morph"
import { describe, expect, it } from "vitest"

const TASK_ROOT = path.resolve(__dirname, "../..")
const ROOTS = [path.join(TASK_ROOT, "kernel"), path.join(TASK_ROOT, "shell"), path.join(TASK_ROOT, "view/canonical")]
const project = new Project({
    tsConfigFilePath: path.resolve(TASK_ROOT, "../../../tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
})
project.addSourceFilesAtPaths(ROOTS.map((root) => path.join(root, "**/*.ts")))

const production = project
    .getSourceFiles()
    .filter((source) => !source.getFilePath().includes("/__tests__/") && !source.getBaseName().endsWith(".test.ts"))

function normalized(filePath: string): string {
    return filePath.replaceAll("\\", "/")
}

describe("task kernel module architecture", () => {
    it("keeps new production files below the absolute 1500-line limit", () => {
        const oversized = production
            .map((source) => ({
                file: path.relative(TASK_ROOT, source.getFilePath()),
                lines: source.getFullText().split(/\r?\n/).length,
            }))
            .filter(({ lines }) => lines >= 1500)
        expect(oversized).toEqual([])
    })

    it("keeps the canonical view dependent only on kernel facts and its own projection model", () => {
        const violations = production
            .filter((source) => normalized(source.getFilePath()).includes("/view/canonical/"))
            .flatMap((source) =>
                source.getImportDeclarations().flatMap((declaration) => {
                    const resolved = declaration.getModuleSpecifierSourceFile()
                    if (!resolved) return []
                    const targetPath = normalized(resolved.getFilePath())
                    return targetPath.includes("/kernel/") || targetPath.includes("/view/canonical/")
                        ? []
                        : [`${normalized(source.getFilePath())} -> ${targetPath}`]
                }),
            )
        expect(violations).toEqual([])
    })

    it("keeps the kernel free of async and IO primitives", () => {
        const forbidden =
            /\b(?:Promise|Date|Math\.random|setTimeout|setInterval)\b|\b(?:fetch|readFile|writeFile|exec|spawn)\s*\(/
        const violations = production
            .filter((source) => normalized(source.getFilePath()).includes("/kernel/"))
            .filter((source) => forbidden.test(readFileSync(source.getFilePath(), "utf8")))
            .map((source) => path.relative(TASK_ROOT, source.getFilePath()))
        expect(violations).toEqual([])
    })
})
