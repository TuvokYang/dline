import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const TEST_DIRECTORY_ENVIRONMENT_KEYS = ["DLINE_DIR", "DLINE_HOME_DIR", "DLINE_DOCS_DIR"] as const

/** Give one Vitest file isolated Dline state/provider and docs directories. */
export function installIsolatedTestDirectories(scope: string): () => void {
    const safeScope = scope.replaceAll(/[^A-Za-z0-9_-]/g, "-")
    const root = mkdtempSync(path.join(os.tmpdir(), `dline-vitest-${safeScope}-`))
    const previous = Object.fromEntries(TEST_DIRECTORY_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]))
    const dlineDir = path.join(root, "dline")
    const directories = {
        DLINE_DIR: dlineDir,
        DLINE_HOME_DIR: dlineDir,
        DLINE_DOCS_DIR: path.join(root, "docs"),
    }

    for (const [key, directory] of Object.entries(directories)) {
        mkdirSync(directory, { recursive: true })
        process.env[key] = directory
    }

    return () => {
        for (const key of TEST_DIRECTORY_ENVIRONMENT_KEYS) {
            const value = previous[key]
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
}
