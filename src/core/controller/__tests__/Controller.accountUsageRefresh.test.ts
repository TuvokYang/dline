import { accountUsageCoordinator } from "@core/account-usage/AccountUsageCoordinator"
import type { AccountUsage } from "@core/api"
import type { AccountUsageLocalData } from "@shared/ExtensionMessage"
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

function local(inputTokens: number): AccountUsageLocalData {
    return {
        inputTokens,
        outputTokens: 2,
        usageReported: true,
        retrievedAt: `2026-11-05T00:0${inputTokens === 10 ? 1 : 2}:00.000Z`,
    }
}

describe("Controller account usage refresh", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        accountUsageCoordinator.clear()
        mocks.readProfiles.mockReturnValue([profile])
        mocks.publish.mockResolvedValue(undefined)
    })

    afterEach(() => accountUsageCoordinator.clear())

    it("refreshes local usage without discarding the last remote quotas or reading them again", async () => {
        const getAccountUsage = vi.fn().mockResolvedValue(remote)
        mocks.buildHandler.mockReturnValue({ getAccountUsage, supportsAccountUsagePolling: false, abort: vi.fn() })
        const controller = {
            task: { taskId: "task-a" },
            stateManager: {
                getApiConfigurationForTask: () => ({ actModeProfileId: profile.id }),
                getSettingsKeyForTask: () => "act",
            },
            accountUsagePollGeneration: 1,
            accountUsageProfileKey: undefined,
            accountUsageSingleReadKey: undefined,
            _accountUsage: undefined as AccountUsage | undefined,
            readLocalDailyTokens: vi.fn().mockResolvedValueOnce(local(10)).mockResolvedValueOnce(local(20)),
        }
        const poll = (
            Controller.prototype as unknown as {
                pollAccountUsage: (generation: number) => Promise<void>
            }
        ).pollAccountUsage

        await poll.call(controller, 1)
        expect(controller._accountUsage?.local?.inputTokens).toBe(10)
        expect(controller._accountUsage?.quotas).toEqual(remote.quotas)

        await poll.call(controller, 1)

        expect(getAccountUsage).toHaveBeenCalledTimes(1)
        expect(controller._accountUsage).toMatchObject({
            planType: "pro",
            quotas: remote.quotas,
            isAvailable: true,
            retrievedAt: remote.retrievedAt,
            local: local(20),
        })
        expect(mocks.publish.mock.calls.at(-1)?.[1]).toEqual(controller._accountUsage)
    })
})
