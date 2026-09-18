import { EmptyRequest } from "@shared/proto/dline/common"
import { ApiProfile, ApiProfilesResponse, UpdateApiProfilesRequest } from "@shared/proto/dline/profile"
import { PlanActMode, ProfileSwitchRequest, ProfileSwitchStatus } from "@shared/proto/dline/state"
import { PROVIDER_OPTIONS } from "@shared/providers/providers"
import deepEqual from "fast-deep-equal"
import { useCallback, useContext, useEffect, useMemo, useState } from "react"
import { ExtensionStateContext } from "../../../context/ExtensionStateContext"
import { FileServiceClient, StateServiceClient } from "../../../services/grpc-client"
import { createEmptyApiProfile, generateApiProfileName } from "./ProviderProfile"

export interface ProfileUpdateResult {
	profiles: ApiProfile[]
	changed: boolean
}

type ProfileMode = "plan" | "act"

let sharedProfiles: ApiProfile[] = []
let sharedExpandedId: string | null = null
let sharedLoaded = false
let sharedLoadError: Error | undefined
let sharedLoadPromise: Promise<ApiProfile[]> | undefined
let sharedCatalogRevision = -1
/** Revision whose load failed, so a later attempt is never suppressed as "already tried". */
let sharedFailedCatalogRevision: number | undefined
/** Bounded backoff so a transient Catalog RPC failure never strands the selector. */
const CATALOG_LOAD_RETRY_DELAYS_MS = [500, 1_500, 4_000] as const
let sharedPersistQueue: Promise<void> = Promise.resolve()
let sharedSelectionQueue: Promise<void> = Promise.resolve()
/**
 * Counts local Catalog writes. A Catalog read answers with the backend state as
 * of the moment it ran, so a write committed while that read is in flight is
 * missing from its response. Comparing this counter across the read separates a
 * current response from one that would revert that write.
 */
let sharedLocalWriteGeneration = 0
/** Latest local write generation whose RPC has either committed or failed. */
let sharedSettledWriteGeneration = 0
/** A rejected stale read or failed write requires one fresh read after local writes settle. */
let sharedNeedsPostWriteReload = false
const profileListeners = new Set<() => void>()

/** Reject Catalog reads that could predate an optimistic local write or its settlement. */
export function shouldAdoptProfileLoad(
	requestLocalGeneration: number,
	requestSettledGeneration: number,
	currentLocalGeneration: number,
	currentSettledGeneration: number,
): boolean {
	return (
		requestLocalGeneration === currentLocalGeneration &&
		requestSettledGeneration === currentSettledGeneration &&
		currentLocalGeneration === currentSettledGeneration
	)
}

function notifyProfileListeners(): void {
	for (const listener of profileListeners) listener()
}

function replaceSharedProfiles(profiles: ApiProfile[]): void {
	sharedProfiles = profiles
	notifyProfileListeners()
}

function setSharedExpandedId(update: string | null | ((current: string | null) => string | null)): void {
	sharedExpandedId = typeof update === "function" ? update(sharedExpandedId) : update
	notifyProfileListeners()
}

function loadSharedProfiles(catalogRevision?: number, force = false): Promise<ApiProfile[]> {
	if (sharedLoadPromise) {
		return sharedLoadPromise.then(
			() =>
				force || (catalogRevision !== undefined && sharedCatalogRevision !== catalogRevision)
					? loadSharedProfiles(catalogRevision, true)
					: sharedProfiles,
			// The in-flight request failed. Do not inherit that rejection: this caller
			// still needs a Catalog, so start a fresh attempt instead of leaving every
			// consumer stuck on "Loading profiles…".
			() => loadSharedProfiles(catalogRevision, true),
		)
	}
	const alreadyFailedForRevision = sharedFailedCatalogRevision !== undefined && sharedFailedCatalogRevision === catalogRevision
	if (
		sharedLoaded &&
		!force &&
		!alreadyFailedForRevision &&
		(catalogRevision === undefined || sharedCatalogRevision === catalogRevision)
	) {
		return Promise.resolve(sharedProfiles)
	}

	const writeGenerationAtRequest = sharedLocalWriteGeneration
	const settledGenerationAtRequest = sharedSettledWriteGeneration
	const request = FileServiceClient.getApiProfiles({} as EmptyRequest)
		.then((response: ApiProfilesResponse) => {
			sharedLoaded = true
			if (catalogRevision !== undefined) sharedCatalogRevision = catalogRevision
			sharedFailedCatalogRevision = undefined
			sharedLoadError = undefined
			// Committing a Catalog write advances the backend revision, which asks
			// this Webview to read the Catalog again. When an edit lands between the
			// read leaving and its response arriving, that response predates the edit
			// and adopting it would silently undo it. The edit is already queued for
			// the backend, so local state stays authoritative until a later read.
			if (
				shouldAdoptProfileLoad(
					writeGenerationAtRequest,
					settledGenerationAtRequest,
					sharedLocalWriteGeneration,
					sharedSettledWriteGeneration,
				)
			) {
				sharedProfiles = response.profiles || []
			} else {
				sharedNeedsPostWriteReload = true
			}
			notifyProfileListeners()
			return sharedProfiles
		})
		.catch((error: unknown) => {
			sharedLoaded = false
			// Remember which revision failed so the next revision is always retried.
			sharedFailedCatalogRevision = catalogRevision
			sharedLoadError = error instanceof Error ? error : new Error(String(error))
			notifyProfileListeners()
			throw sharedLoadError
		})
		.finally(() => {
			if (sharedLoadPromise === request) sharedLoadPromise = undefined
		})

	sharedLoadPromise = request
	return request
}

