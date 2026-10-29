/**
 * Unit tests for skills utility functions
 * Tests skill discovery, override resolution, toggle filtering, and content loading
 */

import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockFileExists, mockIsDir, mockGetScanDirs, mockLoggerWarn, mockReaddir, mockStat, mockReadFile } = vi.hoisted(() => ({
    mockFileExists: vi.fn(),
    mockIsDir: vi.fn(),
    mockGetScanDirs: vi.fn(),
    mockLoggerWarn: vi.fn(),
    mockReaddir: vi.fn(),
    mockStat: vi.fn(),
    mockReadFile: vi.fn(),
}))

vi.mock("@utils/fs", () => ({
    fileExistsAtPath: mockFileExists,
    isDirectory: mockIsDir,
}))

vi.mock("@/utils/fs", () => ({
    fileExistsAtPath: mockFileExists,
    isDirectory: mockIsDir,
}))

vi.mock("@core/storage/disk", () => ({
    getSkillsDirectoriesForScan: mockGetScanDirs,
}))

vi.mock("@/core/storage/disk", () => ({
    getSkillsDirectoriesForScan: mockGetScanDirs,
}))

vi.mock("@/shared/services/Logger", () => ({
    Logger: { warn: mockLoggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), isDebugEnabled: () => false },
}))

// skills.ts uses `import * as fs from "fs/promises"` — mock the module directly
vi.mock("fs/promises", () => ({
    readdir: mockReaddir,
    stat: mockStat,
    readFile: mockReadFile,
}))

// Dynamic imports after vi.mock so the mock is applied to the resolved module.
// This avoids static-import cache issues described in vitest#3081.
let discoverSkills: typeof import("../skills").discoverSkills
let getAvailableSkills: typeof import("../skills").getAvailableSkills
let getSkillContent: typeof import("../skills").getSkillContent
let parseRemoteSkillEntries: typeof import("../skills").parseRemoteSkillEntries

