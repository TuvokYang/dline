import { describe, expect, it } from "vitest"
import { McpSettingsSchema } from "../../schemas"
import { safeParseWithEnvReferences } from "../envReferenceValidation"

describe("safeParseWithEnvReferences", () => {
    it("accepts a url that is only a reference, which the raw schema rejects, and keeps the reference", () => {
        const settings = {
            mcpServers: {
                remote: { type: "streamableHttp", url: "${env:MCP_URL}", headers: { Authorization: "Bearer ${env:TOKEN}" } },
            },
        }
        expect(McpSettingsSchema.safeParse(settings).success).toBe(false)

        const result = safeParseWithEnvReferences(McpSettingsSchema, settings)

        expect(result.success).toBe(true)
        const server = result.success ? result.data.mcpServers.remote : undefined
        expect(server).toMatchObject({ url: "${env:MCP_URL}", headers: { Authorization: "Bearer ${env:TOKEN}" } })
    })

    it("keeps references in stdio args and env unexpanded", () => {
        const settings = {
            mcpServers: { local: { type: "stdio", command: "node", args: ["--key=${env:KEY}"], env: { KEY: "${env:KEY}" } } },
        }

        const result = safeParseWithEnvReferences(McpSettingsSchema, settings)

        expect(result.success).toBe(true)
        const server = result.success ? result.data.mcpServers.local : undefined
        expect(server).toMatchObject({ args: ["--key=${env:KEY}"], env: { KEY: "${env:KEY}" } })
    })

    it("still rejects a malformed literal url around a reference", () => {
        const settings = { mcpServers: { remote: { type: "streamableHttp", url: "not a url ${env:PATH_PART}" } } }

        expect(safeParseWithEnvReferences(McpSettingsSchema, settings).success).toBe(false)
    })
})
