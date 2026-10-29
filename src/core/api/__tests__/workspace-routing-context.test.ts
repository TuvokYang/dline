import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { describe, expect, it } from "vitest"
import { type ApiHandlerContext, buildApiHandlerFromProfile } from "../index"

const profile = ApiProfile.create({
    name: "workspace-routing-test",
    provider: "openai",
    apiKey: "test-api-key",
    modelId: "gpt-5.6-sol",
    openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
})

describe("API workspace routing context", () => {
    it("projects runtime workspace and Task identities into the provider handler context", () => {
        const handler = buildApiHandlerFromProfile(
            {
                actModeProfile: profile.name,
                workspaceId: "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                ulid: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            },
            "act",
            profile,
        )
        const context = (handler as unknown as { ctx: ApiHandlerContext }).ctx

        expect(context.workspaceId).toBe("dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        expect(context.ulid).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV")
    })
})