describe("Skills Utility Functions", () => {
    let fileExistsStub: typeof mockFileExists
    let isDirectoryStub: typeof mockIsDir
    let readdirStub: typeof mockReaddir
    let statStub: typeof mockStat
    let readFileStub: typeof mockReadFile

    const TEST_CWD = path.join("/test", "project")
    const GLOBAL_SKILLS_DIR = path.join("/home", "user", "Documents", "dline", "skills")

    beforeEach(async () => {
        vi.resetModules()
        // Reset all hoisted mocks to clean state, then set defaults
        mockFileExists.mockReset()
        mockIsDir.mockReset()
        mockGetScanDirs.mockReset()
        mockLoggerWarn.mockReset()
        mockReaddir.mockReset()
        mockStat.mockReset()
        mockReadFile.mockReset()

        fileExistsStub = mockFileExists.mockResolvedValue(false)
        isDirectoryStub = mockIsDir.mockResolvedValue(false)
        readdirStub = mockReaddir.mockResolvedValue([])
        statStub = mockStat.mockResolvedValue({ isDirectory: () => false })
        readFileStub = mockReadFile.mockResolvedValue("")
        mockGetScanDirs.mockReturnValue([
            { path: path.join(TEST_CWD, ".clinerules", "skills"), source: "project" },
            { path: path.join(TEST_CWD, ".dline", "skills"), source: "project" },
            { path: path.join(TEST_CWD, ".claude", "skills"), source: "project" },
            { path: path.join(TEST_CWD, ".agents", "skills"), source: "project" },
            { path: GLOBAL_SKILLS_DIR, source: "global" },
        ])
        const mod = await import("../skills")
        discoverSkills = mod.discoverSkills
        getAvailableSkills = mod.getAvailableSkills
        getSkillContent = mod.getSkillContent
        parseRemoteSkillEntries = mod.parseRemoteSkillEntries
    })

    afterEach(() => {
        vi.clearAllMocks()
    })

    describe("discoverSkills", () => {
        it("should discover skills from global directory", async () => {
            const skillDir = path.join(GLOBAL_SKILLS_DIR, "my-skill")
            const skillMdPath = path.join(skillDir, "SKILL.md")

            fileExistsStub.mockImplementation(async (p: string) => p === GLOBAL_SKILLS_DIR || p === skillMdPath)
            isDirectoryStub.mockImplementation(async (p: string) => p === GLOBAL_SKILLS_DIR)
            readdirStub.mockResolvedValue(["my-skill"])
            statStub.mockImplementation(async (p: string) =>
                p === skillDir ? { isDirectory: () => true } : { isDirectory: () => false },
            )
            readFileStub.mockImplementation(async (p: string, _enc: string) =>
                p === skillMdPath
                    ? `---
name: my-skill
description: A test skill
---
Instructions here`
                    : "",
            )

            const skills = await discoverSkills(TEST_CWD)

            expect(skills).toHaveLength(1)
            expect(skills[0].name).toBe("my-skill")
            expect(skills[0].description).toBe("A test skill")
            expect(skills[0].source).toBe("global")
        })

        it("should discover skills from project .agents/skills directory", async () => {
            const projectSkillsDir = path.join(TEST_CWD, ".agents", "skills")
            const skillDir = path.join(projectSkillsDir, "explaining-code")
            const skillMdPath = path.join(skillDir, "SKILL.md")

            fileExistsStub.mockImplementation(async (p: string) => p === projectSkillsDir || p === skillMdPath)
            isDirectoryStub.mockImplementation(async (p: string) => p === projectSkillsDir)
            readdirStub.mockResolvedValue(["explaining-code"])
            statStub.mockImplementation(async (p: string) =>
                p === skillDir ? { isDirectory: () => true } : { isDirectory: () => false },
            )
            readFileStub.mockImplementation(async (p: string, _enc: string) =>
                p === skillMdPath
                    ? `---
name: explaining-code
description: Explains code with diagrams and analogies
---
Use analogies and ASCII diagrams when explaining code.`
                    : "",
            )

            const skills = await discoverSkills(TEST_CWD)

            expect(skills).toHaveLength(1)
            expect(skills[0].name).toBe("explaining-code")
            expect(skills[0].source).toBe("project")
        })

        it("should discover skills from project .cline/skills directory", async () => {
            const clineSkillsDir = path.join(TEST_CWD, ".dline", "skills")
            const skillDir = path.join(clineSkillsDir, "debugging")
            const skillMdPath = path.join(skillDir, "SKILL.md")

            fileExistsStub.mockImplementation(async (p: string) => p === clineSkillsDir || p === skillMdPath)
            isDirectoryStub.mockImplementation(async (p: string) => p === clineSkillsDir)
            readdirStub.mockResolvedValue(["debugging"])
            statStub.mockImplementation(async (p: string) =>
                p === skillDir ? { isDirectory: () => true } : { isDirectory: () => false },
            )
            readFileStub.mockImplementation(async (p: string, _enc: string) =>
                p === skillMdPath
                    ? `---
name: debugging
description: Debug code systematically
---
Use systematic debugging approaches.`
                    : "",
            )

            const skills = await discoverSkills(TEST_CWD)

            expect(skills).toHaveLength(1)
            expect(skills[0].name).toBe("debugging")
            expect(skills[0].source).toBe("project")
        })

        it("should discover skills from project .claude/skills directory", async () => {
            const claudeSkillsDir = path.join(TEST_CWD, ".claude", "skills")
            const skillDir = path.join(claudeSkillsDir, "coding")
            const skillMdPath = path.join(skillDir, "SKILL.md")

            fileExistsStub.mockImplementation(async (p: string) => p === claudeSkillsDir || p === skillMdPath)
            isDirectoryStub.mockImplementation(async (p: string) => p === claudeSkillsDir)
            readdirStub.mockResolvedValue(["coding"])
            statStub.mockImplementation(async (p: string) =>
                p === skillDir ? { isDirectory: () => true } : { isDirectory: () => false },
            )
            readFileStub.mockImplementation(async (p: string, _enc: string) =>
                p === skillMdPath
                    ? `---
name: coding
description: Write clean code
---
Follow best practices.`
                    : "",
            )

            const skills = await discoverSkills(TEST_CWD)

            expect(skills).toHaveLength(1)
            expect(skills[0].name).toBe("coding")
            expect(skills[0].source).toBe("project")
        })

        it("should discover skills from project .agents/skills directory", async () => {
            const agentsSkillsDir = path.join(TEST_CWD, ".agents", "skills")
            const skillDir = path.join(agentsSkillsDir, "testing")
            const skillMdPath = path.join(skillDir, "SKILL.md")

            fileExistsStub.mockImplementation(async (p: string) => p === agentsSkillsDir || p === skillMdPath)
            isDirectoryStub.mockImplementation(async (p: string) => p === agentsSkillsDir)
            readdirStub.mockResolvedValue(["testing"])
            statStub.mockImplementation(async (p: string) =>
                p === skillDir ? { isDirectory: () => true } : { isDirectory: () => false },
            )
            readFileStub.mockImplementation(async (p: string, _enc: string) =>
                p === skillMdPath
                    ? `---
name: testing
description: Write comprehensive tests
---
Always write tests.`
                    : "",
            )

            const skills = await discoverSkills(TEST_CWD)

            expect(skills).toHaveLength(1)
            expect(skills[0].name).toBe("testing")
            expect(skills[0].source).toBe("project")
        })

        it("should handle empty skills directories gracefully", async () => {
            fileExistsStub.mockResolvedValue(true)
            isDirectoryStub.mockResolvedValue(true)
            readdirStub.mockResolvedValue([])

            const skills = await discoverSkills(TEST_CWD)

            expect(skills).toHaveLength(0)
        })

        it("should skip non-directory entries in skills folder", async () => {
            const readmePath = path.join(GLOBAL_SKILLS_DIR, "README.md")
            const skillDir = path.join(GLOBAL_SKILLS_DIR, "my-skill")
            const skillMdPath = path.join(skillDir, "SKILL.md")

            fileExistsStub.mockResolvedValue(true)
            isDirectoryStub.mockResolvedValue(true)
            readdirStub.mockResolvedValue(["README.md", "my-skill"])
            statStub.mockImplementation(async (p: string) =>
                p === readmePath ? { isDirectory: () => false } : { isDirectory: () => true },
            )
            readFileStub.mockImplementation(async (p: string, _enc: string) =>
                p === skillMdPath
                    ? `---
name: my-skill
description: A skill
---
Content`
                    : "",
            )

            const skills = await discoverSkills(TEST_CWD)

            expect(skills).toHaveLength(1)
            expect(skills[0].name).toBe("my-skill")
        })

        it("should skip skill directories without SKILL.md", async () => {
            const skillDir = path.join(GLOBAL_SKILLS_DIR, "incomplete-skill")
            const skillMdPath = path.join(skillDir, "SKILL.md")

            fileExistsStub.mockImplementation(async (p: string) => p !== skillMdPath)
            isDirectoryStub.mockResolvedValue(true)
            readdirStub.mockResolvedValue(["incomplete-skill"])
            statStub.mockImplementation(async (p: string) =>
                p === skillDir ? { isDirectory: () => true } : { isDirectory: () => false },
            )

            const skills = await discoverSkills(TEST_CWD)

            expect(skills).toHaveLength(0)
        })
    })

    describe("getAvailableSkills - Override Resolution", () => {
        it("should prefer project skill over global skill of same name", async () => {
            const globalSkillMdPath = path.join(GLOBAL_SKILLS_DIR, "coding", "SKILL.md")
            const projSkillsDir = path.join(TEST_CWD, ".agents", "skills")
            const projCodingMd = path.join(projSkillsDir, "coding", "SKILL.md")

            // Only GLOBAL_SKILLS_DIR and .agents/skills exist as scan dirs
            fileExistsStub.mockImplementation(
                async (p: string) =>
                    p === GLOBAL_SKILLS_DIR || p === projSkillsDir || p === globalSkillMdPath || p === projCodingMd,
            )
            isDirectoryStub.mockImplementation(
                async (p: string) =>
                    p === GLOBAL_SKILLS_DIR ||
                    p === projSkillsDir ||
                    p === path.join(GLOBAL_SKILLS_DIR, "coding") ||
                    p === path.join(projSkillsDir, "coding"),
            )
            readdirStub.mockImplementation(async (p: string) =>
                p === GLOBAL_SKILLS_DIR ? ["coding"] : p === projSkillsDir ? ["coding"] : [],
            )
            statStub.mockImplementation(async (p: string) =>
                p === path.join(GLOBAL_SKILLS_DIR, "coding") || p === path.join(projSkillsDir, "coding")
                    ? { isDirectory: () => true }
                    : { isDirectory: () => false },
            )
            readFileStub.mockImplementation(async (p: string, _enc: string) => {
                if (p === globalSkillMdPath)
                    return "---\nname: coding\ndescription: Global coding skill\n---\nGlobal instructions"
                if (p === projCodingMd) return "---\nname: coding\ndescription: Project coding skill\n---\nProject instructions"
                return ""
            })

            const allSkills = await discoverSkills(TEST_CWD)
            const skills = getAvailableSkills(allSkills)

            expect(skills).toHaveLength(1)
            expect(skills[0].description).toBe("Project coding skill")
            expect(skills[0].source).toBe("project")
        })

        it("should keep both skills when names are different", async () => {
            const projSkillsDir = path.join(TEST_CWD, ".agents", "skills")
            const globalSkillMdPath = path.join(GLOBAL_SKILLS_DIR, "global-skill", "SKILL.md")
            const projectSkillMdPath = path.join(projSkillsDir, "project-skill", "SKILL.md")

            // Only GLOBAL_SKILLS_DIR and .agents/skills exist
            fileExistsStub.mockImplementation(
                async (p: string) =>
                    p === GLOBAL_SKILLS_DIR || p === projSkillsDir || p === globalSkillMdPath || p === projectSkillMdPath,
            )
            isDirectoryStub.mockImplementation(async (p: string) => p === GLOBAL_SKILLS_DIR || p === projSkillsDir)
            readdirStub.mockImplementation(async (p: string) => {
                if (p === GLOBAL_SKILLS_DIR) return ["global-skill"]
                if (p === projSkillsDir) return ["project-skill"]
                return []
            })
            statStub.mockImplementation(async (p: string) =>
                p === path.join(GLOBAL_SKILLS_DIR, "global-skill") || p === path.join(projSkillsDir, "project-skill")
                    ? { isDirectory: () => true }
                    : { isDirectory: () => false },
            )
            readFileStub.mockImplementation(async (p: string, _enc: string) => {
                if (p === globalSkillMdPath) return "---\nname: global-skill\ndescription: A global skill\n---\nContent"
                if (p === projectSkillMdPath) return "---\nname: project-skill\ndescription: A project skill\n---\nContent"
                return ""
            })

            const allSkills = await discoverSkills(TEST_CWD)
            const skills = getAvailableSkills(allSkills)

            expect(skills).toHaveLength(2)
            const names = skills.map((s) => s.name)
            expect(names).toContain("global-skill")
            expect(names).toContain("project-skill")
            expect(skills.find((s) => s.name === "global-skill")?.source).toBe("global")
            expect(skills.find((s) => s.name === "project-skill")?.source).toBe("project")
            expect(skills.find((s) => s.name === "global-skill")?.path).toBe(globalSkillMdPath)
            expect(skills.find((s) => s.name === "project-skill")?.path).toBe(projectSkillMdPath)
        })
    })

    describe("Metadata Validation", () => {
        it("should reject skill with missing name field", async () => {
            const skillDir = path.join(GLOBAL_SKILLS_DIR, "bad-skill")
            const skillMdPath = path.join(skillDir, "SKILL.md")

            fileExistsStub.mockImplementation(async (p: string) => p === GLOBAL_SKILLS_DIR || p === skillMdPath)
            isDirectoryStub.mockResolvedValue(true)
            readdirStub.mockResolvedValue(["bad-skill"])
            statStub.mockImplementation(async (p: string) =>
                p === skillDir ? { isDirectory: () => true } : { isDirectory: () => false },
            )
            readFileStub.mockImplementation(async (p: string, _enc: string) =>
                p === skillMdPath ? "---\ndescription: Missing name\n---\nContent" : "",
            )

            const skills = await discoverSkills(TEST_CWD)

            expect(skills).toHaveLength(0)
            const matched = mockLoggerWarn.mock.calls.some((c: unknown[]) => /missing required 'name' field/.test(String(c[0])))
            expect(matched).toBe(true)
        })

        it("should reject skill with missing description field", async () => {
            const skillDir = path.join(GLOBAL_SKILLS_DIR, "bad-skill")
            const skillMdPath = path.join(skillDir, "SKILL.md")

            fileExistsStub.mockImplementation(async (p: string) => p === GLOBAL_SKILLS_DIR || p === skillMdPath)
            isDirectoryStub.mockResolvedValue(true)
            readdirStub.mockResolvedValue(["bad-skill"])
            statStub.mockImplementation(async (p: string) =>
                p === skillDir ? { isDirectory: () => true } : { isDirectory: () => false },
            )
            readFileStub.mockImplementation(async (p: string, _enc: string) =>
                p === skillMdPath ? "---\nname: bad-skill\n---\nContent" : "",
            )

            const skills = await discoverSkills(TEST_CWD)

            expect(skills).toHaveLength(0)
            const matched = mockLoggerWarn.mock.calls.some((c: unknown[]) =>
                /missing required 'description' field/.test(String(c[0])),
            )
            expect(matched).toBe(true)
        })

        it("should reject skill when name doesn't match directory name", async () => {
            const skillDir = path.join(GLOBAL_SKILLS_DIR, "my-dir")
            const skillMdPath = path.join(skillDir, "SKILL.md")

            fileExistsStub.mockImplementation(async (p: string) => p === GLOBAL_SKILLS_DIR || p === skillMdPath)
            isDirectoryStub.mockResolvedValue(true)
            readdirStub.mockResolvedValue(["my-dir"])
            statStub.mockImplementation(async (p: string) =>
                p === skillDir ? { isDirectory: () => true } : { isDirectory: () => false },
            )
            readFileStub.mockImplementation(async (p: string, _enc: string) =>
                p === skillMdPath ? "---\nname: different-name\ndescription: Mismatched name\n---\nContent" : "",
            )

            const skills = await discoverSkills(TEST_CWD)

            expect(skills).toHaveLength(0)
            const matched = mockLoggerWarn.mock.calls.some((c: unknown[]) => /doesn't match directory/.test(String(c[0])))
            expect(matched).toBe(true)
        })

        it("should handle malformed YAML frontmatter gracefully", async () => {
            const skillDir = path.join(GLOBAL_SKILLS_DIR, "bad-yaml")
            const skillMdPath = path.join(skillDir, "SKILL.md")

            fileExistsStub.mockImplementation(async (p: string) => p === GLOBAL_SKILLS_DIR || p === skillMdPath)
            isDirectoryStub.mockResolvedValue(true)
            readdirStub.mockResolvedValue(["bad-yaml"])
            statStub.mockImplementation(async (p: string) =>
                p === skillDir ? { isDirectory: () => true } : { isDirectory: () => false },
            )
            readFileStub.mockImplementation(async (p: string, _enc: string) =>
                p === skillMdPath ? "---\nname: [invalid yaml\ndescription: broken\n---\nContent" : "",
            )

            const skills = await discoverSkills(TEST_CWD)

            expect(skills).toHaveLength(0)
        })

        it("should handle file without frontmatter", async () => {
            const skillDir = path.join(GLOBAL_SKILLS_DIR, "no-front")
            const skillMdPath = path.join(skillDir, "SKILL.md")

            fileExistsStub.mockImplementation(async (p: string) => p === GLOBAL_SKILLS_DIR || p === skillMdPath)
            isDirectoryStub.mockResolvedValue(true)
            readdirStub.mockResolvedValue(["no-front"])
            statStub.mockImplementation(async (p: string) =>
                p === skillDir ? { isDirectory: () => true } : { isDirectory: () => false },
            )
            readFileStub.mockImplementation(async (p: string, _enc: string) =>
                p === skillMdPath ? "Just plain markdown content without frontmatter" : "",
            )

            const skills = await discoverSkills(TEST_CWD)

            expect(skills).toHaveLength(0)
        })
    })

    describe("getSkillContent", () => {
        it("should load full skill content with instructions", async () => {
            const skillDir = path.join(GLOBAL_SKILLS_DIR, "my-skill")
            const skillMdPath = path.join(skillDir, "SKILL.md")

            fileExistsStub.mockImplementation(async (p: string) => p === GLOBAL_SKILLS_DIR || p === skillMdPath)
            isDirectoryStub.mockResolvedValue(true)
            readdirStub.mockResolvedValue(["my-skill"])
            statStub.mockImplementation(async (p: string) =>
                p === skillDir ? { isDirectory: () => true } : { isDirectory: () => false },
            )
            readFileStub.mockImplementation(async (p: string, _enc: string) =>
                p === skillMdPath
                    ? `---
name: my-skill
description: Test skill
---
These are the detailed instructions.

## Step 1
Do this first.

## Step 2
Then do this.`
                    : "",
            )

            const allSkills = await discoverSkills(TEST_CWD)
            const availableSkills = getAvailableSkills(allSkills)
            const content = await getSkillContent("my-skill", availableSkills)

            expect(content).not.toBeNull()
            expect(content?.name).toBe("my-skill")
            expect(content?.instructions).toContain("These are the detailed instructions")
            expect(content?.instructions).toContain("Step 1")
            expect(content?.instructions).toContain("Step 2")
        })

        it("should return null for non-existent skill", async () => {
            const content = await getSkillContent("non-existent", [])

            expect(content).toBeNull()
        })

        it("should trim whitespace from instructions", async () => {
            const skillDir = path.join(GLOBAL_SKILLS_DIR, "my-skill")
            const skillMdPath = path.join(skillDir, "SKILL.md")

            fileExistsStub.mockImplementation(async (p: string) => p === GLOBAL_SKILLS_DIR || p === skillMdPath)
            isDirectoryStub.mockResolvedValue(true)
            readdirStub.mockResolvedValue(["my-skill"])
            statStub.mockImplementation(async (p: string) =>
                p === skillDir ? { isDirectory: () => true } : { isDirectory: () => false },
            )
            readFileStub.mockImplementation(async (p: string, _enc: string) =>
                p === skillMdPath
                    ? `---
name: my-skill
description: Test
---

   Instructions with whitespace   

`
                    : "",
            )

            const allSkills = await discoverSkills(TEST_CWD)
            const availableSkills = getAvailableSkills(allSkills)
            const content = await getSkillContent("my-skill", availableSkills)

            expect(content?.instructions).toBe("Instructions with whitespace")
        })
    })

    describe("Remote Skills", () => {
        // entry.name must match frontmatter name (enforced by parseRemoteSkillEntries)
        const makeEntry = (name: string, desc: string, body = "Instructions", alwaysEnabled = false) => ({
            name,
            alwaysEnabled,
            contents: `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`,
        })

        describe("parseRemoteSkillEntries", () => {
            it("should return validated entries when entry.name matches frontmatter.name", () => {
                const entries = [
                    { name: "Deploy", alwaysEnabled: true, contents: `---\nname: Deploy\ndescription: CI/CD\n---\nBody` },
                ]
                const result = parseRemoteSkillEntries(entries)
                expect(result).toHaveLength(1)
                expect(result[0].name).toBe("Deploy")
                expect(result[0].description).toBe("CI/CD")
                expect(result[0].alwaysEnabled).toBe(true)
            })

            it("should warn but still include entries where entry.name drifts from frontmatter.name", () => {
                const entries = [
                    {
                        name: "entry-key",
                        alwaysEnabled: false,
                        contents: `---\nname: Different Name\ndescription: Desc\n---\nBody`,
                    },
                ]
                const result = parseRemoteSkillEntries(entries)
                expect(result).toHaveLength(1)
                expect(result[0].name).toBe("Different Name")
                const matched = mockLoggerWarn.mock.calls.some((c: unknown[]) =>
                    /does not match frontmatter\.name/.test(String(c[0])),
                )
                expect(matched).toBe(true)
            })

            it("should skip entries with missing frontmatter name", () => {
                const entries = [{ name: "bad", alwaysEnabled: false, contents: `---\ndescription: No name\n---\nContent` }]
                const result = parseRemoteSkillEntries(entries)
                expect(result).toHaveLength(0)
            })

            it("should skip entries with missing frontmatter description", () => {
                const entries = [{ name: "No Desc", alwaysEnabled: false, contents: `---\nname: No Desc\n---\nContent` }]
                const result = parseRemoteSkillEntries(entries)
                expect(result).toHaveLength(0)
            })

            it("should handle empty array", () => {
                expect(parseRemoteSkillEntries([])).toHaveLength(0)
            })

            it("should include all entries with valid frontmatter even with drift", () => {
                const entries = [
                    { name: "Good", alwaysEnabled: false, contents: `---\nname: Good\ndescription: Valid\n---\nBody` },
                    { name: "drift", alwaysEnabled: false, contents: `---\nname: Different\ndescription: Drifted\n---\nBody` },
                    {
                        name: "Also Good",
                        alwaysEnabled: true,
                        contents: `---\nname: Also Good\ndescription: Valid too\n---\nBody`,
                    },
                ]
                const result = parseRemoteSkillEntries(entries)
                expect(result).toHaveLength(3)
                expect(result[0].name).toBe("Good")
                expect(result[1].name).toBe("Different")
                expect(result[2].name).toBe("Also Good")
            })
        })

        describe("discoverSkills - remote skill discovery", () => {
            it("should include remote skills from remote config", async () => {
                const entries = [makeEntry("Deploy Pipeline", "Handles CI/CD deployment", "Deploy instructions")]
                const skills = await discoverSkills(TEST_CWD, entries)

                const remoteSkill = skills.find((s) => s.name === "Deploy Pipeline")
                expect(remoteSkill).toBeDefined()
                expect(remoteSkill?.path).toBe("remote:Deploy Pipeline")
                expect(remoteSkill?.source).toBe("global")
                expect(remoteSkill?.description).toBe("Handles CI/CD deployment")
            })

            it("should use frontmatter.name as identity even when entry.name drifts", async () => {
                const entries = [
                    { name: "entry-key", alwaysEnabled: false, contents: `---\nname: Actual Name\ndescription: Desc\n---\nBody` },
                ]
                const skills = await discoverSkills(TEST_CWD, entries)
                const remoteSkill = skills.find((s) => s.path?.startsWith("remote:"))
                expect(remoteSkill).toBeDefined()
                expect(remoteSkill?.name).toBe("Actual Name")
                expect(remoteSkill?.path).toBe("remote:Actual Name")
            })

            it("should skip remote skills with missing frontmatter name", async () => {
                const entries = [{ name: "bad", alwaysEnabled: false, contents: `---\ndescription: No name\n---\nContent` }]
                const skills = await discoverSkills(TEST_CWD, entries)
                expect(skills.find((s) => s.path?.startsWith("remote:"))).toBeUndefined()
            })

            it("should skip remote skills with missing frontmatter description", async () => {
                const entries = [{ name: "No Desc", alwaysEnabled: false, contents: `---\nname: No Desc\n---\nContent` }]
                const skills = await discoverSkills(TEST_CWD, entries)
                expect(skills.find((s) => s.path?.startsWith("remote:"))).toBeUndefined()
            })

            it("should handle empty and undefined entries gracefully", async () => {
                for (const val of [[], undefined]) {
                    const skills = await discoverSkills(TEST_CWD, val)
                    expect(skills.filter((s) => s.path?.startsWith("remote:"))).toHaveLength(0)
                }
            })
        })

        describe("Override resolution (project > disk-global > remote)", () => {
            it("disk-global overrides remote skill of same name", async () => {
                const entries = [makeEntry("coding", "Remote coding")]
                const diskGlobalMd = path.join(GLOBAL_SKILLS_DIR, "coding", "SKILL.md")

                // Only GLOBAL_SKILLS_DIR exists as a scan dir with a "coding" subdirectory
                fileExistsStub.mockImplementation(async (p: string) => p === GLOBAL_SKILLS_DIR || p === diskGlobalMd)
                isDirectoryStub.mockImplementation(async (p: string) => p === GLOBAL_SKILLS_DIR)
                readdirStub.mockImplementation(async (p: string) => (p === GLOBAL_SKILLS_DIR ? ["coding"] : []))
                statStub.mockImplementation(async (p: string) =>
                    p === path.join(GLOBAL_SKILLS_DIR, "coding") ? { isDirectory: () => true } : { isDirectory: () => false },
                )
                readFileStub.mockImplementation(async (p: string, _enc: string) =>
                    p === diskGlobalMd ? "---\nname: coding\ndescription: Disk global coding\n---\nDisk" : "",
                )

                const available = getAvailableSkills(await discoverSkills(TEST_CWD, entries))
                expect(available).toHaveLength(1)
                expect(available[0].description).toBe("Disk global coding")
                expect(available[0].path).toBe(diskGlobalMd)
            })

            it("project overrides remote skill of same name", async () => {
                const entries = [makeEntry("coding", "Remote coding")]
                const projSkillsDir = path.join(TEST_CWD, ".agents", "skills")
                const projMd = path.join(projSkillsDir, "coding", "SKILL.md")

                // Only .agents/skills exists as a scan dir with a "coding" subdirectory
                fileExistsStub.mockImplementation(async (p: string) => p === projSkillsDir || p === projMd)
                isDirectoryStub.mockImplementation(async (p: string) => p === projSkillsDir)
                readdirStub.mockImplementation(async (p: string) => (p === projSkillsDir ? ["coding"] : []))
                statStub.mockImplementation(async (p: string) =>
                    p === path.join(projSkillsDir, "coding") ? { isDirectory: () => true } : { isDirectory: () => false },
                )
                readFileStub.mockImplementation(async (p: string, _enc: string) =>
                    p === projMd ? "---\nname: coding\ndescription: Project coding\n---\nProject" : "",
                )

                const available = getAvailableSkills(await discoverSkills(TEST_CWD, entries))
                expect(available).toHaveLength(1)
                expect(available[0].description).toBe("Project coding")
                expect(available[0].path).toBe(projMd)
            })
        })

        describe("getSkillContent - remote skill content loading", () => {
            it("should load content from provided entries for remote skills", async () => {
                const entries = [makeEntry("Deploy Pipeline", "Deployment skill", "These are the deployment instructions.")]
                const skill = {
                    name: "Deploy Pipeline",
                    description: "Deployment skill",
                    path: "remote:Deploy Pipeline",
                    source: "global" as const,
                }
                const content = await getSkillContent("Deploy Pipeline", [skill], entries)

                expect(content).not.toBeNull()
                expect(content?.name).toBe("Deploy Pipeline")
                expect(content?.instructions).toBe("These are the deployment instructions.")
            })

            it("should trim whitespace from remote skill instructions", async () => {
                const entries = [makeEntry("Trim Skill", "Test", "\n   Instructions with whitespace   \n\n")]
                const skill = { name: "Trim Skill", description: "Test", path: "remote:Trim Skill", source: "global" as const }
                const content = await getSkillContent("Trim Skill", [skill], entries)
                expect(content?.instructions).toBe("Instructions with whitespace")
            })

            it("should return null if remote skill entry not found in entries", async () => {
                const skill = { name: "Gone", description: "Removed", path: "remote:Gone", source: "global" as const }
                const content = await getSkillContent("Gone", [skill], [])
                expect(content).toBeNull()
            })

            it("should not attempt disk read for remote skills", async () => {
                const entries = [makeEntry("Remote Only", "Test", "Remote content")]
                const skill = { name: "Remote Only", description: "Test", path: "remote:Remote Only", source: "global" as const }
                await getSkillContent("Remote Only", [skill], entries)
                expect(mockReadFile).not.toHaveBeenCalled()
            })
        })
    })
})
