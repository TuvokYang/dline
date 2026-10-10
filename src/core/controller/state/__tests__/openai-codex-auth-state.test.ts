import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

const controllerSourcePath = path.resolve("src/core/controller/index.ts")
const oauthSourcePath = path.resolve("src/integrations/openai-codex/oauth.ts")
const usageSourcePath = path.resolve("src/core/account-usage/AccountUsageCoordinator.ts")

function extractMethod(source: string, startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker, start)
    if (start < 0 || end < 0) throw new Error(`Unable to locate runtime boundary: ${startMarker}`)
    return source.slice(start, end)
}

describe("OpenAI Codex Profile runtime invalidation architecture", () => {
    it("publishes only committed Profile credential mutations with a monotonic revision", async () => {
        const source = await readFile(oauthSourcePath, "utf8")

        expect(source).toContain("subscribeToRuntimeMutations(")
        expect(source).toContain("getRuntimeRevision(profileId: string)")
        expect(source).toContain("publishRuntimeMutation(profileId")
        expect(source).toContain("await this.sessions.saveCredential(profileId, credentials)")
        expect(source).toContain("await this.sessions.clearCredential(profileId)")
    })

    it("targets only the active Profile, evicts its usage cache and rebuilds its handler", async () => {
        const source = await readFile(controllerSourcePath, "utf8")
        const method = extractMethod(
            source,
            "private async handleOpenAiCodexRuntimeMutation(",
            "/** Poll account usage every 60 seconds",
        )

        expect(source).toContain("openAiCodexRuntimeMutationDispose")
        expect(source).toContain("openAiCodexOAuthManager.subscribeToRuntimeMutations")
        expect(source).toContain("this.openAiCodexRuntimeMutationDispose?.()")
        expect(method).toContain("selectedProfile.profile.id !== event.profileId")
        expect(method).toContain("accountUsageCoordinator.deleteByPrefix(`${event.profileId}:`)")
        expect(method).toContain("this.restartAccountUsagePolling()")
        expect(method).toContain("await this.task?.owners.api.rebuild({ abortPrevious: true })")
    })

    it("aborts an in-flight usage handler and supports target cache eviction", async () => {
        const [controllerSource, usageSource] = await Promise.all([
            readFile(controllerSourcePath, "utf8"),
            readFile(usageSourcePath, "utf8"),
        ])
        const stopMethod = extractMethod(
            controllerSource,
            "private stopAccountUsagePolling()",
            "/** Restart account usage polling",
        )

        expect(controllerSource).toContain("private accountUsageHandler?: ApiHandler")
        expect(controllerSource).toContain("this.accountUsageHandler = handler")
        expect(stopMethod).toContain("this.accountUsageHandler?.abort?.()")
        expect(usageSource).toContain("deleteByPrefix(prefix: string)")
    })
})
