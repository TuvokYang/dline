import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, type Page } from "@playwright/test"

/**
 * A three-file TypeScript project whose exported function is imported by two other files,
 * so a language-server rename at the declaration has to edit every importer.
 */
export const RENAME_PROJECT = {
    oldName: "calcTotal",
    newName: "computeOrderTotal",
    definitionPath: "src/pricing.ts",
    /** 1-based position of the name in `export function calcTotal(`. */
    definitionLine: 1,
    definitionCharacter: "export function ".length + 1,
    importerPaths: ["src/cart.ts", "src/checkout.ts"],
} as const

const { oldName } = RENAME_PROJECT

const PROJECT_FILES: Readonly<Record<string, string>> = {
    "tsconfig.json": `${JSON.stringify(
        {
            // `types: []` keeps @types packages from ancestor folders out of the project.
            compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, types: [] },
            include: ["src"],
        },
        null,
        2,
    )}\n`,
    [RENAME_PROJECT.definitionPath]: [
        `export function ${oldName}(prices: number[], taxRate: number): number {`,
        "    const subtotal = prices.reduce((sum, price) => sum + price, 0)",
        "    return subtotal * (1 + taxRate)",
        "}",
        "",
    ].join("\n"),
    [RENAME_PROJECT.importerPaths[0]]: [
        `import { ${oldName} } from "./pricing"`,
        "",
        "export function cartSummary(prices: number[]): string {",
        `    return \`Total: \${${oldName}(prices, 0.08).toFixed(2)}\``,
        "}",
        "",
    ].join("\n"),
    [RENAME_PROJECT.importerPaths[1]]: [
        `import { ${oldName} } from "./pricing"`,
        "",
        "export function chargeAmount(prices: number[], taxRate: number): number {",
        `    return Math.round(${oldName}(prices, taxRate) * 100)`,
        "}",
        "",
    ].join("\n"),
}

export const RENAME_PROJECT_SOURCES = [RENAME_PROJECT.definitionPath, ...RENAME_PROJECT.importerPaths]

export async function seedRenameProject(workspaceDir: string): Promise<void> {
    for (const [relativePath, content] of Object.entries(PROJECT_FILES)) {
        const absolutePath = path.join(workspaceDir, relativePath)
        await mkdir(path.dirname(absolutePath), { recursive: true })
        await writeFile(absolutePath, content, "utf8")
    }
}

export async function readRenameProjectSources(workspaceDir: string): Promise<string[]> {
    return Promise.all(RENAME_PROJECT_SOURCES.map((relativePath) => readFile(path.join(workspaceDir, relativePath), "utf8")))
}

/**
 * Wait until the TypeScript service answers semantic requests for the open importer. A rename
 * issued while the project is still loading would only see the open file.
 */
export async function waitForTypeScriptService(page: Page): Promise<void> {
    const symbolToken = page
        .locator(".part.editor .view-line span")
        .filter({ hasText: new RegExp(`^${oldName}$`) })
        .first()
    // A resolved hover shows the signature, as `function calcTotal(` at a call or `(alias) calcTotal(`
    // at the import; the loading placeholder shows only `import calcTotal`.
    const symbolHover = page.locator(".monaco-hover-content").filter({ hasText: `${oldName}(` })
    await expect(async () => {
        // A hover requested while the project loads stays "(loading...)"; leave the token so
        // the next attempt issues a fresh hover request.
        await page.keyboard.press("Escape")
        await page.mouse.move(0, 0)
        await symbolToken.hover()
        await expect(symbolHover).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 90_000 })
    await page.keyboard.press("Escape")
}
