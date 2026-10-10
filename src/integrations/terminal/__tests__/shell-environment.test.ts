import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, it, vi } from "vitest"
import { Logger } from "@/shared/services/Logger"
import { WINDOWS_POWERSHELL_LEGACY_PATH } from "@/utils/shell"
import {
    buildShellEnvironmentCommand,
    buildTerminalInitializationCommand,
    logShellEnvironmentDiagnostics,
    ShellEnvironmentConfigLoader,
} from "../shell-environment"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

async function createWorkspace(config: string): Promise<string> {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "dline-shell-environment-"))
    temporaryDirectories.push(workspace)
    await mkdir(path.join(workspace, ".agents"), { recursive: true })
    await writeFile(path.join(workspace, ".agents", "bashrc.yml"), config, "utf8")
    return workspace
}

afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("ShellEnvironmentConfigLoader", () => {
    it("loads the owning workspace and resolves profile startup, pre, and post settings", async () => {
        const workspace = await createWorkspace(`
version: 1
environment:
  SHARED_VALUE: common
  EXPANDED_PATH: '\${env:BASE_PATH};common'
platforms:
  win32:
    environment:
      SHARED_VALUE: windows
      WINDOWS_ONLY: enabled
    profiles:
      powershell-legacy:
        environment:
          SHARED_VALUE: profile
        startupScripts:
          - ./scripts/setup.ps1
        preCommands:
          - Set-Location '\${workspaceFolder}'
        postCommand: Write-Output '\${env:POST_MARKER}'
`)
        const loader = new ShellEnvironmentConfigLoader({
            workspaceRoots: [workspace],
            platform: "win32",
            environment: { BASE_PATH: "C:\\base", POST_MARKER: "finished" },
        })

        const resolved = await loader.resolve(path.join(workspace, "src"), "powershell-legacy")

        assert.ok(resolved)
        assert.equal(resolved.configPath, path.join(workspace, ".agents", "bashrc.yml"))
        assert.deepEqual(resolved.environment, {
            EXPANDED_PATH: "C:\\base;common",
            SHARED_VALUE: "profile",
            WINDOWS_ONLY: "enabled",
        })
        assert.deepEqual(resolved.startupScripts, [path.join(workspace, "scripts", "setup.ps1")])
        assert.deepEqual(resolved.preCommands, [`Set-Location '${workspace}'`])
        assert.equal(resolved.postCommand, "Write-Output 'finished'")
        assert.ok(resolved.configurationId.length > 0)
    })

    it("reuses a cached resolved configuration while the file signature is unchanged", async () => {
        const workspace = await createWorkspace("version: 1\nenvironment:\n  CACHE_VALUE: stable\n")
        const loader = new ShellEnvironmentConfigLoader({ workspaceRoots: [workspace], platform: "linux" })

        const first = await loader.resolve(workspace, "default")
        const second = await loader.resolve(path.join(workspace, "src"), "default")

        assert.equal(second, first)
        assert.equal(second?.workspaceRoot, workspace)
    })

    it("does not load a project configuration for an external workdirectory", async () => {
        const workspace = await createWorkspace("version: 1\nenvironment:\n  SHOULD_NOT_LOAD: yes\n")
        const external = await mkdtemp(path.join(os.tmpdir(), "dline-shell-external-"))
        temporaryDirectories.push(external)
        const loader = new ShellEnvironmentConfigLoader({ workspaceRoots: [workspace], platform: "win32" })

        assert.equal(await loader.resolve(external, "powershell-legacy"), undefined)
    })

    it("loads the concrete Windows profile when execution uses default", async () => {
        const workspace = await createWorkspace(`
version: 1
platforms:
  win32:
    profiles:
      powershell:
        preCommands:
          - conda activate dline
`)
        const loader = new ShellEnvironmentConfigLoader({ workspaceRoots: [workspace], platform: "win32" })

        assert.deepEqual((await loader.resolve(workspace, "default"))?.preCommands, ["conda activate dline"])
    })

    it("rejects the removed commands field instead of retaining a compatibility alias", async () => {
        const workspace = await createWorkspace(`
version: 1
platforms:
  linux:
    profiles:
      bash:
        commands:
          - echo legacy
`)
        const loader = new ShellEnvironmentConfigLoader({ workspaceRoots: [workspace], platform: "linux" })

        await assert.rejects(loader.resolve(workspace, "bash"), /unsupported field: commands/)
    })

    it("rejects unsupported configuration fields instead of silently ignoring them", async () => {
        const workspace = await createWorkspace("version: 1\nunknown: value\n")
        const loader = new ShellEnvironmentConfigLoader({ workspaceRoots: [workspace], platform: "linux" })

        await assert.rejects(loader.resolve(workspace, "default"), /unknown/)
    })

    it("uses the latest project configuration on the next command", async () => {
        const workspace = await createWorkspace("version: 1\nenvironment:\n  CONFIG_VERSION: first\n")
        const configPath = path.join(workspace, ".agents", "bashrc.yml")
        const loader = new ShellEnvironmentConfigLoader({ workspaceRoots: [workspace], platform: "linux" })
        const first = await loader.resolve(workspace, "default")

        await writeFile(configPath, "version: 1\nenvironment:\n  CONFIG_VERSION: second\n", "utf8")
        const second = await loader.resolve(workspace, "default")

        assert.equal(first?.environment.CONFIG_VERSION, "first")
        assert.equal(second?.environment.CONFIG_VERSION, "second")
        assert.notEqual(first?.configurationId, second?.configurationId)
    })
})

