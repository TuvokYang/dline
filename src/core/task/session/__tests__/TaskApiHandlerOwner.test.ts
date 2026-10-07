import type { ApiHandler } from "@core/api"
import type { StateManager } from "@core/storage/StateManager"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiProfileRecoveryResult } from "../../ApiProfileRecovery"
import { ProfileNotValidError } from "../../profile-admission"
import type { TaskStateManager } from "../../TaskStateManager"
import { TaskApiHandlerOwner } from "../TaskApiHandlerOwner"

const built: { handler: ApiHandler; profile: ApiProfile }[] = []
const resolutions = vi.hoisted(() => ({
	cached: vi.fn<() => ApiProfileRecoveryResult>(),
	fresh: vi.fn<() => Promise<ApiProfileRecoveryResult>>(),
}))

vi.mock("@core/api", () => ({
	buildApiHandlerFromProfile: vi.fn((_configuration: unknown, _mode: unknown, profile: ApiProfile) => {
		const handler = { abort: vi.fn(), getProviderId: () => profile.provider } as unknown as ApiHandler
		built.push({ handler, profile })
		return handler
	}),
}))

vi.mock("../../ApiProfileRecovery", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../ApiProfileRecovery")>()),
	resolveTaskApiProfile: resolutions.cached,
	resolveTaskApiProfileFresh: resolutions.fresh,
}))

const AZURE_ERROR = 'Profile not valid: "azure" requires an Azure endpoint for Azure Identity authentication.'

function profile(name: string): ApiProfile {
	return { id: `${name}-id`, name, provider: "openai" } as ApiProfile
}

function valid(selected: ApiProfile): ApiProfileRecoveryResult {
	return {
		configuration: { actModeProfileId: selected.id, actModeProfile: selected.name },
		resolvedProfile: selected.name,
		resolvedProfileId: selected.id,
		resolvedApiProfile: selected,
		usedFallback: false,
		validity: { status: "valid", profileId: selected.id, displayName: selected.name },
	}
}

function invalid(message: string): ApiProfileRecoveryResult {
	return {
		configuration: {},
		usedFallback: false,
		validity: { status: "invalid", reason: "configuration_invalid", message },
		error: message,
	}
}

const adoptedIdentities = vi.fn<(mode: string, profileId: string, profileName: string) => void>()

function createOwner() {
	const stateManager = { getApiConfigurationForTask: vi.fn(() => ({})) } as unknown as StateManager
	const settings = { mode: "act", adoptResolvedProfileIdentity: adoptedIdentities } as unknown as TaskStateManager
	return new TaskApiHandlerOwner({ taskId: "task-1", taskIncarnationId: "incarnation-1", stateManager, settings })
}

async function firstRequestFailure(handler: ApiHandler): Promise<unknown> {
	try {
		await handler.createMessage("", []).next()
	} catch (error) {
		return error
	}
	throw new Error("expected the request to be refused")
}

