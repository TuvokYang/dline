import * as fs from "node:fs/promises"
import * as path from "node:path"

import { beforeAll, describe, expect, it } from "vitest"

import type { ApiProviderInfo } from "@/core/api"
import {
    condenseToolResponse,
    deepPlanningToolResponse,
    explainChangesToolResponse,
    newRuleToolResponse,
    newTaskToolResponse,
    reportBugToolResponse,
} from "../../commands"
import { PromptProfile } from "../../profiles/types"
import { assertPromptContent } from "./snapshot-content"

const UPDATE_NEW_SNAPSHOTS = process.env.UPDATE_NEW_PROMPT_SNAPSHOTS === "true"
const SNAPSHOTS_DIR = path.join(__dirname, "__snapshots__", "profiles", "commands")
const PROFILES = [PromptProfile.Standard, PromptProfile.Lite] as const
const TRANSPORTS = ["native", "xml"] as const
const FOCUS_CASES = ["focus-on", "focus-off"] as const
const PROVIDER_INFO = createProviderInfo()

interface CommandSnapshotCase {
    readonly name: string
    readonly generate: () => string
}

const COMMAND_SNAPSHOT_CASES: readonly CommandSnapshotCase[] = [
    ...PROFILES.flatMap((profile) =>
        TRANSPORTS.flatMap((transport) =>
            FOCUS_CASES.map((focusCase) => ({
                name: `deep-planning.${profile}.${transport}.${focusCase}.command.snap`,
                generate: () =>
                    deepPlanningToolResponse(
                        profile,
                        { enabled: focusCase === "focus-on" },
                        PROVIDER_INFO,
                        transport === "native",
                    ),
            })),
        ),
    ),
    ...FOCUS_CASES.map((focusCase) => ({
        name: `compact.${focusCase}.command.snap`,
        generate: () => condenseToolResponse({ enabled: focusCase === "focus-on" }),
    })),
    {
        name: "new-task.xml.command.snap",
        generate: newTaskToolResponse,
    },
    {
        name: "new-rule.xml.command.snap",
        generate: newRuleToolResponse,
    },
    {
        name: "report-bug.xml.command.snap",
        generate: reportBugToolResponse,
    },
    {
        name: "explain-changes.xml.command.snap",
        generate: explainChangesToolResponse,
    },
]

function createProviderInfo(): ApiProviderInfo {
    return {
        providerId: "openai",
        model: { id: "explicit-command-snapshot", info: {} },
        mode: "act",
    } as unknown as ApiProviderInfo
}

async function assertCommandSnapshot(name: string, content: string): Promise<void> {
    assertPromptContent(name, content)
    const snapshotPath = path.join(SNAPSHOTS_DIR, name)
    if (UPDATE_NEW_SNAPSHOTS) {
        await fs.writeFile(snapshotPath, content, "utf-8")
        return
    }
    expect(await fs.readFile(snapshotPath, "utf-8")).toBe(content)
}

describe("complete command snapshots", () => {
    beforeAll(async () => {
        await fs.mkdir(SNAPSHOTS_DIR, { recursive: true })
        const expectedNames = COMMAND_SNAPSHOT_CASES.map(({ name }) => name).sort()
        const actualNames = (await fs.readdir(SNAPSHOTS_DIR)).filter((name) => name.endsWith(".snap")).sort()
        if (UPDATE_NEW_SNAPSHOTS) {
            await Promise.all(
                actualNames
                    .filter((name) => !expectedNames.includes(name))
                    .map((name) => fs.unlink(path.join(SNAPSHOTS_DIR, name))),
            )
        } else {
            expect(actualNames).toEqual(expectedNames)
        }
    })

    for (const snapshotCase of COMMAND_SNAPSHOT_CASES) {
        it(snapshotCase.name, async () => {
            await assertCommandSnapshot(snapshotCase.name, snapshotCase.generate())
        })
    }
})
