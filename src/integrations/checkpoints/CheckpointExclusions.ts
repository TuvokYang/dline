import { IgnoreController } from "@core/ignore/IgnoreController"
import { fileExistsAtPath } from "@utils/fs"
import fs from "fs/promises"
import { join } from "path"
import { Logger } from "@/shared/services/Logger"

/** Legacy suffix retained to exclude metadata left by earlier checkpoint versions. */
export const GIT_DISABLED_SUFFIX = "_disabled"

/**
 * CheckpointExclusions Module
 *
 * A specialized module within Cline's Checkpoints system that manages file exclusion rules
 * for the checkpoint tracking process. It provides:
 *
 * File Filtering:
 * - File types (build artifacts, media, cache files, etc.)
 * - Git LFS patterns from workspace
 * - Environment and configuration files
 * - Temporary and cache files
 *
 * Pattern Management:
 * - Extensible category-based pattern system
 * - Comprehensive file type coverage
 * - Easy pattern updates and maintenance
 *
 * Git Integration:
 * - Seamless integration with Git's exclude mechanism
 * - Support for workspace-specific LFS patterns
 * - Automatic pattern updates during checkpoints
 *
 * The module ensures efficient checkpoint creation by preventing unnecessary tracking
 * of large files, binary files, and temporary artifacts while maintaining a clean
 * and organized checkpoint history.
 */

/**
 * Returns the default list of file and directory patterns to exclude from checkpoints.
 * Combines built-in patterns with workspace-specific LFS patterns.
 *
 * @param lfsPatterns - Optional array of Git LFS patterns from workspace
 * @returns Array of glob patterns to exclude
 * @todo Make this configurable by the user
 */
export const getDefaultExclusions = (lfsPatterns: string[] = []): string[] => [
    // Build and Development Artifacts
    ".git/",
    `.git${GIT_DISABLED_SUFFIX}/`,
    ...getBuildArtifactPatterns(),

    // Media Files
    ...getMediaFilePatterns(),

    // Cache and Temporary Files
    ...getCacheFilePatterns(),

    // Environment and Config Files
    ...getConfigFilePatterns(),

    // Large Data Files
    ...getLargeDataFilePatterns(),

    // Database Files
    ...getDatabaseFilePatterns(),

    // Geospatial Datasets
    ...getGeospatialPatterns(),

    // Log Files
    ...getLogFilePatterns(),

    ...lfsPatterns,
]

/**
 * Returns patterns for common build and development artifact directories
 * @returns Array of glob patterns for build artifacts
 */
function getBuildArtifactPatterns(): string[] {
    return [
        ".gradle/",
        ".idea/",
        ".parcel-cache/",
        ".pytest_cache/",
        ".next/",
        ".nuxt/",
        ".sass-cache/",
        ".vs/",
        ".vscode/",
        ".clinerules/",
        "Pods/",
        "__pycache__/",
        "bin/",
        "build/",
        "bundle/",
        "coverage/",
        "deps/",
        "dist/",
        "env/",
        "node_modules/",
        "obj/",
        "out/",
        "pycache/",
        "target/dependency/",
        "temp/",
        "vendor/",
        "venv/",
    ]
}

/**
 * Extract directory-level exclusion patterns formatted for globby's ignore option.
 *
 * Shadow git already excludes these directories via info/exclude, so nested .git
 * repos inside them cannot interfere with git add. Skipping them in the file-system
 * scan avoids unnecessary nested-git detection, prevents cross-tracker interference,
 * and eliminates EPERM races when multiple CheckpointTracker instances share a
 * worktree (e.g. main window + debug Extension Host).
 *
 * @returns Array of globby-compatible ignore patterns (e.g. "** /dist/**")
 */
