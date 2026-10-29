/**
 * WandbStore — persistent storage for Weights & Biases API key.
 *
 * Backed by data/secrets/wandb.json (0o600 permissions).
 */
import path from "node:path"
import { ClineFileStorage } from "@shared/storage/ClineFileStorage"
import { getDlineDataDir } from "../disk"

const WANDB_FILE = "wandb.json"

let _store: ClineFileStorage<string> | null = null

function getStore(): ClineFileStorage<string> {
    if (!_store) {
        const dir = path.join(getDlineDataDir(), "secrets")
        _store = new ClineFileStorage<string>(path.join(dir, WANDB_FILE), "WandbStore", {
            fileMode: 0o600,
        })
    }
    return _store
}

/** Get W&B API key (formerly wandbApiKey in secrets.json). */
export function getWandbApiKey(): string | undefined {
    return getStore().get("apiKey")
}

/** Set W&B API key. */
export function setWandbApiKey(value: string): void {
    getStore().set("apiKey", value)
}

/** Reset singleton (testing only). */
export function resetWandbStore(): void {
    _store = null
}
