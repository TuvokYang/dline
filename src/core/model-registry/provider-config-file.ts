import * as path from "path"

const PROVIDER_FILE_STEMS: Record<string, string> = {
    "vercel-ai-gateway": "vercel",
}

/** Return the canonical JSON file name for one provider catalog. */
export function getProviderConfigFileName(providerId: string): string {
    return `${PROVIDER_FILE_STEMS[providerId] ?? providerId}.json`
}

/** Resolve a provider ID from either its canonical or legacy file stem. */
export function getProviderIdFromConfigFile(fileName: string): string {
    const fileStem = path.basename(fileName, ".json")
    return Object.entries(PROVIDER_FILE_STEMS).find(([, stem]) => stem === fileStem)?.[0] ?? fileStem
}

/** Return older file names that may still contain a provider catalog. */
export function getLegacyProviderConfigFileNames(providerId: string): string[] {
    const canonicalFileName = getProviderConfigFileName(providerId)
    const legacyFileName = `${providerId}.json`
    return legacyFileName === canonicalFileName ? [] : [legacyFileName]
}