/**
 * Extract directory-level exclusion patterns formatted for globby's ignore option.
 *
 * Shadow git already excludes these directories via info/exclude, so nested .git
 * repos inside them cannot interfere with git add. Skipping them in the file-system
 * scan avoids unnecessary nested-git detection, prevents cross-tracker interference,
 * and eliminates EPERM races when multiple CheckpointTracker instances share a
 * worktree (e.g. main window + debug Extension Host).
 *
 * @param extraGlobs - Additional globby-compatible ignore patterns, normally
 *   from `IgnoreController.toGlobPatterns()`
 * @returns Array of globby-compatible ignore patterns (e.g. "** /dist/**")
 */
export function getExcludedDirectoryGlobs(extraGlobs?: string[]): string[] {
    const dirPatterns = getBuildArtifactPatterns()
    const base = dirPatterns.filter((p) => p.endsWith("/")).map((p) => `**/${p}**`)
    if (extraGlobs && extraGlobs.length > 0) {
        return [...base, ...extraGlobs]
    }
    return base
}

/**
 * Returns patterns for common media and image file types
 * @returns Array of glob patterns for media files
 */
function getMediaFilePatterns(): string[] {
    return [
        "*.jpg",
        "*.jpeg",
        "*.png",
        "*.gif",
        "*.bmp",
        "*.ico",
        "*.webp",
        "*.tiff",
        "*.tif",
        // "*.svg",
        "*.raw",
        "*.heic",
        "*.avif",
        "*.eps",
        "*.psd",
        "*.3gp",
        "*.aac",
        "*.aiff",
        "*.asf",
        "*.avi",
        "*.divx",
        "*.flac",
        "*.m4a",
        "*.m4v",
        "*.mkv",
        "*.mov",
        "*.mp3",
        "*.mp4",
        "*.mpeg",
        "*.mpg",
        "*.ogg",
        "*.opus",
        "*.rm",
        "*.rmvb",
        "*.vob",
        "*.wav",
        "*.webm",
        "*.wma",
        "*.wmv",
    ]
}

/**
 * Returns patterns for cache, temporary, and system files
 * @returns Array of glob patterns for cache files
 */
function getCacheFilePatterns(): string[] {
    return [
        "*.DS_Store",
        "*.bak",
        "*.cache",
        "*.crdownload",
        "*.dmp",
        "*.dump",
        "*.eslintcache",
        "*.lock",
        "*.log",
        "*.old",
        "*.part",
        "*.partial",
        "*.pyc",
        "*.pyo",
        "*.stackdump",
        "*.swo",
        "*.swp",
        "*.temp",
        "*.tmp",
        "*.Thumbs.db",
    ]
}

/**
 * Returns patterns for environment and configuration files
 * @returns Array of glob patterns for config files
 */
function getConfigFilePatterns(): string[] {
    return ["*.env*", "*.local", "*.development", "*.production"]
}

/**
 * Returns patterns for common large binary and archive files
 * @returns Array of glob patterns for large data files
 */
function getLargeDataFilePatterns(): string[] {
    return [
        "*.zip",
        "*.tar",
        "*.gz",
        "*.rar",
        "*.7z",
        "*.iso",
        "*.bin",
        "*.exe",
        "*.dll",
        "*.so",
        "*.dylib",
        "*.dat",
        "*.dmg",
        "*.msi",
    ]
}

/**
 * Returns patterns for database and data storage files
 * @returns Array of glob patterns for database files
 */
function getDatabaseFilePatterns(): string[] {
    return [
        "*.arrow",
        "*.accdb",
        "*.aof",
        "*.avro",
        "*.bak",
        "*.bson",
        "*.csv",
        "*.db",
        "*.dbf",
        "*.dmp",
        "*.frm",
        "*.ibd",
        "*.mdb",
        "*.myd",
        "*.myi",
        "*.orc",
        "*.parquet",
        "*.pdb",
        "*.rdb",
        "*.sqlite",
    ]
}

/**
 * Returns patterns for geospatial and mapping data files
 * @returns Array of glob patterns for geospatial files
 */
