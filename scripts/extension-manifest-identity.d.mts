export const STABLE_PACKAGE_NAME: "dline"
export const INSIDERS_PACKAGE_NAME: "dline-insiders"

export interface DistributionContributionIdentity {
    packageName: string
    displayName: string
    preview: boolean
    contributionNamespace: string
    activityBarId: string
    sidebarViewId: string
    panelViewType: string
    diffUriScheme: string
    commentControllerId: string
    productIconId: string
    walkthroughId: string
    contextKeys: Record<string, string>
}

export function getDistributionIdentity(packageName: string): DistributionContributionIdentity

export function createDistributionManifest<T extends object>(sourceManifest: T, packageName: string, version: string): T
