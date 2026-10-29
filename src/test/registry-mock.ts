// Mock for @/registry used in unit tests.
// StateManager.initialize calls HostRegistryInfo.init during test setup.
// The tsconfig.unit-test.json paths redirect @/registry → this file.

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = async () => {}

export const HostRegistryInfo = {
    init: noop,
    get: () => ({ platform: "test", version: "0.0.0", remoteName: null }),
}

export const ExtensionRegistryInfo = { version: "0.0.0-test" }
