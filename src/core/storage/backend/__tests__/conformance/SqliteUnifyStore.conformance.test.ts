import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe } from "vitest"
import { SqliteUnifyStoreBackend } from "../../sqlite/SqliteUnifyStore"
import { runUnifyStoreConformance } from "./unify-store-conformance"

describe("SqliteUnifyStore conformance", () => {
    let root: string

    beforeAll(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), "dline-sqlite-unify-store-"))
    })

    afterAll(async () => {
        await rm(root, { recursive: true, force: true })
    })

    runUnifyStoreConformance({
        backend: new SqliteUnifyStoreBackend(),
        location: (testName) => path.join(root, `${testName}.db`),
    })
})
