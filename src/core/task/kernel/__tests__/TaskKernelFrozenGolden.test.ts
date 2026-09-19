import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const GOLDEN_PATH = path.resolve(__dirname, "../__fixtures__/task-runtime-v21-legacy-golden.json")
const FROZEN_SHA256 = "4ec9231c393a0930b7a3c1fe82d358cf36f30a9c674d1a245865a8cb615f2c50"

describe("TASK-103 frozen legacy golden", () => {
	it("keeps the canonical scenario archive immutable", () => {
		const parsed = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as { schema: string; scenarios: unknown[] }
		const digest = createHash("sha256").update(JSON.stringify(parsed)).digest("hex")
		expect(parsed.schema).toBe("dline.task-runtime.legacy-golden/v1")
		expect(parsed.scenarios).toHaveLength(10)
		expect(digest).toBe(FROZEN_SHA256)
	})
})
