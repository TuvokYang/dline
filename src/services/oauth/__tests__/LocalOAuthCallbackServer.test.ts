import { afterEach, describe, expect, it } from "vitest"
import { LocalOAuthCallbackServer } from "../LocalOAuthCallbackServer"
import type { OAuthAccountPresentation } from "../types"

const openServers: LocalOAuthCallbackServer[] = []

async function listen(onCallback: (callbackUri: string) => Promise<OAuthAccountPresentation | void>) {
    const server = await LocalOAuthCallbackServer.listen({
        port: 0,
        callbackPath: "/auth/callback",
        onCallback,
    })
    openServers.push(server)
    return server
}

afterEach(async () => {
    while (openServers.length > 0) {
        await openServers.pop()?.close()
    }
})

describe("LocalOAuthCallbackServer result page", () => {
    it("renders the account presentation returned by the callback", async () => {
        const server = await listen(async () => ({
            providerName: "OpenAI Codex",
            accountName: "Ada Lovelace",
            accountDetail: "ada@example.test",
            planName: "Pro",
        }))

        const response = await fetch(`${server.redirectUri}?code=abc&state=xyz`)
        const html = await response.text()

        expect(response.status).toBe(200)
        expect(html).toContain('class="logo success"')
        expect(html).toContain("OpenAI Codex")
        expect(html).toContain("Ada Lovelace")
        expect(html).toContain("ada@example.test")
        expect(html).toContain("Pro")
    })

    it("still renders a complete success page when the strategy describes no account", async () => {
        const server = await listen(async () => undefined)

        const response = await fetch(`${server.redirectUri}?code=abc&state=xyz`)
        const html = await response.text()

        expect(response.status).toBe(200)
        expect(html).toContain('class="logo success"')
        expect(html).toContain("Authorization successful")
        expect(html).not.toContain('class="account"')
    })

    it("marks the failure page red and points to the manual callback URL field", async () => {
        const server = await listen(async () => {
            throw new Error("callback rejected")
        })

        const response = await fetch(`${server.redirectUri}?code=abc&state=xyz`)
        const html = await response.text()

        expect(response.status).toBe(400)
        expect(html).toContain("Authorization failed")
        expect(html).toContain('class="logo failure"')
        expect(html).not.toContain("logo success")
        expect(html).toContain("address bar")
        expect(html).toContain("Full callback URL")
    })

    it("serves the consumer's pages instead of the profile sign-in pages", async () => {
        let rejectCallback = false
        const server = await LocalOAuthCallbackServer.listen({
            port: 0,
            callbackPath: "/auth/callback",
            pages: { success: "<p>consumer success</p>", failure: "<p>consumer failure</p>" },
            onCallback: async () => {
                if (rejectCallback) throw new Error("callback rejected")
            },
        })
        openServers.push(server)

        const success = await fetch(`${server.redirectUri}?code=abc&state=xyz`)
        rejectCallback = true
        const failure = await fetch(`${server.redirectUri}?code=abc&state=xyz`)

        expect(success.status).toBe(200)
        expect(await success.text()).toBe("<p>consumer success</p>")
        expect(failure.status).toBe(400)
        expect(await failure.text()).toBe("<p>consumer failure</p>")
    })
})
