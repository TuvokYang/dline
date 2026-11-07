export const STABLE_PACKAGE_NAME: "dline"
export const INSIDERS_PACKAGE_NAME: "dline-insiders"
export const VSCODE_MARKETPLACE_PACKAGE_NAME: "dline-main"
export const VSCODE_MARKETPLACE_REGISTRY: "vscode-marketplace"
export const VSCODE_MARKETPLACE_PUBLISHER: "tuvokyangdline"

export interface TargetIdentity {
    packageName: string
    publisher: string
}

export function resolveTargetIdentity(
    channel: string,
    registry: string | null,
    sourceName: string,
    sourcePublisher: string,
    publisherOverride?: string | null,
): TargetIdentity

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

export function createDistributionManifest<T extends object>(
    sourceManifest: T,
    packageName: string,
    version: string,
    publisher?: string,
): T
