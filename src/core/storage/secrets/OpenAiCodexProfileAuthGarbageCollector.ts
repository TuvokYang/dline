import fs from "node:fs/promises"
import path from "node:path"
import { FileLock } from "../backend/jsonl/FileLock"
import {
    getLegacyHashedOpenAiCodexProfileAuthFileName,
    getOpenAiCodexProfileAuthFileName,
    isOpenAiCodexProfileAuthFileName,
} from "./OpenAiCodexProfileAuthPath"
import { OpenAiCodexProfileAuthRepository } from "./OpenAiCodexProfileAuthRepository"

export interface OAuthProfileCatalogEntry {
    id: string
    provider: string
    name?: string
    modelId?: string
}

export interface OpenAiCodexProfileAuthGarbageCollectorOptions {
    secretsDir: string
}

export interface OpenAiCodexProfileAuthGarbageCollectionResult {
    deletedFileNames: string[]
}

export class OpenAiCodexProfileAuthGarbageCollector {
    private readonly lock = new FileLock()
    private readonly repository: OpenAiCodexProfileAuthRepository

    constructor(private readonly options: OpenAiCodexProfileAuthGarbageCollectorOptions) {
        this.repository = new OpenAiCodexProfileAuthRepository({ secretsDir: options.secretsDir })
    }

    async collect(profiles: readonly OAuthProfileCatalogEntry[]): Promise<OpenAiCodexProfileAuthGarbageCollectionResult> {
        const codexProfiles = profiles.filter((profile) => profile.provider === "openai-codex" && profile.id.length > 0)
        const retainedFileNames = new Set(codexProfiles.map((profile) => getOpenAiCodexProfileAuthFileName(profile.id)))
        for (const profile of codexProfiles) {
            const result = await this.repository.read(profile.id)
            if (result.status === "malformed") {
                retainedFileNames.add(getLegacyHashedOpenAiCodexProfileAuthFileName(profile.id))
            }
        }
        let fileNames: string[]
        try {
            fileNames = await fs.readdir(this.options.secretsDir)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { deletedFileNames: [] }
            throw error
        }

        const deletedFileNames: string[] = []
        for (const fileName of fileNames) {
            if (!isOpenAiCodexProfileAuthFileName(fileName) || retainedFileNames.has(fileName)) continue
            const filePath = path.join(this.options.secretsDir, fileName)
            await this.lock.withLock(filePath, async () => {
                await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
                    if (error.code !== "ENOENT") throw error
                })
            })
            deletedFileNames.push(fileName)
        }
        return { deletedFileNames }
    }
}