function persistSharedProfiles(profiles: ApiProfile[], clearApiKeyProfileIds: readonly string[], writeGeneration: number): void {
	const settle = (): void => {
		sharedSettledWriteGeneration = Math.max(sharedSettledWriteGeneration, writeGeneration)
		if (sharedSettledWriteGeneration === sharedLocalWriteGeneration && sharedNeedsPostWriteReload) {
			sharedNeedsPostWriteReload = false
			void loadSharedProfiles(undefined, true).catch(() => undefined)
		}
	}
	sharedPersistQueue = sharedPersistQueue
		.catch(() => undefined)
		.then(async () => {
			await FileServiceClient.updateApiProfiles(
				UpdateApiProfilesRequest.create({ profiles, clearApiKeyProfileIds: [...clearApiKeyProfileIds] }),
			)
			settle()
		})
		.catch((error: unknown) => {
			sharedNeedsPostWriteReload = true
			settle()
			sharedLoadError = error instanceof Error ? error : new Error(String(error))
			notifyProfileListeners()
		})
}

export function reorderProfilesById(profiles: ApiProfile[], activeId: string, overId: string): ApiProfile[] {
	if (activeId === overId) return profiles
	const activeIndex = profiles.findIndex((profile) => profile.id === activeId)
	const overIndex = profiles.findIndex((profile) => profile.id === overId)
	if (activeIndex < 0 || overIndex < 0) return profiles
	const reordered = [...profiles]
	const [activeProfile] = reordered.splice(activeIndex, 1)
	reordered.splice(overIndex, 0, activeProfile)
	return reordered
}

export function applyProfileUpdate(prev: ApiProfile[], id: string, updates: Partial<ApiProfile>): ProfileUpdateResult {
	let changed = false
	const next = prev.map((profile) => {
		if (profile.id !== id) return profile
		const updated = { ...profile, ...updates }
		const isExplicitNameUpdate = "name" in updates
		const isAutoGenerated =
			!updated.name ||
			updated.name === "New Model" ||
			(!isExplicitNameUpdate && updated.provider && updated.name.startsWith(`${updated.provider}:`))
		if (updated.provider && isAutoGenerated) {
			const otherNames = prev.filter((item) => item.id !== id).map((item) => item.name)
			updated.name = generateApiProfileName(updated.provider, updated.modelId || "", otherNames)
		}
		if (deepEqual(updated, profile)) return profile
		changed = true
		return updated
	})

	return { profiles: changed ? next : prev, changed }
}

type ProfileSettings = {
	planModeProfileId?: string
	planModeProfile?: string
	actModeProfileId?: string
	actModeProfile?: string
}

export function buildProfileSettings(profileId: string, profileName: string, modes: ProfileMode[]): ProfileSettings {
	return modes.reduce<ProfileSettings>((settings, mode) => {
		if (mode === "plan") {
			settings.planModeProfileId = profileId
			settings.planModeProfile = profileName
		} else {
			settings.actModeProfileId = profileId
			settings.actModeProfile = profileName
		}
		return settings
	}, {})
}

export function shouldUseTaskProfileSettings(taskId: string | undefined, hasActiveTask: boolean): boolean {
	return Boolean(taskId) || hasActiveTask
}

/**
 * Shared ApiProfile store. All hook consumers use one initial RPC and one
 * optimistic profile snapshot, avoiding stale per-component copies.
 */
