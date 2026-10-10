import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const REPOSITORY_ROOT = path.resolve(__dirname, "../../../..")
const SCANNED_ROOTS = ["src", "webview-ui/src"]
/** Generated wire projections mirror the Proto contract; they are not a second domain authority. */
const GENERATED_ROOTS = ["src/shared/proto", "src/generated"].map((root) => path.join(REPOSITORY_ROOT, root))
const DOCUMENT_CONTRACT = path.join(REPOSITORY_ROOT, "src/shared/input-semantics/document.ts")
const DIAGNOSTIC_CONTRACT = path.join(REPOSITORY_ROOT, "src/shared/input-semantics/diagnostics.ts")
/** Each contract type and the one module allowed to declare it. */
const CONTRACT_HOMES: Readonly<Record<string, string>> = {
    SemanticInputDocument: DOCUMENT_CONTRACT,
    SemanticInputNode: DOCUMENT_CONTRACT,
    LiteralInputNode: DOCUMENT_CONTRACT,
    InputSource: DOCUMENT_CONTRACT,
    InputResourceOwner: DOCUMENT_CONTRACT,
    SemanticResourceRef: DOCUMENT_CONTRACT,
    SemanticInputDiagnostic: DIAGNOSTIC_CONTRACT,
    SemanticInputDiagnosticCode: DIAGNOSTIC_CONTRACT,
}
// A declaration, not a type-only import specifier such as `import { type SemanticInputDocument }`.
const DECLARATION = new RegExp(
    `^\\s*(?:export\\s+)?(?:declare\\s+)?(?:interface|type|class)\\s+(${Object.keys(CONTRACT_HOMES).join("|")})\\b(?=\\s*(?:[={<]|extends\\b))`,
    "gm",
)

function sourceFiles(directory: string): string[] {
    if (GENERATED_ROOTS.some((root) => directory.startsWith(root))) return []
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(directory, entry.name)
        if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(entryPath)
        return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [entryPath] : []
    })
}

describe("semantic input contract authority", () => {
    it("declares every contract type exactly once, in its own module", () => {
        const declarations = SCANNED_ROOTS.flatMap((root) => sourceFiles(path.join(REPOSITORY_ROOT, root))).flatMap((file) =>
            [...fs.readFileSync(file, "utf8").matchAll(DECLARATION)].map((match) => ({ file, name: match[1] })),
        )

        const misplaced = declarations.filter((declaration) => declaration.file !== CONTRACT_HOMES[declaration.name])
        expect(
            misplaced.map((declaration) => `${path.relative(REPOSITORY_ROOT, declaration.file)}: ${declaration.name}`),
        ).toEqual([])
        expect(declarations.map((declaration) => declaration.name).sort()).toEqual(Object.keys(CONTRACT_HOMES).sort())
    })
})
