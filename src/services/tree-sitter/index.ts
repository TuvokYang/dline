import type { IgnoreController } from "@core/ignore/IgnoreController"
import type { FileInfo } from "@services/glob/list-files"
import { listFiles } from "@services/glob/list-files"
import { fileExistsAtPath, isDirectory } from "@utils/fs"
import * as fs from "fs/promises"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { LanguageParser, loadRequiredLanguageParsers } from "./languageParser"

// TODO: implement caching behavior to avoid having to keep analyzing project for new tasks.
export async function parseSourceCodeForDefinitionsTopLevel(
    dirPath: string,
    ignoreController?: IgnoreController,
): Promise<string> {
    // ensure input is a directory before listing files
    const resolvedPath = path.resolve(dirPath)
    if (!(await isDirectory(resolvedPath))) {
        if (await fileExistsAtPath(resolvedPath)) {
            return `The provided path is a file, not a directory. To view this file use read_file instead, or pass the parent directory to list_code_definition_names.`
        }
        return "This directory does not exist or you do not have permission to access it."
    }

    // Get all files at top level (workspace rules already applied)
    const [allFiles, _] = await listFiles(dirPath, false, 200, { ignoreController })

    let result = ""

    // Separate files to parse and remaining files
    const { filesToParse, remainingFiles } = separateFiles(allFiles)

    const languageParsers = await loadRequiredLanguageParsers(filesToParse)

    // Parse specific files we have language parsers for
    const allowedFilesToParse = ignoreController ? ignoreController.filterPaths(filesToParse, "scan") : filesToParse
    const excludedByIgnoreRules = filesToParse.length - allowedFilesToParse.length

    for (const filePath of allowedFilesToParse) {
        const definitions = await parseFile(filePath, languageParsers, ignoreController)
        if (definitions) {
            result += `${path.relative(dirPath, filePath).toPosix()}\n${definitions}\n`
        }
    }

    if (result) {
        return result
    }

    // Build a descriptive error message when no definitions are found
    const totalFileCount = allFiles.length
    const parseableFileCount = filesToParse.length

    if (totalFileCount === 0) {
        return "No source code definitions found. The directory is empty."
    }
    if (parseableFileCount === 0) {
        return `No source code definitions found. No files with supported extensions found in this directory (supported: .js, .ts, .py, .rs, .go, .c/.h, .cpp/.hpp, .cs, .rb, .java, .php, .swift, .kt). Among ${totalFileCount} total files.`
    }
    if (excludedByIgnoreRules > 0 && allowedFilesToParse.length === 0) {
        return `No source code definitions found. All ${parseableFileCount} parseable files were excluded by the workspace ignore rules.`
    }
    if (excludedByIgnoreRules > 0) {
        return `No source code definitions found. ${excludedByIgnoreRules} of ${parseableFileCount} parseable files were excluded by the workspace ignore rules, and the remaining files contained no definitions.`
    }
    return `No source code definitions found. ${parseableFileCount} parseable files were scanned but none contained recognizable definitions.`
}

function separateFiles(allFiles: FileInfo[]): {
    filesToParse: string[]
    remainingFiles: string[]
} {
    const extensions = [
        "js",
        "jsx",
        "ts",
        "tsx",
        "py",
        "rs",
        "go",
        "c",
        "h",
        "cpp",
        "hpp",
        "cs",
        "rb",
        "java",
        "php",
        "swift",
        "kt",
    ].map((e) => `.${e}`)
    const filePaths = allFiles.map((f) => f.path)
    const filesToParse = filePaths.filter((file) => extensions.includes(path.extname(file))).slice(0, 50)
    const remainingFiles = filePaths.filter((file) => !filesToParse.includes(file))
    return { filesToParse, remainingFiles }
}

async function parseFile(
    filePath: string,
    languageParsers: LanguageParser,
    ignoreController?: IgnoreController,
): Promise<string | null> {
    if (ignoreController && !ignoreController.validateAccess(filePath, "read")) {
        return null
    }
    const fileContent = await fs.readFile(filePath, "utf8")
    const ext = path.extname(filePath).toLowerCase().slice(1)

    const { parser, query } = languageParsers[ext] || {}
    if (!parser || !query) {
        return `Unsupported file type: ${filePath}`
    }

    let formattedOutput = ""

    try {
        const tree = parser.parse(fileContent)
        if (!tree?.rootNode) {
            return null
        }

        const captures = query.captures(tree.rootNode)
        captures.sort((a, b) => a.node.startPosition.row - b.node.startPosition.row)

        const lines = fileContent.split("\n")
        let lastLine = -1

        captures.forEach((capture) => {
            const { node, name } = capture
            const startLine = node.startPosition.row
            let endLine = node.endPosition.row

            if (lastLine !== -1 && startLine > lastLine + 1) {
                formattedOutput += "|----\n"
            }

            if (name.includes("name") && lines[startLine]) {
                // Walk up to the enclosing definition node (e.g. function_declaration,
                // class_declaration) via node.parent to get the true end line of the
                // full definition body.
                let parent = node.parent
                while (parent && parent.endPosition.row === endLine) {
                    parent = parent.parent
                }
                if (parent && parent.endPosition.row > endLine) {
                    endLine = parent.endPosition.row
                }
                // Show range only for multi-line definitions; single-line ones show
                // just the line number to avoid redundant '23-23'.
                // tree-sitter rows are 0-based; convert to 1-based for display.
                if (endLine > startLine) {
                    formattedOutput += `${startLine + 1}-${endLine + 1} | ${lines[startLine]}\n`
                } else {
                    formattedOutput += `${startLine + 1} | ${lines[startLine]}\n`
                }
            }

            lastLine = endLine
        })
    } catch (error) {
        Logger.log(`Error parsing file: ${error}\n`)
    }

    if (formattedOutput.length > 0) {
        return `|----\n${formattedOutput}|----\n`
    }
    return null
}