export function useApiProfiles() {
	const [, forceRender] = useState(0)
	const [editMode, setEditMode] = useState(false)
	const extensionState = useContext(ExtensionStateContext)
	const profileCatalogRevision = extensionState?.profileCatalogRevision ?? 0

	useEffect(() => {
		const listener = () => forceRender((value) => value + 1)
		profileListeners.add(listener)
		return () => {
			profileListeners.delete(listener)
		}
	}, [])

	useEffect(() => {
		let cancelled = false
		let retryTimer: ReturnType<typeof setTimeout> | undefined

		// A failed Catalog load must never leave the selector on "Loading profiles…".
		// Retry with bounded backoff so a transient RPC failure self-heals.
		const attemptLoad = (attempt: number): void => {
			void loadSharedProfiles(profileCatalogRevision).catch(() => {
				if (cancelled || attempt >= CATALOG_LOAD_RETRY_DELAYS_MS.length) return
				retryTimer = setTimeout(() => attemptLoad(attempt + 1), CATALOG_LOAD_RETRY_DELAYS_MS[attempt])
			})
		}
		attemptLoad(0)

		return () => {
			cancelled = true
			if (retryTimer) clearTimeout(retryTimer)
		}
	}, [profileCatalogRevision])

	const persist = useCallback((profiles: ApiProfile[], clearApiKeyProfileIds: readonly string[] = []) => {
		if (!sharedLoaded) return
		const writeGeneration = ++sharedLocalWriteGeneration
		replaceSharedProfiles(profiles)
		persistSharedProfiles(profiles, clearApiKeyProfileIds, writeGeneration)
	}, [])

	const addProfile = useCallback((): string | undefined => {
		if (!sharedLoaded) return undefined
		const newProfile = createEmptyApiProfile()
		newProfile.name = "New Model"
		persist([...sharedProfiles, newProfile])
		setSharedExpandedId(newProfile.id)
		return newProfile.id
	}, [persist])

	const updateProfile = useCallback(
		(id: string, updates: Partial<ApiProfile>) => {
			const result = applyProfileUpdate(sharedProfiles, id, updates)
			if (result.changed) {
				const clearApiKeyProfileIds = "apiKey" in updates && updates.apiKey === "" ? [id] : []
				persist(result.profiles, clearApiKeyProfileIds)
			}
		},
		[persist],
	)

	const reorderProfiles = useCallback(
		(activeId: string, overId: string) => {
			const reordered = reorderProfilesById(sharedProfiles, activeId, overId)
			if (reordered !== sharedProfiles) persist(reordered)
		},
		[persist],
	)

	const removeProfile = useCallback(
		(id: string) => {
			persist(sharedProfiles.filter((profile) => profile.id !== id))
			setSharedExpandedId((current) => (current === id ? null : current))
		},
		[persist],
	)

	const toggleEnabled = useCallback(
		(id: string) => {
			persist(sharedProfiles.map((profile) => (profile.id === id ? { ...profile, enabled: !profile.enabled } : profile)))
		},
		[persist],
	)

	const selectProfiles = useCallback((id: string, modes: ProfileMode[], _taskId?: string, _hasActiveTask = false) => {
		const profile = sharedProfiles.find((item) => item.id === id)
		if (!profile) return Promise.resolve()
		sharedSelectionQueue = sharedSelectionQueue
			.catch(() => undefined)
			.then(async () => {
				const response = await StateServiceClient.requestProfileSwitch(
					ProfileSwitchRequest.create({
						targetProfile: profile.id,
						targetModes: modes.map((mode) => (mode === "plan" ? PlanActMode.PLAN : PlanActMode.ACT)),
					}),
				)
				if (response.status === ProfileSwitchStatus.PROFILE_SWITCH_STATUS_REJECTED) {
					throw new Error(response.error || `Profile not valid: "${profile.name}" could not be selected.`)
				}
			})
		return sharedSelectionQueue
	}, [])

	const selectProfile = useCallback(
		(id: string, mode: ProfileMode, taskId?: string, hasActiveTask = false) =>
			selectProfiles(id, [mode], taskId, hasActiveTask),
		[selectProfiles],
	)

	const toggleUsedFor = useCallback(
		(id: string, mode: string) => {
			const profiles = sharedProfiles.map((profile) => {
				if (profile.id !== id) return profile
				const usedFor = profile.usedFor.includes(mode)
					? profile.usedFor.filter((item) => item !== mode)
					: [...profile.usedFor, mode]
				return { ...profile, usedFor }
			})
			persist(profiles)
		},
		[persist],
	)

	const toggleExpand = useCallback((id: string) => {
		setSharedExpandedId((current) => (current === id ? null : id))
	}, [])

	const providerOptions = useMemo(() => PROVIDER_OPTIONS, [])

	return {
		profiles: sharedProfiles,
		expandedId: sharedExpandedId,
		setExpandedId: setSharedExpandedId,
		editMode,
		setEditMode,
		addProfile,
		updateProfile,
		reorderProfiles,
		removeProfile,
		toggleEnabled,
		toggleUsedFor,
		toggleExpand,
		selectProfile,
		selectProfiles,
		providerOptions,
		loaded: sharedLoaded,
		error: sharedLoadError,
		reloadProfiles: () => loadSharedProfiles(profileCatalogRevision, true),
	}
}
