import { createRequire } from "node:module"
import path from "node:path"

/** Resolve the repository-local Vitest CLI without invoking a package runner. */
export function resolveVitestCliPath(cwd = process.cwd()) {
    const requireFromProject = createRequire(path.join(cwd, "package.json"))
    const packagePath = requireFromProject.resolve("vitest/package.json")
    return path.join(path.dirname(packagePath), "vitest.mjs")
}

/** Build a shell-free command that runs the local Vitest CLI with the current Node runtime. */
export function createVitestSpawnCommand(options = {}) {
    const cwd = options.cwd || process.cwd()
    return {
        file: options.execPath || process.execPath,
        args: [resolveVitestCliPath(cwd)],
        options: {
            shell: false,
        },
    }
}
