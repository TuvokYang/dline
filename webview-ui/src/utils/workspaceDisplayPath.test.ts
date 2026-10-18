import { describe, expect, it } from "vitest"
import { formatWorkspaceDisplayPath, type WorkspaceDisplayContext } from "./workspaceDisplayPath"

const single: WorkspaceDisplayContext = { workspaceRoots: [{ path: "C:\\work\\app", name: "app" }], primaryRootIndex: 0 }
const multi: WorkspaceDisplayContext = {
    workspaceRoots: [
        { path: "/home/dev/frontend", name: "frontend" },
        { path: "/home/dev/backend", name: "backend" },
    ],
    primaryRootIndex: 0,
}

describe("formatWorkspaceDisplayPath", () => {
    it("keeps a single-folder path relative, without a leading ./", () => {
        expect(formatWorkspaceDisplayPath("src/a.ts", single)).toBe("src/a.ts")
        expect(formatWorkspaceDisplayPath("./src/a.ts", single)).toBe("src/a.ts")
    })

    it("shows an absolute path inside the folder relative to it, whatever its separators and drive case", () => {
        expect(formatWorkspaceDisplayPath("c:/WORK/app/src/a.ts", single)).toBe("src/a.ts")
        expect(formatWorkspaceDisplayPath("C:\\work\\app\\src\\a.ts", single)).toBe("src/a.ts")
        expect(formatWorkspaceDisplayPath("C:/work/app", single)).toBe("app")
    })

    it("keeps a path outside every folder absolute, including a sibling sharing the folder's prefix", () => {
        expect(formatWorkspaceDisplayPath("C:/work/app2/x.ts", single)).toBe("C:/work/app2/x.ts")
        expect(formatWorkspaceDisplayPath("/etc/hosts", multi)).toBe("/etc/hosts")
    })

    it("prefixes the folder name in a multi-root workspace", () => {
        expect(formatWorkspaceDisplayPath("src/a.ts", multi)).toBe("frontend/src/a.ts")
        expect(formatWorkspaceDisplayPath("src/a.ts", { ...multi, primaryRootIndex: 1 })).toBe("backend/src/a.ts")
        expect(formatWorkspaceDisplayPath("/home/dev/backend/src/b.ts", multi)).toBe("backend/src/b.ts")
        expect(formatWorkspaceDisplayPath("@backend:src/b.ts", multi)).toBe("backend/src/b.ts")
    })

    it("names a path by the innermost folder when folders nest", () => {
        const nested: WorkspaceDisplayContext = {
            workspaceRoots: [
                { path: "/repo", name: "repo" },
                { path: "/repo/packages/web", name: "web" },
            ],
            primaryRootIndex: 0,
        }

        expect(formatWorkspaceDisplayPath("/repo/packages/web/src/x.ts", nested)).toBe("web/src/x.ts")
        expect(formatWorkspaceDisplayPath("/repo/README.md", nested)).toBe("repo/README.md")
    })

    it("derives a missing folder name from the folder path", () => {
        const unnamed: WorkspaceDisplayContext = {
            workspaceRoots: [{ path: "/home/dev/frontend" }, { path: "/home/dev/backend/" }],
            primaryRootIndex: 0,
        }

        expect(formatWorkspaceDisplayPath("/home/dev/backend/src/b.ts", unnamed)).toBe("backend/src/b.ts")
    })

    it("shows the reported path when no folder is open", () => {
        const none: WorkspaceDisplayContext = { workspaceRoots: [], primaryRootIndex: 0 }

        expect(formatWorkspaceDisplayPath("src/a.ts", none)).toBe("src/a.ts")
        expect(formatWorkspaceDisplayPath("/Users/me/Desktop/a.ts", none)).toBe("/Users/me/Desktop/a.ts")
    })
})
