import type { Controller } from "@core/controller"
import type { ApiProfile } from "@shared/proto/dline/profile"

const baselines = new WeakMap<Controller, ApiProfile[]>()
let revision = 0

function cloneProfiles(profiles: readonly ApiProfile[]): ApiProfile[] {
    return profiles.map((profile) => structuredClone(profile))
}

/** Record the Catalog snapshot last returned to one Controller's Webview. */
export function recordProfileCatalogBaseline(controller: Controller, profiles: readonly ApiProfile[]): void {
    baselines.set(controller, cloneProfiles(profiles))
}

/** Return the last Catalog observed by one Controller, when one has been recorded. */
export function getProfileCatalogBaseline(controller: Controller): ApiProfile[] | undefined {
    const baseline = baselines.get(controller)
    return baseline ? cloneProfiles(baseline) : undefined
}

/** Advance and return the process-local Catalog commit revision. */
export function advanceProfileCatalogRevision(): number {
    revision += 1
    return revision
}

/** Return the latest process-local Catalog commit revision. */
export function getProfileCatalogRevision(): number {
    return revision
}
