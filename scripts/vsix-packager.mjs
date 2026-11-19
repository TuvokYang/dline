import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { withPackageDocs } from "./package-docs.mjs"

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
 * Normalize one generated document path handed to VSCE.
 *
 * The path is relative to the packaged working directory and always uses forward
 * slashes, so the parent's value survives both normalizations and the worker and
 * VSCE agree on the same file.
 *
 * @param {string} value Relative path of a generated document.
 * @param {string} name Field name used in failure messages.
 * @returns {string}
 */
function normalizeDocumentPath(value, name) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`VSIX packaging requires the generated ${name}.`)
    }
    const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "")
    if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
        throw new Error(`The generated ${name} '${value}' must stay inside the packaged directory.`)
    }
    return normalized
}

/**
 * Validate and normalize one VSIX packaging request.
 *
 * `changelogSection` and `documentationRef` are the content section and the
 * revision an entry selected; this adapter never derives either. `readmePath` and
 * `changelogPath` are set only once this call's documents exist, so a request
 * without them is a caller error rather than a package without documentation.
 *
 * @param {{ cwd: string, mode: "build-and-pack"|"pack-only", packagePath?: string|null, preRelease?: boolean,
 *   changelogSection?: string|null, documentationRef?: string|null,
 *   readmePath?: string|null, changelogPath?: string|null }} options
 *   `preRelease` marks the package for the Marketplace pre-release track of
 *   the same extension ID (`Microsoft.VisualStudio.Code.PreRelease`).
 */
function normalizeOptions(options) {
    const {
        cwd,
        mode,
        packagePath = null,
        preRelease = false,
        changelogSection = null,
        documentationRef = null,
        readmePath = null,
        changelogPath = null,
    } = options
    if (!cwd) {
        throw new Error("VSIX packaging requires a working directory.")
    }
    if (!SUPPORTED_MODES.has(mode)) {
        throw new Error(`Unsupported VSIX packaging mode '${mode ?? ""}'.`)
    }
    return {
        cwd,
        mode,
        packagePath,
        preRelease: preRelease === true,
        changelogSection: changelogSection ?? null,
        documentationRef: documentationRef ?? null,
        readmePath: readmePath === null ? null : normalizeDocumentPath(readmePath, "readme path"),
        changelogPath: changelogPath === null ? null : normalizeDocumentPath(changelogPath, "changelog path"),
    }
}

/**
 * Read the documented facts from the effective manifest.
 *
 * Entries rewrite `package.json` for their channel before requesting a package, so
 * this is the packaged version, not the source version. The repository URL is the
 * one the generated documents link against, so it comes from the same manifest the
 * worker packages.
 *
 * @param {string} cwd Working directory holding the effective manifest.
 * @returns {{ version: string, repositoryUrl: string }} Displayed version and repository web URL.
 */
function readManifestFacts(cwd) {
    const manifestPath = path.join(cwd, "package.json")
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    if (typeof manifest.version !== "string" || !manifest.version.trim()) {
        throw new Error(`${manifestPath} declares no version to display in the VSIX changelog.`)
    }
    const declared = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url
    if (typeof declared !== "string" || !declared.trim()) {
        throw new Error(`${manifestPath} declares no repository; the packaged documentation links cannot be built.`)
    }
    return {
        version: manifest.version.trim(),
        repositoryUrl: declared
            .trim()
            .replace(/^git\+/, "")
            .replace(/\.git$/, "")
            .replace(/\/$/, ""),
    }
}

/**
 * Generate this package's four documents, then hand the two official paths to VSCE.
 *
 * The English documents are the only official Readme and Changelog assets; the
 * Chinese editions ship as ordinary files. Generation of all four completes before
 * the worker starts, the paths are normalized again after generation, and the
 * shared cleanup owner releases every generated file, so no history source is ever
 * rewritten.
 *
 * @param {{ cwd: string, mode: "build-and-pack"|"pack-only", packagePath?: string|null, preRelease?: boolean,
 *   changelogSection: string, documentationRef: string,
 *   cleanups?: import("./signal-safe-cleanup.mjs").SynchronousCleanupStack }} options
 * @returns {Promise<{ packagePath: string|null }>}
 */
export async function packageVsix(options) {
    const normalized = normalizeOptions(options)
    if (!normalized.changelogSection) {
        throw new Error("VSIX packaging requires an explicit changelog content section; entries must select one.")
    }
    if (!normalized.documentationRef) {
        throw new Error("VSIX packaging requires the documentation ref; entries must select one.")
    }
    const { version, repositoryUrl } = readManifestFacts(normalized.cwd)
    return withPackageDocs(
        {
            cwd: normalized.cwd,
            section: normalized.changelogSection,
            displayVersion: version,
            repositoryUrl,
            ref: normalized.documentationRef,
        },
        ({ readmePath, changelogPath }) => {
            const request = normalizeOptions({ ...normalized, readmePath, changelogPath })
            execFileSync(process.execPath, [__filename, WORKER_ARGUMENT, JSON.stringify(request)], {
                cwd: normalized.cwd,
                stdio: "inherit",
            })
            return { packagePath: normalized.packagePath }
        },
        { cleanups: options.cleanups },
    )
}

/**
 * Call VSCE inside an isolated Node process.
 *
 * VSCE terminates the process for some validation failures. Keeping that
 * behavior in a worker guarantees the parent can still release temporary
 * package.json state and every generated document.
 *
 * @param {{ cwd: string, mode: "build-and-pack"|"pack-only", packagePath: string|null, preRelease: boolean,
 *   readmePath: string, changelogPath: string }} options
 */
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
    // VSCE's ReadmeProcessor and ChangelogProcessor rename the selected files to
    // the two official `extension/readme.md` and `extension/changelog.md` assets.
    // The explicit paths do not cancel ignore rules, so `.vscodeignore` must keep
    // the generated files collectable.
    //
    // Without explicit paths, VSCE falls back to the root README and can omit the
    // changelog. Require both generated paths instead of silently packaging the
    // repository landing page or dropping an asset.
    if (!options.readmePath || !options.changelogPath) {
        throw new Error("The VSCE worker requires both generated document paths; refusing to package without them.")
    }
    packageOptions.readmePath = options.readmePath
    packageOptions.changelogPath = options.changelogPath

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
