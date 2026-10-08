import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe } from "vitest"
import { JsonlUnifyStoreBackend } from "../../jsonl/JsonlDatabase"
import { runUnifyStoreConformance } from "./unify-store-conformance"

describe("JsonlUnifyStore conformance", () => {
	let root: string

	beforeAll(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "dline-jsonl-unify-store-"))
	})

	afterAll(async () => {
		await rm(root, { recursive: true, force: true })
	})

	runUnifyStoreConformance({
		backend: new JsonlUnifyStoreBackend(),
		location: (testName) => path.join(root, testName),
	})
})
