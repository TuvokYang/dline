import { describe } from "vitest"
import { MemoryUnifyStoreBackend } from "../fixtures/MemoryUnifyStore"
import { runUnifyStoreConformance } from "./unify-store-conformance"

describe("MemoryUnifyStore conformance", () => {
    runUnifyStoreConformance({
        backend: new MemoryUnifyStoreBackend(),
        location: (testName) => testName,
    })
})
