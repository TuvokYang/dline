import { VcsType, type WorkspaceRoot } from "@shared/multi-root/types"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Logger } from "@/shared/services/Logger"
import { resolveWorkspaceLinkTarget } from "../resolveWorkspaceLinkTarget"
import { WorkspaceRootManager } from "../WorkspaceRootManager"

const PRIMARY = "/workspaces/dline"
const SECONDARY = "/workspaces/dline-web"

function createManager(): WorkspaceRootManager {
    const roots: WorkspaceRoot[] = [
        { path: PRIMARY, name: "dline", vcs: VcsType.Git },
        { path: SECONDARY, name: "dline-web", vcs: VcsType.Git },
    ]
    return new WorkspaceRootManager(roots, 0)
}

describe("resolveWorkspaceLinkTarget", () => {
    beforeEach(() => {
        vi.spyOn(Logger, "warn").mockImplementation(() => {})
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("opens a hinted link in the named workspace root", () => {
        const target = resolveWorkspaceLinkTarget("@dline-web:app/backend/otel/content-policy.test.ts", {
            cwd: PRIMARY,
            workspaceManager: createManager(),
        })

        expect(target).toEqual({ absolutePath: path.join(SECONDARY, "app/backend/otel/content-policy.test.ts") })
    })

    it("reads the line suffix after the workspace hint", () => {
        const target = resolveWorkspaceLinkTarget("@dline-web:app/main.ts:31", {
            cwd: PRIMARY,
            workspaceManager: createManager(),
        })

        expect(target).toEqual({ absolutePath: path.join(SECONDARY, "app/main.ts"), line: 31 })
    })

    it("falls back to the primary root without the hint when the workspace is unknown", () => {
        const target = resolveWorkspaceLinkTarget("@missing:src/index.ts:7", {
            cwd: PRIMARY,
            workspaceManager: createManager(),
        })

        expect(target).toEqual({ absolutePath: path.join(PRIMARY, "src/index.ts"), line: 7 })
        expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining("'missing' not found"))
    })

    it("drops the hint and resolves against cwd when no workspace manager is available", () => {
        const target = resolveWorkspaceLinkTarget("@dline-web:app/main.ts", { cwd: PRIMARY })

        expect(target).toEqual({ absolutePath: path.resolve(PRIMARY, "app/main.ts") })
    })

    it("keeps unhinted links on the primary root", () => {
        const target = resolveWorkspaceLinkTarget("src/core/index.ts:12", {
            cwd: PRIMARY,
            workspaceManager: createManager(),
        })

        expect(target).toEqual({ absolutePath: path.resolve(PRIMARY, "src/core/index.ts"), line: 12 })
    })

    it("leaves a line-free unhinted link without a line", () => {
        const target = resolveWorkspaceLinkTarget("package.json", { cwd: PRIMARY })

        expect(target).toEqual({ absolutePath: path.resolve(PRIMARY, "package.json") })
    })
})
