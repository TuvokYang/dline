import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { withSignalSafeCleanup } from "./signal-safe-cleanup.mjs"

const __filename = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url)
const { createVSIX } = require("@vscode/vsce")
const { pack: packVSIX } = require("@vscode/vsce/out/package.js")

const BUILD_AND_PACK = "build-and-pack"
const PACK_ONLY = "pack-only"
const WORKER_ARGUMENT = "--vsce-worker"
const SUPPORTED_MODES = new Set([BUILD_AND_PACK, PACK_ONLY])
const PACKAGE_SECRET_ALLOWLIST = ["sendgrid"]

/**
 * Validate and normalize one VSIX packaging request.
 *
 * @param {{ cwd: string, mode: "build-and-pack"|"pack-only", packagePath?: string|null, preRelease?: boolean }} options
 *   `preRelease` marks the package for the Marketplace pre-release track of
 *   the same extension ID (`Microsoft.VisualStudio.Code.PreRelease`).
 */
function normalizeOptions({ cwd, mode, packagePath = null, preRelease = false }) {
    if (!cwd) {
        throw new Error("VSIX packaging requires a working directory.")
    }
    if (!SUPPORTED_MODES.has(mode)) {
        throw new Error(`Unsupported VSIX packaging mode '${mode ?? ""}'.`)
    }
    return { cwd, mode, packagePath, preRelease: preRelease === true }
}

/** Keep repository language ownership unchanged while VSCE reads the English root changelog. */
export async function withEnglishChangelog(cwd, work, options = {}) {
    const { fileSystem = fs, cleanups: outerCleanups, ...cleanupOptions } = options
    const chinesePath = path.join(cwd, "CHANGELOG.md")
    const englishPath = path.join(cwd, "docs", "changelog", "CHANGELOG_en.md")
    const chinese = fileSystem.readFileSync(chinesePath)
    const english = fileSystem.readFileSync(englishPath)
    const swapAndPack = (cleanups) => {
        // Register restoration before writing, including partial replacement failures.
        cleanups.defer(() => fileSystem.writeFileSync(chinesePath, chinese))
        fileSystem.writeFileSync(chinesePath, english)
        return work()
    }
    return outerCleanups ? swapAndPack(outerCleanups) : withSignalSafeCleanup(swapAndPack, cleanupOptions)
}

/**
 * Call VSCE inside an isolated Node process.
 *
 * VSCE terminates the process for some validation failures. Keeping that
 * behavior in a worker guarantees the parent can still restore temporary
 * package.json and README mutations.
 *
 * @param {{ cwd: string, mode: "build-and-pack"|"pack-only", packagePath?: string|null, preRelease?: boolean,
 *   cleanups?: import("./signal-safe-cleanup.mjs").SynchronousCleanupStack }} options
 * @returns {Promise<{ packagePath: string|null }>}
 */
export async function packageVsix(options) {
    const normalized = normalizeOptions(options)
    return withEnglishChangelog(
        normalized.cwd,
        () => {
            execFileSync(process.execPath, [__filename, WORKER_ARGUMENT, JSON.stringify(normalized)], {
                cwd: normalized.cwd,
                stdio: "inherit",
            })
            return { packagePath: normalized.packagePath }
        },
        { cleanups: options.cleanups },
    )
}

/** @param {{ cwd: string, mode: "build-and-pack"|"pack-only", packagePath: string|null, preRelease: boolean }} options */
async function runWorker(options) {
    const packageOptions = {
        cwd: options.cwd,
        dependencies: false,
        allowPackageSecrets: PACKAGE_SECRET_ALLOWLIST,
        preRelease: options.preRelease,
    }
    if (options.packagePath) {
        packageOptions.packagePath = options.packagePath
    }

    if (options.mode === BUILD_AND_PACK) {
        await createVSIX(packageOptions)
    } else {
        await packVSIX(packageOptions)
    }
}

const invokedAsWorker =
    process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename) && process.argv[2] === WORKER_ARGUMENT
if (invokedAsWorker) {
    const options = normalizeOptions(JSON.parse(process.argv[3] ?? "{}"))
    await runWorker(options)
}
