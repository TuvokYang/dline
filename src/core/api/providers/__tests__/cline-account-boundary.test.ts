import { readFileSync } from "node:fs"
import path from "node:path"
import { Project } from "ts-morph"
import { describe, expect, it } from "vitest"

const PROVIDER_BOUNDARY_FILES = [
    "src/core/api/providers/cline.ts",
    "src/core/model-registry/remote/vendors/cline.ts",
    "webview-ui/src/components/settings/providers/ClineProvider.tsx",
    "webview-ui/src/components/chat/ApiFailureContent.tsx",
]

const FORBIDDEN_IMPORT_ROOTS = ["@/config", "@/services/account", "@/services/auth", "@/context/ClineAuthContext"]

function importSpecifiers(relativePath: string): string[] {
    const absolutePath = path.resolve(process.cwd(), relativePath)
    const project = new Project({ useInMemoryFileSystem: true })
    const source = project.createSourceFile(relativePath, readFileSync(absolutePath, "utf8"))
    return source.getImportDeclarations().map((declaration) => declaration.getModuleSpecifierValue())
}

function isForbiddenImport(specifier: string): boolean {
    return FORBIDDEN_IMPORT_ROOTS.some((root) => specifier === root || specifier.startsWith(`${root}/`))
}

describe("Cline Provider account boundary", () => {
    it.each(PROVIDER_BOUNDARY_FILES)("keeps %s independent from Dline Account services", (relativePath) => {
        expect(importSpecifiers(relativePath).filter(isForbiddenImport)).toEqual([])
    })
})