describe("shell environment command builders", () => {
    it("builds startup commands only for scripts compatible with the selected shell", () => {
        const diagnosticsPath = "C:\\Temp\\dline-shell.log"
        const powershell = buildTerminalInitializationCommand(
            ["C:\\setup.ps1", "C:\\vcvars64.bat", "C:\\profile.bashrc"],
            "powershell-legacy",
            diagnosticsPath,
            "win32",
        )
        assert.match(powershell ?? "", /setup\.ps1/)
        assert.match(powershell ?? "", /vcvars64\.bat/)
        assert.match(powershell ?? "", /startupScripts\[2\] failed/)

        const posix = buildTerminalInitializationCommand(
            ["/workspace/profile.bashrc", "/workspace/setup.ps1"],
            "bash",
            "/tmp/dline-shell.log",
            "linux",
        )
        assert.match(posix ?? "", /profile\.bashrc/)
        assert.match(posix ?? "", /startupScripts\[1\] failed/)
    })

    it("keeps the original command unchanged when no startup, pre, or post behavior is configured", () => {
        assert.equal(
            buildShellEnvironmentCommand({
                command: "npm test",
                diagnosticsPath: "C:\\Temp\\unused.log",
                platform: "win32",
                profile: "powershell-legacy",
            }),
            "npm test",
        )
    })

    it("emits a foreground completion marker after postCommand", () => {
        const command = buildShellEnvironmentCommand({
            command: "npm test",
            preCommands: ["Initialize-DlineShell"],
            postCommand: "Finalize-DlineShell",
            profile: "powershell-legacy",
            diagnosticsPath: "C:\\Temp\\shell.log",
            completionMarkerToken: "test-token",
            platform: "win32",
        })

        const postCommandIndex = command.indexOf("Finalize-DlineShell")
        const markerIndex = command.indexOf("__DLINE_INTERNAL_COMMAND_EXIT__test-token:$__dline_exit_code")
        assert.ok(postCommandIndex >= 0)
        assert.ok(markerIndex > postCommandIndex)
    })

    it.runIf(process.platform === "win32")(
        "silences PowerShell setup output, continues after a missing script, runs postCommand, and preserves the user exit code",
        async () => {
            const workspace = await createWorkspace("version: 1\n")
            const startupScript = path.join(workspace, "startup.ps1")
            const batchStartupScript = path.join(workspace, "vcvars64.bat")
            const missingScript = path.join(workspace, "missing.ps1")
            const postMarker = path.join(workspace, "post.txt")
            const diagnosticsPath = path.join(workspace, "diagnostics.log")
            await writeFile(
                startupScript,
                '$env:DLINE_STARTUP_VALUE = "startup-ready"\nWrite-Output "HIDDEN_STARTUP_OUTPUT"\n',
                "utf8",
            )
            await writeFile(
                batchStartupScript,
                "@set DLINE_BATCH_STARTUP_VALUE=batch-ready\r\n@echo HIDDEN_BATCH_OUTPUT\r\n",
                "utf8",
            )
            const command = buildShellEnvironmentCommand({
                command:
                    'Write-Output "VISIBLE:$($env:DLINE_STARTUP_VALUE):$($env:DLINE_BATCH_STARTUP_VALUE):$($env:DLINE_PRE_VALUE)"; & $env:ComSpec /d /c "exit 7"',
                startupScripts: [startupScript, batchStartupScript, missingScript],
                preCommands: ['$env:DLINE_PRE_VALUE = "pre-ready"; Write-Output "HIDDEN_PRE_OUTPUT"'],
                postCommand: `Set-Content -LiteralPath '${postMarker.replaceAll("'", "''")}' -Value 'post-ran'; Write-Output 'HIDDEN_POST_OUTPUT'`,
                profile: "powershell-legacy",
                diagnosticsPath,
                terminateShell: true,
                platform: "win32",
            })

            const failure = await execFileAsync(WINDOWS_POWERSHELL_LEGACY_PATH, [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                command,
            ]).then(
                () => undefined,
                (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => error,
            )

            assert.ok(failure)
            assert.equal(failure.code, 7)
            assert.match(failure.stdout ?? "", /VISIBLE:startup-ready:batch-ready:pre-ready/)
            assert.doesNotMatch(failure.stdout ?? "", /HIDDEN_/)
            assert.equal((failure.stderr ?? "").trim(), "")
            assert.equal((await readFile(postMarker, "utf8")).trim(), "post-ran")
            assert.match(await readFile(diagnosticsPath, "utf8"), /startupScripts\[2\] failed/)
        },
    )

    it("writes diagnostics through Logger.error and removes the internal file", async () => {
        const workspace = await createWorkspace("version: 1\n")
        const diagnosticsPath = path.join(workspace, "diagnostics.log")
        await writeFile(diagnosticsPath, "startupScripts[0] failed: missing.ps1\n", "utf8")
        const logger = vi.spyOn(Logger, "error").mockImplementation(() => undefined)

        await logShellEnvironmentDiagnostics(diagnosticsPath)

        assert.ok(logger.mock.calls.some(([message]) => String(message).includes("startupScripts[0] failed")))
        await assert.rejects(access(diagnosticsPath), /ENOENT/)
    })
})
