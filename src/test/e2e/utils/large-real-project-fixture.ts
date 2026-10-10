import { execFile } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const LARGE_PROJECT_TOTAL_TRACKED_FILES = 1_000
export const LARGE_PROJECT_SKILL_NAME = "e2e-large-project-audit"
export const LARGE_PROJECT_SUBAGENT_NAME = "e2e-large-project-reviewer"
export const LARGE_PROJECT_RULE_MARKER = "E2E_LARGE_PROJECT_RULES_ACTIVE"
export const LARGE_PROJECT_SKILL_MARKER = "E2E_LARGE_PROJECT_SKILL_INSTRUCTIONS_ACTIVE"
export const LARGE_PROJECT_SUBAGENT_MARKER = "E2E_LARGE_PROJECT_SUBAGENT_ACTIVE"
export const LARGE_PROJECT_TARGET_MARKER = "E2E_LARGE_PROJECT_TARGET_FILE_0993"

const FIXED_TRACKED_FILE_COUNT = 6
const GENERATED_SOURCE_FILE_COUNT = LARGE_PROJECT_TOTAL_TRACKED_FILES - FIXED_TRACKED_FILE_COUNT
const GENERATED_FILES_PER_DIRECTORY = 50
const TARGET_FILE_INDEX = GENERATED_SOURCE_FILE_COUNT - 1

export interface LargeRealProjectFixture {
    generatedSourceFileCount: number
    gitCommitHash: string
    gitStatus: string
    skillName: string
    subagentName: string
    targetFilePath: string
    targetMarker: string
    trackedFileCount: number
}

interface LargeRealProjectFixtureOptions {
    subagentProfile: string
}

async function runGit(workspaceDir: string, args: readonly string[]): Promise<string> {
    const result = await execFileAsync("git", [...args], {
        cwd: workspaceDir,
        encoding: "utf8",
        windowsHide: true,
    })
    return String(result.stdout).trim()
}

function generatedRelativePath(index: number): string {
    const directoryIndex = Math.floor(index / GENERATED_FILES_PER_DIRECTORY)
    return [
        "src",
        "generated",
        `module-${String(directoryIndex).padStart(3, "0")}`,
        `file-${String(index).padStart(4, "0")}.ts`,
    ].join("/")
}

function generatedFileContent(index: number): string {
    const marker =
        index === TARGET_FILE_INDEX ? LARGE_PROJECT_TARGET_MARKER : `E2E_LARGE_PROJECT_FILE_${String(index).padStart(4, "0")}`
    return [
        `// Generated E2E source file ${index}.`,
        `export const fixtureMarker = ${JSON.stringify(marker)}`,
        `export const fixtureOrdinal = ${index}`,
        "",
    ].join("\n")
}

async function writeGeneratedSourceFiles(workspaceDir: string): Promise<void> {
    const directoryCount = Math.ceil(GENERATED_SOURCE_FILE_COUNT / GENERATED_FILES_PER_DIRECTORY)
    for (let directoryIndex = 0; directoryIndex < directoryCount; directoryIndex++) {
        const firstIndex = directoryIndex * GENERATED_FILES_PER_DIRECTORY
        const lastIndex = Math.min(firstIndex + GENERATED_FILES_PER_DIRECTORY, GENERATED_SOURCE_FILE_COUNT)
        const directory = path.join(workspaceDir, "src", "generated", `module-${String(directoryIndex).padStart(3, "0")}`)
        await mkdir(directory, { recursive: true })
        await Promise.all(
            Array.from({ length: lastIndex - firstIndex }, (_, offset) => {
                const index = firstIndex + offset
                return writeFile(
                    path.join(workspaceDir, ...generatedRelativePath(index).split("/")),
                    generatedFileContent(index),
                    "utf8",
                )
            }),
        )
    }
}

async function writeCapabilityFiles(workspaceDir: string, options: LargeRealProjectFixtureOptions): Promise<void> {
    const rulePath = path.join(workspaceDir, ".agents", "rules", "large-project-performance.md")
    const skillPath = path.join(workspaceDir, ".agents", "skills", LARGE_PROJECT_SKILL_NAME, "SKILL.md")
    const subagentPath = path.join(workspaceDir, ".agents", "subagents", `${LARGE_PROJECT_SUBAGENT_NAME}.yml`)
    await Promise.all([
        mkdir(path.dirname(rulePath), { recursive: true }),
        mkdir(path.dirname(skillPath), { recursive: true }),
        mkdir(path.dirname(subagentPath), { recursive: true }),
    ])

    await Promise.all([
        writeFile(
            rulePath,
            [
                "# Large project performance fixture rules",
                "",
                LARGE_PROJECT_RULE_MARKER,
                "",
                "- Keep repository inspection read-only.",
                "- Load the advertised audit Skill before interpreting the target file.",
                "- Use the named reviewer Subagent for an independent evidence pass.",
                "- Report measured timings rather than estimating performance.",
                "",
            ].join("\n"),
            "utf8",
        ),
        writeFile(
            skillPath,
            [
                "---",
                `name: ${LARGE_PROJECT_SKILL_NAME}`,
                "description: Inspect a large Git workspace, read targeted evidence, and report bounded performance findings.",
                "---",
                "",
                `# ${LARGE_PROJECT_SKILL_NAME}`,
                "",
                LARGE_PROJECT_SKILL_MARKER,
                "",
                "1. Confirm the large-project Rule marker is present in the task context.",
                "2. Read only the exact evidence file requested by the task.",
                "3. Preserve the Git worktree and avoid broad scans or writes.",
                "4. Return the observed marker and distinguish measured latency from inference.",
                "",
            ].join("\n"),
            "utf8",
        ),
        writeFile(
            subagentPath,
            [
                "---",
                `name: ${LARGE_PROJECT_SUBAGENT_NAME}`,
                "description: Independently verifies one target file in the large Git E2E fixture.",
                `profile: ${JSON.stringify(options.subagentProfile)}`,
                "tools:",
                "  - load_skill",
                "  - read_file",
                "  - attempt_completion",
                "skills:",
                `  - ${LARGE_PROJECT_SKILL_NAME}`,
                "---",
                "",
                LARGE_PROJECT_SUBAGENT_MARKER,
                "",
                "Load the configured audit Skill exactly once, read the requested file, and complete with the observed marker.",
                "Do not modify the workspace or run unrelated discovery.",
                "",
            ].join("\n"),
            "utf8",
        ),
    ])
}

