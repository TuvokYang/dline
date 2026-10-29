import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
import { DlineDefaultTool } from "@/shared/tools"
import { DefaultToolHandlerState } from "../../state/ToolHandlerState"
import type { TaskConfig } from "../../types/TaskConfig"
import { ReplaceTextHandler } from "../ReplaceTextHandler"

let tmpDir: string

function createConfig(): { config: TaskConfig; say: ReturnType<typeof vi.fn> } {
    const say = vi.fn().mockResolvedValue(undefined)
    return {
        config: {
            cwd: tmpDir,
            taskState: new DefaultToolHandlerState(),
            callbacks: { say },
            services: {
                taskFileTracker: { trackModification: vi.fn() },
            },
        } as unknown as TaskConfig,
        say,
    }
}

function block(
    find: string,
    replace: string,
    literal: boolean | string = "false",
    options: { dryRun?: boolean; filePattern?: string } = {},
) {
    return {
        type: "tool_use" as const,
        function_id: "replace-text-test",
        dline_tid: "replace-text-test",
        name: DlineDefaultTool.REPLACE_TEXT,
        partial: false,
        ts: 100,
        params: {
            find,
            replace,
            file_pattern: options.filePattern ?? "fixture-*.txt",
            dry_run: String(options.dryRun ?? true),
            literal: String(literal),
        },
    }
}

describe("ReplaceTextHandler", () => {
    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-replace-text-test-"))
        await fs.writeFile(path.join(tmpDir, "fixture-one.txt"), "regex-id: item-101\nrecord-id: record-101\n", "utf8")
        await fs.writeFile(path.join(tmpDir, "fixture-two.txt"), "regex-id: item-202\nrecord-id: record-202\n", "utf8")
    })

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true })
    })

    it.each([
        "item-([0-9]{3})",
        "item-[0-9][0-9][0-9]",
        "item....",
    ])("treats literal=false as a regular expression for %s", async (find) => {
        const { config } = createConfig()
        const result = await new ReplaceTextHandler().execute(config, block(find, "record-$1"))

        assert.match(String(result), /\(2 files, 2 changes\) \(preview\)/)
    })

    it.each(["record-\\d+", "record-(101|202)"])("supports the requested record pattern %s", async (find) => {
        const { config } = createConfig()
        const result = await new ReplaceTextHandler().execute(config, block(find, "matched-record"))

        assert.match(String(result), /\(2 files, 2 changes\) \(preview\)/)
    })

    it("supports capture groups in replacement text", async () => {
        const { config } = createConfig()
        const result = await new ReplaceTextHandler().execute(config, block("item-([0-9]{3})", "record-$1", false))

        assert.match(String(result), /record-101/)
        assert.match(String(result), /record-202/)
    })

    it("trims and normalizes a multi-line literal before matching CRLF content, then writes LF", async () => {
        const fixture = path.join(tmpDir, "fixture-one.txt")
        const untouched = path.join(tmpDir, "fixture-two.txt")
        await fs.writeFile(fixture, "header\r\nalpha\r\nbeta\r\nfooter\r\n", "utf8")
        await fs.writeFile(untouched, "untouched\r\ncontent\r\n", "utf8")
        const { config } = createConfig()

        const result = await new ReplaceTextHandler().execute(
            config,
            block("\nalpha\r\nbeta\n", "ALPHA\r\nBETA", true, { dryRun: false }),
        )

        assert.match(String(result), /1 files, 1 occurrences/)
        assert.equal(await fs.readFile(fixture, "utf8"), "header\nALPHA\nBETA\nfooter\n")
        assert.equal(await fs.readFile(untouched, "utf8"), "untouched\r\ncontent\r\n")
    })

    it("matches regular expressions across normalized line boundaries", async () => {
        const fixture = path.join(tmpDir, "fixture-one.txt")
        await fs.writeFile(fixture, "first\r\nsecond\r\nthird\r\n", "utf8")
        const { config } = createConfig()

        const result = await new ReplaceTextHandler().execute(
            config,
            block("  first\\nsecond  ", "joined", false, { dryRun: false, filePattern: "fixture-one.txt" }),
        )

        assert.match(String(result), /1 files, 1 occurrences/)
        assert.equal(await fs.readFile(fixture, "utf8"), "joined\nthird\n")
    })

    it.each(["", " \r\n "])("settles the partial Webview row when find is missing after trim", async (find) => {
        const { config, say } = createConfig()
        const result = await new ReplaceTextHandler().execute(config, block(find, "record"))

        assert.match(String(result), /find/i)
        assert.equal(say.mock.calls.length, 1)
        const payload = JSON.parse(String(say.mock.calls[0][1])) as { content?: string }
        assert.equal(payload.content, result)
        assert.equal(say.mock.calls[0][4], false)
        assert.equal(say.mock.calls[0][5], 100)
    })

    it("reports invalid regular expressions and settles the partial Webview row", async () => {
        const { config, say } = createConfig()
        const result = await new ReplaceTextHandler().execute(config, block("item-([", "record"))

        assert.match(String(result), /replace_text failed:/)
        assert.match(String(result), /regular expression/i)
        assert.equal(say.mock.calls.length, 1)
        const payload = JSON.parse(String(say.mock.calls[0][1])) as { content?: string }
        assert.match(payload.content ?? "", /replace_text failed:/)
        assert.equal(say.mock.calls[0][4], false)
        assert.equal(say.mock.calls[0][5], 100)
    })

    it("settles the partial Webview row when no occurrence matches", async () => {
        const { config, say } = createConfig()
        const result = await new ReplaceTextHandler().execute(config, block("missing-[0-9]+", "record"))

        assert.equal(result, 'No occurrences of "missing-[0-9]+" found in 2 files matching "fixture-*.txt".')
        assert.equal(say.mock.calls.length, 1)
        const payload = JSON.parse(String(say.mock.calls[0][1])) as { content?: string }
        assert.equal(payload.content, result)
        assert.equal(say.mock.calls[0][4], false)
        assert.equal(say.mock.calls[0][5], 100)
    })
})