function getGeospatialPatterns(): string[] {
    return [
        "*.shp",
        "*.shx",
        "*.dbf",
        "*.prj",
        "*.sbn",
        "*.sbx",
        "*.shp.xml",
        "*.cpg",
        "*.gdb",
        "*.mdb",
        "*.gpkg",
        "*.kml",
        "*.kmz",
        "*.gml",
        "*.geojson",
        "*.dem",
        "*.asc",
        "*.img",
        "*.ecw",
        "*.las",
        "*.laz",
        "*.mxd",
        "*.qgs",
        "*.grd",
        "*.csv",
        "*.dwg",
        "*.dxf",
    ]
}

/**
 * Returns patterns for log and debug output files
 * @returns Array of glob patterns for log files
 */
function getLogFilePatterns(): string[] {
    return ["*.error", "*.log", "*.logs", "*.npm-debug.log*", "*.out", "*.stdout", "yarn-debug.log*", "yarn-error.log*"]
}

/**
 * Repository-scoped ignore rules to append to the shadow git info/exclude.
 *
 * Checkpoints track the repository, so they follow the repository's own rules:
 * only `.gitignore` plus the built-in floor. Agent-scoped files (`.agentignore`
 * and its accepted aliases) deliberately do not apply here — they restrict what
 * the agent may read, not what the workspace considers untracked.
 *
 * @param workspacePath - Absolute path to the workspace root
 * @returns gitignore-format content to append after the built-in patterns
 */
export async function loadWorkspaceIgnoreContent(workspacePath: string): Promise<string> {
    const rules = await IgnoreController.loadSnapshot(workspacePath)
    return rules.toRepositoryGitignoreContent()
}

/** Outcome of writing the shadow repository excludes. */
export interface WriteExcludesResult {
    /**
     * True when the effective exclusion ruleset differs from the one the shadow
     * repository was last built with. Only a ruleset change can invalidate files
     * that are already indexed, so callers use this to decide whether the shadow
     * index must be rebuilt from scratch or may take the incremental path.
     */
    changed: boolean
}

/**
 * Writes the combined exclusion patterns to Git's exclude file.
 * Creates the info directory if it doesn't exist.
 *
 * @param gitPath - Path to the .git directory
 * @param lfsPatterns - Optional array of Git LFS patterns to include
 * @param workspaceIgnoreContent - Optional gitignore-format content from
 *   workspace .gitignore / .dlineignore to append after the built-in patterns
 * @param boundaryPatterns - Root-relative nested repository paths owned outside
 *   the root shadow checkpoint
 * @returns Whether the written ruleset differs from the previous one
 */
export const writeExcludesFile = async (
    gitPath: string,
    lfsPatterns: string[] = [],
    workspaceIgnoreContent?: string,
    boundaryPatterns: string[] = [],
): Promise<WriteExcludesResult> => {
    const excludesPath = join(gitPath, "info", "exclude")
    await fs.mkdir(join(gitPath, "info"), { recursive: true })

    const patterns = [...getDefaultExclusions(lfsPatterns), ...boundaryPatterns]
    if (workspaceIgnoreContent) {
        patterns.push(workspaceIgnoreContent)
    }
    const content = patterns.join("\n")
    const previousContent = await fs.readFile(excludesPath, "utf8").catch(() => undefined)
    await fs.writeFile(excludesPath, content)
    return { changed: previousContent !== content }
}

/**
 * Retrieves Git LFS patterns from the workspace's .gitattributes file.
 * Returns an empty array if no patterns found or file doesn't exist.
 *
 * @param workspacePath - Path to the workspace root
 * @returns Array of Git LFS patterns found in .gitattributes
 */
export const getLfsPatterns = async (workspacePath: string): Promise<string[]> => {
    try {
        const attributesPath = join(workspacePath, ".gitattributes")
        if (await fileExistsAtPath(attributesPath)) {
            const attributesContent = await fs.readFile(attributesPath, "utf8")
            return attributesContent
                .split("\n")
                .filter((line) => line.includes("filter=lfs"))
                .map((line) => line.split(" ")[0].trim())
        }
    } catch (error) {
        Logger.warn("Failed to read .gitattributes:", error)
    }
    return []
}