async function writeProjectFiles(workspaceDir: string, options: LargeRealProjectFixtureOptions): Promise<void> {
    await Promise.all([
        writeFile(
            path.join(workspaceDir, "README.md"),
            [
                "# Large Real Project E2E Fixture",
                "",
                "This temporary repository contains exactly 1000 tracked files, real Dline Rules, a Skill, a named Subagent, and a Git commit.",
                "",
            ].join("\n"),
            "utf8",
        ),
        writeFile(
            path.join(workspaceDir, "package.json"),
            `${JSON.stringify(
                {
                    name: "dline-large-real-project-e2e-fixture",
                    private: true,
                    version: "1.0.0",
                    type: "module",
                },
                null,
                2,
            )}\n`,
            "utf8",
        ),
        writeFile(path.join(workspaceDir, ".gitignore"), "node_modules/\ntmp/\n", "utf8"),
        writeGeneratedSourceFiles(workspaceDir),
        writeCapabilityFiles(workspaceDir, options),
    ])
}

async function initializeGitRepository(
    workspaceDir: string,
): Promise<{ commitHash: string; status: string; trackedFiles: string[] }> {
    await runGit(workspaceDir, ["init", "--quiet"])
    await runGit(workspaceDir, ["config", "user.name", "Dline E2E"])
    await runGit(workspaceDir, ["config", "user.email", "dline-e2e@example.invalid"])
    await runGit(workspaceDir, ["config", "core.autocrlf", "false"])
    await runGit(workspaceDir, ["add", "--all"])
    await runGit(workspaceDir, ["commit", "--quiet", "-m", "test: seed large real project fixture"])
    const [commitHash, status, trackedOutput] = await Promise.all([
        runGit(workspaceDir, ["rev-parse", "HEAD"]),
        runGit(workspaceDir, ["status", "--porcelain"]),
        runGit(workspaceDir, ["ls-files"]),
    ])
    return {
        commitHash,
        status,
        trackedFiles: trackedOutput.split(/\r?\n/u).filter(Boolean),
    }
}

export async function inspectLargeRealProjectGit(workspaceDir: string): Promise<{
    commitHash: string
    status: string
    trackedFileCount: number
}> {
    const [commitHash, status, trackedOutput] = await Promise.all([
        runGit(workspaceDir, ["rev-parse", "HEAD"]),
        runGit(workspaceDir, ["status", "--porcelain"]),
        runGit(workspaceDir, ["ls-files"]),
    ])
    return {
        commitHash,
        status,
        trackedFileCount: trackedOutput.split(/\r?\n/u).filter(Boolean).length,
    }
}

export async function createLargeRealProjectFixture(
    workspaceDir: string,
    options: LargeRealProjectFixtureOptions,
): Promise<LargeRealProjectFixture> {
    await rm(workspaceDir, { recursive: true, force: true })
    await mkdir(workspaceDir, { recursive: true })
    await writeProjectFiles(workspaceDir, options)
    const git = await initializeGitRepository(workspaceDir)
    if (git.trackedFiles.length !== LARGE_PROJECT_TOTAL_TRACKED_FILES) {
        throw new Error(
            `Large project fixture expected ${LARGE_PROJECT_TOTAL_TRACKED_FILES} tracked files, found ${git.trackedFiles.length}`,
        )
    }
    if (git.status !== "") {
        throw new Error(`Large project fixture Git worktree is not clean after commit: ${git.status}`)
    }

    return {
        generatedSourceFileCount: GENERATED_SOURCE_FILE_COUNT,
        gitCommitHash: git.commitHash,
        gitStatus: git.status,
        skillName: LARGE_PROJECT_SKILL_NAME,
        subagentName: LARGE_PROJECT_SUBAGENT_NAME,
        targetFilePath: generatedRelativePath(TARGET_FILE_INDEX),
        targetMarker: LARGE_PROJECT_TARGET_MARKER,
        trackedFileCount: git.trackedFiles.length,
    }
}
