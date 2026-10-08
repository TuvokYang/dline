export interface ReleaseVersion {
	major: number
	minor: number
	patch: number
}

export function parseReleaseVersion(version: string): ReleaseVersion
export function isPreReleaseMinor(minor: number): boolean
export function assertChannelVersion(channel: "production" | "pre-release", version: string): void
export function createInsidersVersion(packageVersion: string, nowMs?: number): string
