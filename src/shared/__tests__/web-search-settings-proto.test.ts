import { Secrets, Settings, UpdateSettingsRequest } from "@shared/proto/dline/state"
import { describe, expect, it } from "vitest"

describe("local Web Search settings proto", () => {
    it("round-trips UpdateSettingsRequest fields through binary and JSON codecs", () => {
        const request = UpdateSettingsRequest.create({
            localWebSearchEngine: "searxng",
            searxngSearchUrl: "https://search.example.test",
            searxngSearchToken: "private-token",
        })

        expect(UpdateSettingsRequest.decode(UpdateSettingsRequest.encode(request).finish())).toMatchObject(request)
        expect(UpdateSettingsRequest.fromJSON(UpdateSettingsRequest.toJSON(request))).toMatchObject(request)
    })

    it("round-trips non-secret settings and secrets through their separate messages", () => {
        const settings = Settings.create({
            localWebSearchEngine: "bing",
            searxngSearchUrl: "https://search.example.test",
        })
        const secrets = Secrets.create({ searxngSearchToken: "private-token" })

        expect(Settings.decode(Settings.encode(settings).finish())).toMatchObject(settings)
        expect(Settings.fromJSON(Settings.toJSON(settings))).toMatchObject(settings)
        expect(Secrets.decode(Secrets.encode(secrets).finish())).toMatchObject(secrets)
        expect(Secrets.fromJSON(Secrets.toJSON(secrets))).toMatchObject(secrets)
    })
})
