import { accountUsageCoordinator } from "@core/account-usage/AccountUsageCoordinator"
import type { AccountUsage } from "@core/api"
import { ApiProfile } from "@shared/proto/dline/profile"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Controller } from "../index"

const mocks = vi.hoisted(() => ({
    buildHandler: vi.fn(),
    readProfiles: vi.fn(),
    publish: vi.fn(),
}))

vi.mock("@core/api", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@core/api")>()),
    buildApiHandler: mocks.buildHandler,
}))
vi.mock("@core/controller/file/getApiProfiles", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@core/controller/file/getApiProfiles")>()),
    readApiProfiles: mocks.readProfiles,
}))
vi.mock("../state/subscribeToState", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../state/subscribeToState")>()),
    sendAccountUsageUpdate: mocks.publish,
}))

const profile = ApiProfile.create({ id: "profile-a", provider: "claude-code", enabled: true })
const remote: AccountUsage = {
    currency: "USD",
    planType: "pro",
    quotas: [{ type: "5hour", label: "5 hour", used: 25, limit: 100 }],
    isAvailable: true,
    retrievedAt: "2026-11-05T00:00:00.000Z",
}

function controllerFor(selectedProfile = profile) {
    mocks.readProfiles.mockReturnValue([selectedProfile])
    return {
        task: { taskId: "task-a" },
        stateManager: {
            getApiConfigurationForTask: () => ({ actModeProfileId: selectedProfile.id }),
            getSettingsKeyForTask: () => "act",
        },
        accountUsagePollGeneration: 1,
        accountUsageProfileKey: undefined,
        accountUsageSingleReadKey: undefined,
        _accountUsage: undefined as AccountUsage | undefined,
        readLocalDailyTokens: vi.fn(),
    }
}

const poll = (
    Controller.prototype as unknown as {
        pollAccountUsage: (generation: number) => Promise<void>
    }
).pollAccountUsage

describe("Controller account usage refresh", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        accountUsageCoordinator.clear()
        mocks.publish.mockResolvedValue(undefined)
    })

    afterEach(() => accountUsageCoordinator.clear())

    it("keeps the last subscription reading when its polling policy skips a repeat", async () => {
        const getAccountUsage = vi.fn().mockResolvedValue(remote)
        mocks.buildHandler.mockReturnValue({ getAccountUsage, supportsAccountUsagePolling: false, abort: vi.fn() })
        const controller = controllerFor()

        await poll.call(controller, 1)
        const firstReading = controller._accountUsage
        await poll.call(controller, 1)

        expect(getAccountUsage).toHaveBeenCalledTimes(1)
        expect(controller._accountUsage).toBe(firstReading)
        expect(controller._accountUsage).toMatchObject({ planType: "pro", quotas: remote.quotas })
        expect(controller._accountUsage?.local).toBeUndefined()
        expect(controller.readLocalDailyTokens).not.toHaveBeenCalled()
    })

    it.each([
        "openai-native",
        "openrouter",
        "anthropic",
    ])("does not construct usage for %s without a capability", async (provider) => {
        mocks.buildHandler.mockReturnValue({ abort: vi.fn() })
        const controller = controllerFor(ApiProfile.create({ id: "profile-a", provider, enabled: true }))
        controller._accountUsage = remote

        await poll.call(controller, 1)

        expect(controller._accountUsage).toBeUndefined()
        expect(controller.readLocalDailyTokens).not.toHaveBeenCalled()
        expect(mocks.publish.mock.calls.every(([, usage]) => usage === undefined)).toBe(true)
    })

    it.each(["claude-code", "openai-codex", "opencode"])("does not attach local statistics to %s", async (provider) => {
        mocks.buildHandler.mockReturnValue({ getAccountUsage: vi.fn().mockResolvedValue(remote), abort: vi.fn() })
        const controller = controllerFor(ApiProfile.create({ id: "profile-a", provider, enabled: true }))

        await poll.call(controller, 1)

        expect(controller._accountUsage?.quotas).toEqual(remote.quotas)
        expect(controller._accountUsage?.local).toBeUndefined()
        expect(controller._accountUsage?.dailyInputTokens).toBeUndefined()
        expect(controller.readLocalDailyTokens).not.toHaveBeenCalled()
    })

    it.each(["missing", "failed"])("does not replace a %s provider reading with local statistics", async (outcome) => {
        const getAccountUsage = vi.fn()
        if (outcome === "failed") getAccountUsage.mockRejectedValue(new Error("usage unavailable"))
        else getAccountUsage.mockResolvedValue(undefined)
        mocks.buildHandler.mockReturnValue({ getAccountUsage, abort: vi.fn() })
        const controller = controllerFor()

        await poll.call(controller, 1)

        expect(controller._accountUsage).toBeUndefined()
        expect(controller.readLocalDailyTokens).not.toHaveBeenCalled()
        expect(mocks.publish.mock.calls.every(([, usage]) => usage === undefined)).toBe(true)
    })
})