describe("TaskApiHandlerOwner", () => {
	beforeEach(() => {
		built.length = 0
		adoptedIdentities.mockReset()
		resolutions.cached.mockReset().mockReturnValue(valid(profile("source")))
		resolutions.fresh.mockReset().mockResolvedValue(valid(profile("source")))
	})

	// Dev bound the task to the Profile its rebuild resolved, so History Resume
	// and later rebuilds follow the Profile that now serves requests.
	it("binds the task to the Profile a rebuild resolves, but never to a session fallback", async () => {
		const owner = createOwner()
		adoptedIdentities.mockClear()

		resolutions.fresh.mockResolvedValueOnce(valid(profile("target")))
		await owner.rebuild()
		expect(adoptedIdentities).toHaveBeenCalledExactlyOnceWith("act", "target-id", "target")

		resolutions.fresh.mockResolvedValueOnce({ ...valid(profile("fallback")), usedFallback: true })
		await owner.rebuild()
		resolutions.fresh.mockResolvedValueOnce(invalid(AZURE_ERROR))
		await owner.rebuild()
		expect(adoptedIdentities).toHaveBeenCalledTimes(1)
	})

	// Dev bound the opening task to the Profile its stable ID resolved, so a
	// Profile renamed while the task was closed resumes under its new name.
	it("binds the opening task to the Profile its stable ID resolves, but never to a session fallback", () => {
		resolutions.cached.mockReturnValue(valid(profile("renamed")))
		createOwner()
		expect(adoptedIdentities).toHaveBeenCalledExactlyOnceWith("act", "renamed-id", "renamed")

		adoptedIdentities.mockClear()
		resolutions.cached.mockReturnValue({ ...valid(profile("fallback")), usedFallback: true })
		createOwner()
		resolutions.cached.mockReturnValue(invalid(AZURE_ERROR))
		createOwner()
		expect(adoptedIdentities).not.toHaveBeenCalled()
	})

	it("serves the task through the Profile its binding resolves to", () => {
		const owner = createOwner()

		expect(built.map((entry) => entry.profile.name)).toEqual(["source"])
		expect(owner.current()).toBe(built[0]?.handler)
	})

	// Dev kept a task with an unusable Profile readable and refused its next
	// request before any provider saw it, naming what the user has to fix.
	it("refuses every request of a Profile that cannot serve it, without building a provider", async () => {
		resolutions.cached.mockReturnValue(invalid(AZURE_ERROR))

		const owner = createOwner()
		const failure = await firstRequestFailure(owner.current())

		expect(built).toEqual([])
		expect(failure).toBeInstanceOf(ProfileNotValidError)
		expect((failure as Error).message).toBe(AZURE_ERROR)
	})

	// Dev checked the Profile's credentials before every request, so a missing
	// secret fails before any provider is built for it.
	it("refuses requests when a credential-checked rebuild finds the Profile's secret unavailable", async () => {
		const owner = createOwner()
		built.length = 0

		const next = await owner.rebuild({ validateCredentials: true })
		const failure = await firstRequestFailure(next)

		expect(built).toEqual([])
		expect(failure).toBeInstanceOf(ProfileNotValidError)
	})

	it("admits requests again once a rebuild reads the fixed Profile from the latest Catalog", async () => {
		resolutions.cached.mockReturnValue(invalid(AZURE_ERROR))
		const owner = createOwner()

		const next = await owner.rebuild()

		expect(resolutions.fresh).toHaveBeenCalledTimes(1)
		expect(next).toBe(built[0]?.handler)
		expect(owner.current()).toBe(next)
	})

	it("lets the last requested rebuild win even when an earlier Catalog read finishes later", async () => {
		const owner = createOwner()
		let releaseFirst: (value: ApiProfileRecoveryResult) => void = () => {}
		resolutions.fresh
			.mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)))
			.mockResolvedValueOnce(valid(profile("target")))

		const first = owner.rebuild()
		const second = owner.rebuild()
		await vi.waitFor(() => expect(resolutions.fresh).toHaveBeenCalledTimes(1))
		releaseFirst(valid(profile("stale")))
		await Promise.all([first, second])

		expect(built.map((entry) => entry.profile.name)).toEqual(["source", "stale", "target"])
		expect(owner.current()).toBe(built[2]?.handler)
	})

	it("tells observers about the handler that now serves the task", async () => {
		const owner = createOwner()
		const observed: ApiHandler[] = []
		owner.onRebuilt((handler) => observed.push(handler))

		const next = await owner.rebuild({ abortPrevious: true })

		expect(observed).toEqual([next])
		expect(owner.current()).toBe(next)
		expect(built[0]?.handler.abort).toHaveBeenCalledTimes(1)
	})

	it("keeps the switch when an observer fails", async () => {
		const owner = createOwner()
		const later = vi.fn()
		owner.onRebuilt(() => {
			throw new Error("view gone")
		})
		owner.onRebuilt(later)

		const next = await owner.rebuild()

		expect(owner.current()).toBe(next)
		expect(later).toHaveBeenCalledWith(next)
	})

	it("stops informing an observer that unsubscribed", async () => {
		const owner = createOwner()
		const observer = vi.fn()
		const unsubscribe = owner.onRebuilt(observer)

		unsubscribe()
		await owner.rebuild()

		expect(observer).not.toHaveBeenCalled()
	})
})
