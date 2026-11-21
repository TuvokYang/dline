import fs from "node:fs"
import path from "node:path"
import { readChangelog } from "./changelog.mjs"
import { pinRepositoryLinks, repositoryPathUrl } from "./marketplace-readme.mjs"
import { withSignalSafeCleanup } from "./signal-safe-cleanup.mjs"
import { renderChangelogs } from "./vsix-changelog.mjs"

/**
 * The four generated documents of one VSIX package.
 *
 * English is the two official VSCE assets: the adapter hands `readmePath` and
 * `changelogPath` to VSCE, whose ReadmeProcessor and ChangelogProcessor rename
 * them to `extension/readme.md` and `extension/changelog.md`. The Chinese
 * editions stay ordinary files under `extension/dist/docs/`, so each language is
 * exactly one document and no English source copy is kept.
 */
export const PACKAGE_DOCUMENTS = {
    readmeEnglish: "dist/docs/README.en.md",
    readmeChinese: "dist/docs/README.zh-CN.md",
    changelogEnglish: "dist/docs/CHANGELOG.en.md",
    changelogChinese: "dist/docs/CHANGELOG.zh-CN.md",
}

/** Read-only README sources: the Marketplace listing and its Chinese edition. */
const README_SOURCES = {
    english: "README.marketplace.md",
    chinese: "marketplace.zh-cn.md",
}

/** Language labels of the changelog navigation line, as a reader sees them. */
const LANGUAGE_LABELS = { english: "English", chinese: "中文" }

/**
 * Read one source that must never be modified.
 *
 * @param {import("node:fs")} fileSystem File system to read through.
 * @param {string} cwd Working directory the sources live in.
 * @param {string} relativePath Source path relative to `cwd`.
 * @param {string} label Description used in failure messages.
 * @returns {string} Source text.
 */
