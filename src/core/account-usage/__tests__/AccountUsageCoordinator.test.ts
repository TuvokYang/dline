import { expect } from "chai"
import { describe, it, vi } from "vitest"
import { AccountUsageCoordinator } from "../AccountUsageCoordinator"

describe("AccountUsageCoordinator", () => {
    it("deduplicates concurrent requests for the same profile", async () => {
        let resolve!: (value: { currency: string; remainingBalance: number }) => void
        const loader = vi.fn(
            () =>
                new Promise<{ currency: string; remainingBalance: number }>((done) => {
                    resolve = done
                }),
        )
        const coordinator = new AccountUsageCoordinator()

        const first = coordinator.get("profile", loader)
        const second = coordinator.get("profile", loader)
        resolve({ currency: "CNY", remainingBalance: 10 })

        expect(await first).to.deep.equal({ currency: "CNY", remainingBalance: 10 })
        expect(await second).to.deep.equal({ currency: "CNY", remainingBalance: 10 })
        expect(loader.mock.calls).to.have.length(1)
    })

    it("reuses cached undefined results until the ttl expires", async () => {
        let now = 1_000
        const loader = vi.fn().mockResolvedValue(undefined)
        const coordinator = new AccountUsageCoordinator(100, () => now)

        await coordinator.get("profile", loader)
        now += 99
        await coordinator.get("profile", loader)
        expect(loader.mock.calls).to.have.length(1)

        now += 1
        await coordinator.get("profile", loader)
        expect(loader.mock.calls).to.have.length(2)
    })

    it("evicts only cache entries owned by the target Profile prefix", async () => {
        const profileALoader = vi.fn().mockResolvedValue({ currency: "USD", remainingBalance: 1 })
        const profileBLoader = vi.fn().mockResolvedValue({ currency: "USD", remainingBalance: 2 })
        const coordinator = new AccountUsageCoordinator()

        await coordinator.get("profile-a:signature:1", profileALoader)
        await coordinator.get("profile-b:signature:1", profileBLoader)
        coordinator.deleteByPrefix("profile-a:")
        await coordinator.get("profile-a:signature:1", profileALoader)
        await coordinator.get("profile-b:signature:1", profileBLoader)

        expect(profileALoader.mock.calls).to.have.length(2)
        expect(profileBLoader.mock.calls).to.have.length(1)
    })

    it("does not deduplicate different profile signatures", async () => {
        const loader = vi.fn().mockResolvedValue({ currency: "CNY", remainingBalance: 1 })
        const coordinator = new AccountUsageCoordinator()

        await Promise.all([coordinator.get("profile-a", loader), coordinator.get("profile-b", loader)])

        expect(loader.mock.calls).to.have.length(2)
    })
})