function readSource(fileSystem, cwd, relativePath, label) {
    try {
        return fileSystem.readFileSync(path.join(cwd, relativePath), "utf8")
    } catch (error) {
        throw new Error(`${label} '${relativePath}' could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
}

/**
 * Online navigation line for one changelog language.
 *
 * The line names the other language's actual maintained source at the packaged
 * ref and lands on the section this package documents, so a reader reaches a page
 * Git really serves. The generated `dist/docs` copies are never linked: they are
 * not committed. The current language is plain text, so the line never pretends
 * to switch languages inside the package.
 *
 * The linked path is the source the reader actually selected, so a package of a
 * current section points at the current notes and one of an archived version
 * points at that version's snapshot.
 *
 * @param {"english"|"chinese"} language Language of the document being rendered.
 * @param {string} repositoryUrl Repository web URL from the effective manifest.
 * @param {string} ref Exact tag or commit the package documents.
 * @param {string} anchor GFM anchor of the selected content section.
 * @param {{ english: { sourcePath: string }, chinese: { sourcePath: string } }} notes Validated notes.
 * @returns {string}
 */
function navigationLine(language, repositoryUrl, ref, anchor, notes) {
    const other = language === "english" ? "chinese" : "english"
    const link = `[${LANGUAGE_LABELS[other]}](${repositoryPathUrl(repositoryUrl, ref, "blob", notes[other].sourcePath)}#${anchor})`
    return language === "english" ? `${LANGUAGE_LABELS.english} | ${link}` : `${link} | ${LANGUAGE_LABELS.chinese}`
}

/**
 * Render all four documents before anything is written.
 *
 * Every read, pin and section validation happens here, so a missing source, a
 * missing repository or ref, or an unusable release section leaves the working
 * directory untouched.
 *
 * @param {{ cwd: string, fileSystem: import("node:fs"), section: string, displayVersion: string,
 *   repositoryUrl: string, ref: string }} request Validated generation inputs.
 * @returns {[string, string][]} Document path and contents, in write order.
 */
function renderDocuments({ cwd, fileSystem, section, displayVersion, repositoryUrl, ref }) {
    const readme = {
        english: readSource(fileSystem, cwd, README_SOURCES.english, "Marketplace README source"),
        chinese: readSource(fileSystem, cwd, README_SOURCES.chinese, "Chinese README source"),
    }

    // One read serves both languages: the shared reader locates the current notes,
    // applies the single section/fence/duplicate rule, and refuses a half-translated
    // section. A normal package reads only the current notes and never the history.
    const notes = readChangelog({ root: cwd, version: section, source: "current", fileSystem })

    const navigation = {
        english: navigationLine("english", repositoryUrl, ref, notes.anchor, notes),
        chinese: navigationLine("chinese", repositoryUrl, ref, notes.anchor, notes),
    }
    const rendered = renderChangelogs({ section: notes.version, displayVersion, navigation, notes })

    return [
        [PACKAGE_DOCUMENTS.readmeEnglish, pinRepositoryLinks(readme.english, repositoryUrl, ref)],
        [PACKAGE_DOCUMENTS.readmeChinese, pinRepositoryLinks(readme.chinese, repositoryUrl, ref)],
        [PACKAGE_DOCUMENTS.changelogEnglish, rendered.english],
        [PACKAGE_DOCUMENTS.changelogChinese, rendered.chinese],
    ]
}

/**
 * Create `dist/docs` and write one document under a restore registration.
 *
 * The previous bytes, when a document already exists, are captured before the
 * write so the shared cleanup stack restores them exactly. A file this call never
 * touched is not listed here and is therefore never removed.
 *
 * @param {{ cwd: string, fileSystem: import("node:fs") }} request Write target.
 * @param {import("./signal-safe-cleanup.mjs").SynchronousCleanupStack} cleanups Shared lifecycle owner.
 * @param {string} relativePath Generated document path.
 * @param {string} contents Rendered document.
 */
function writeDocument({ cwd, fileSystem }, cleanups, relativePath, contents) {
    const outputPath = path.join(cwd, relativePath)
    // Register before writing so a partial write is already covered.
    const previous = fileSystem.existsSync(outputPath) ? fileSystem.readFileSync(outputPath) : null
    cleanups.defer(() => {
        if (previous === null) fileSystem.rmSync(outputPath, { force: true })
        else fileSystem.writeFileSync(outputPath, previous)
    })
    fileSystem.writeFileSync(outputPath, contents, "utf8")
}

/**
 * Generate the four language-split documents and own them for one package.
 *
 * The README sources and the current changelog are only read. Every document is
 * rendered and validated first, so nothing is written when a source, a ref, a
 * repository or a content section is unusable. Each document is registered with
 * the shared cleanup stack immediately before its own write, so a failure on the
 * second, third or fourth document releases everything this call touched,
 * restores pre-existing output byte for byte, and never starts the packaging
 * worker. Files this call did not generate - an older `dist/CHANGELOG.vsix.md` or
 * any foreign file - are preserved on disk and left to the packaging ignore rules.
 *
 * @template T
 * @param {{ cwd: string, section: string, displayVersion: string, repositoryUrl: string, ref: string }} request
 *   Working directory, selected content section, displayed version, repository and
 *   the exact ref every generated link is pinned to.
 * @param {(generated: { readmePath: string, changelogPath: string }) => T | Promise<T>} work
 *   Packaging work that receives the two official VSCE asset paths.
 * @param {{
 *   fileSystem?: import("node:fs"),
 *   cleanups?: import("./signal-safe-cleanup.mjs").SynchronousCleanupStack,
 * } & Parameters<typeof withSignalSafeCleanup>[1]} [options]
 * @returns {Promise<T>}
 */
export async function withPackageDocs(request, work, options = {}) {
    const { cwd, section, displayVersion, repositoryUrl, ref } = request
    if (!cwd) {
        throw new Error("Packaged documentation generation requires a working directory.")
    }
    // Both values only ever come from a caller, so a missing one is a caller error
    // that must fail before any read, pin, render or write.
    if (!repositoryUrl) {
        throw new Error("Packaged documentation generation requires the manifest repository URL; none was given.")
    }
    if (!ref) {
        throw new Error("Packaged documentation generation requires the documentation ref; none was given.")
    }
    const { fileSystem = fs, cleanups: outerCleanups, ...cleanupOptions } = options

    /** @param {import("./signal-safe-cleanup.mjs").SynchronousCleanupStack} cleanups */
    const generate = (cleanups) => {
        const documents = renderDocuments({ cwd, fileSystem, section, displayVersion, repositoryUrl, ref })

        fileSystem.mkdirSync(path.join(cwd, path.dirname(PACKAGE_DOCUMENTS.readmeEnglish)), { recursive: true })
        for (const [relativePath, contents] of documents) {
            writeDocument({ cwd, fileSystem }, cleanups, relativePath, contents)
        }
        return work({ readmePath: PACKAGE_DOCUMENTS.readmeEnglish, changelogPath: PACKAGE_DOCUMENTS.changelogEnglish })
    }

    return outerCleanups ? generate(outerCleanups) : withSignalSafeCleanup(generate, cleanupOptions)
}
